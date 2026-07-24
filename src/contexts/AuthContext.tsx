// @refresh reset
// AuthContext.tsx exports both a component (AuthProvider) and a plain function
// (getProfile), which makes it an invalid Fast Refresh boundary. Without this
// directive, HMR does a partial hot-swap that nulls out ReactCurrentDispatcher
// before AuthProvider re-renders, causing every useState/useEffect call to throw
// "Cannot read properties of null". The directive forces a full module reset on
// any change, keeping the dispatcher intact.
import { useContext, useEffect, useState, type ReactNode } from 'react';
import { supabase } from '@/db/supabase';
import type { User } from '@supabase/supabase-js';
import type { Profile } from '@/types/types';
import { toast } from 'sonner';
import { unlockSession, lockSession, restoreSessionInfo, rebuildSession } from '@/lib/session';
import {
  clearAllData, restoreVaultKey, reEncryptVaultWithNewPassword,
  storeMnemonic, deleteMnemonic, getMnemonic,
  getStoredSaltBase64, getEncryptedIdentityKeyBlob,
  storeKdfVersion, getStoredSalt, storeStoredSalt,
  getIdentityKeyPair, restoreVaultFromBackup,
} from '@/lib/localStore';
import { computeFingerprint } from '@/lib/crypto';
import { generateMnemonic, generateMnemonicHash, migrateMnemonicHashIfNeeded } from '@/lib/mnemonic';
import { AuthContext, type SessionInfo } from '@/contexts/AuthContext.types';

export async function getProfile(userId: string): Promise<Profile | null> {
  // Retry up to 4 times with exponential backoff to survive transient 404/503
  // responses from Supabase free-tier projects waking up after auto-pause.
  const delays = [0, 500, 1500, 3000];
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt] > 0) await new Promise(r => setTimeout(r, delays[attempt]));
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .maybeSingle();
    if (!error) return data;
    const isTransient = error.code === 'PGRST301' ||
      (error.message ?? '').includes('404') ||
      (error.message ?? '').includes('503') ||
      (error.message ?? '').toLowerCase().includes('timeout');
    if (!isTransient || attempt === delays.length - 1) {
      console.error('Failed to fetch profile:', error);
      return null;
    }
    console.warn(`[SylvaCrypt] getProfile transient error (attempt ${attempt + 1}):`, error.message);
  }
  return null;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [loading, setLoading] = useState(true);

  // ── Idle-timeout auto-lock removed ────────────────────────────────────────

  const refreshProfile = async () => {
    if (!user) { setProfile(null); return; }
    const profileData = await getProfile(user.id);
    setProfile(profileData);
  };

  useEffect(() => {
    // vaultReadyRef is set to true once getSession().then() has successfully
    // restored the vault key and session.  It guards the TOKEN_REFRESHED handler
    // below: if TOKEN_REFRESHED fires before vault restore completes, calling
    // setUser would make the app see "user set, session null, loading false" and
    // trigger a spurious redirect to the login page.
    const vaultReadyRef = { current: false };

    supabase.auth.getSession()
      .then(async ({ data: { session: authSession } }: any) => {
        setUser(authSession?.user ?? null);
        if (authSession?.user) {
          getProfile(authSession.user.id).then(setProfile);
          const vaultOk = await restoreVaultKey();
          const restoredSession = await restoreSessionInfo();
          if (vaultOk && restoredSession) {
            vaultReadyRef.current = true;
            setSession(restoredSession);

            // Background sync: ensure the public key (and vault backup) are
            // written to the profile. This self-heals accounts where the
            // signup write failed and the user hasn't explicitly logged in again.
            // Fire-and-forget — does not block the UI.
            (async () => {
              try {
                const profileData = await getProfile(authSession.user.id);
                // If the profile fetch failed (transient network/JWT error) we
                // cannot compare keys, so skip — prevents the update loop from
                // running when it isn't needed and causing 404 floods.
                if (!profileData) return;

                const needsKeySync = restoredSession.publicKeyBase64 &&
                  restoredSession.publicKeyBase64 !== profileData.public_key;
                if (!needsKeySync) return;

                const [saltB64, keyBlob] = await Promise.all([
                  getStoredSaltBase64(),
                  getEncryptedIdentityKeyBlob(),
                ]);
                const updates: Record<string, string | null> = {
                  public_key: restoredSession.publicKeyBase64,
                };
                if (saltB64) updates.vault_salt = saltB64;
                if (keyBlob) updates.encrypted_private_key = keyBlob;

                // Refresh the auth session to guarantee a non-expired JWT
                // before the PATCH — a stale token causes auth.uid() to return
                // NULL inside RLS, making the update silently match 0 rows.
                await supabase.auth.refreshSession().catch(() => {});
                // Retry with backoff: PostgREST 12 returns 404 on the first PATCH
                // if the REST API is still warming up after a free-tier wake cycle.
                for (const delay of [0, 2000, 5000]) {
                  if (delay) await new Promise(r => setTimeout(r, delay));
                  const { error: bsErr } = await supabase
                    .from('profiles')
                    .update(updates)
                    .eq('id', authSession.user.id);
                  if (!bsErr) break;
                  console.warn('[SylvaCrypt] Background sync PATCH retry (delay', delay, 'ms):', bsErr.message);
                }
              } catch {
                // Non-critical — will retry on next page load
              }
            })();
          } else if (vaultOk && !restoredSession) {
            // ── Fallback: vault key is in memory but session info is gone ──────
            // This happens when sc_session_info was cleared but the IDB key persisted.
            // Rebuild the session from the identity key pair so the user doesn't
            // have to re-enter their password.
            try {
              let kp = await getIdentityKeyPair();

              // If the local keypair blob is missing despite vault key being present
              // (e.g. partial IDB corruption), try to restore from the Supabase backup.
              if (!kp) {
                const profileData = await getProfile(authSession.user.id);
                if (profileData?.vault_salt && profileData.encrypted_private_key) {
                  await restoreVaultFromBackup(
                    profileData.vault_salt,
                    profileData.encrypted_private_key,
                    profileData.kdf_version ?? 0,
                  );
                  kp = await getIdentityKeyPair();
                }
              }

              if (kp) {
                const fingerprint = await computeFingerprint(kp.publicKeyBase64);
                const profileData = await getProfile(authSession.user.id);
                if (profileData) {
                  const rebuilt = rebuildSession(
                    authSession.user.id,
                    profileData.username,
                    kp.publicKeyBase64,
                    fingerprint,
                  );
                  vaultReadyRef.current = true;
                  setSession(rebuilt);
                }
              }
            } catch (e) {
              console.warn('[SylvaCrypt] Fallback session rebuild failed:', e);
              // Non-fatal — user will need to re-enter password
            }
          }
        }
        // ── setLoading(false) MUST fire here, inside .then(), after all vault
        // restore paths have completed.  The old .finally() pattern fired
        // setLoading(false) immediately when getSession() resolved, BEFORE the
        // awaited restoreVaultKey() / restoreSessionInfo() / rebuildSession()
        // calls finished.  That produced a window where React rendered with
        // user≠null + session=null + loading=false, which routing interpreted
        // as "authenticated but no vault" and redirected to the login page —
        // breaking "Keep Me Signed In" on every page refresh.
        setLoading(false);
      })
      .catch((error: any) => {
        toast.error(`Session error: ${error.message}`);
        setLoading(false); // must also set loading=false on error so UI unblocks
      });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event: any, authSession: any) => {
      if (event === 'TOKEN_REFRESHED') {
        // Token was silently refreshed — update the User reference so downstream
        // hooks always have the freshest object, but do NOT touch session or profile.
        //
        // Guard: only update the user once the vault is confirmed ready.
        // TOKEN_REFRESHED can fire before getSession().then() finishes restoring
        // the vault — calling setUser here in that window makes the app briefly
        // see "user set + session null + loading false" which triggers a spurious
        // redirect to the login page, breaking "Keep Me Signed In".
        if (authSession?.user && vaultReadyRef.current) setUser(authSession.user);
        return;
      }

      setUser(authSession?.user ?? null);
      if (authSession?.user) {
        getProfile(authSession.user.id).then(setProfile);
      } else if (event === 'SIGNED_OUT') {
        // Only wipe the in-memory session on an *explicit* sign-out.
        // Other null-authSession events (INITIAL_SESSION with an expired/refreshing
        // token, transient network blips) must NOT clear the session — doing so
        // races with getSession().then() vault restore and leaves the user stuck on
        // the login page even though their refresh token and vault key are valid.
        setProfile(null);
        setSession(null);
      }
    });

    return () => { subscription.unsubscribe(); };
  }, []);

  const checkUsernameAvailable = async (username: string): Promise<boolean> => {
    // Profiles are always stored lowercase (Supabase normalises emails before the
    // DB trigger runs split_part), so we must query with a lowercased value too.
    const { data } = await supabase
      .from('profiles')
      .select('id')
      .eq('username', username.toLowerCase())
      .maybeSingle();
    return !data;
  };

  async function checkPasswordBreach(password: string): Promise<{ breached: boolean; count: number; failed?: boolean }> {
    const hashBuf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(password));
    const hashHex = Array.from(new Uint8Array(hashBuf))
      .map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    const prefix = hashHex.slice(0, 5);
    const suffix = hashHex.slice(5);

    const { data, error } = await supabase.functions.invoke('check-password-breach', {
      method: 'POST',
      body: { prefix },
    });
    if (error || (data?.error && !data?.text)) {
      // Fail open if the Edge Function is unreachable or the breach service is down;
      // do not block account creation because of a transient infrastructure issue.
      return { breached: false, count: 0, failed: true };
    }

    let count = 0;
    for (const line of (data.text || '').split('\r\n')) {
      const [candidate, c] = line.split(':');
      if (candidate && candidate.toUpperCase() === suffix) {
        count = parseInt(c, 10) || 0;
        break;
      }
    }

    return { breached: count > 0, count };
  }

  const signUpWithUsername = async (username: string, password: string) => {
    try {
      // Server-side breach check before any account creation.
      const breach = await checkPasswordBreach(password);
      if (breach.breached) {
        throw new Error(`This password has appeared in ${breach.count.toLocaleString()} known data breaches. Please choose a different password.`);
      }
      // Normalise to lowercase so the Supabase email "user@sylvacrypt.com" and
      // the profiles.username set by the DB trigger always match.
      const normalised = username.toLowerCase();
      const email = `${normalised}@sylvacrypt.com`;
      const { data, error } = await supabase.auth.signUp({ email, password });
      if (error) throw error;
      if (data.user) {
        // New accounts always use Argon2id (v1) for maximum brute-force resistance
        await storeKdfVersion(1);
        const sessionInfo = await unlockSession(data.user.id, normalised, password, null, null, 1);
        // Back up vault salt + encrypted key pair to Supabase so the user can recover
        // their identity on any device or after clearing browser data
        const [saltB64, keyBlob] = await Promise.all([
          getStoredSaltBase64(),
          getEncryptedIdentityKeyBlob(),
        ]);

        // The DB trigger that creates the profiles row fires asynchronously after
        // signUp. We split the wait into two explicit phases so we never waste
        // update attempts on a row that doesn't exist yet:
        //
        // Phase 1 — wait for the trigger to INSERT the profiles row (up to 10 s).
        // Phase 2 — once the row exists, UPDATE it with vault keys + public key.
        //           A row that exists will almost always accept the update on the
        //           first try; we still retry a few times for transient failures.
        const profilePayload = {
          public_key: sessionInfo.publicKeyBase64,
          password_version: 1,
          kdf_version: 1,
          ...(saltB64 && { vault_salt: saltB64 }),
          ...(keyBlob && { encrypted_private_key: keyBlob }),
        };

        // Phase 1: poll until the trigger-created row is visible (max 20 × 500 ms = 10 s)
        let rowExists = false;
        for (let i = 0; i < 20 && !rowExists; i++) {
          if (i > 0) await new Promise(r => setTimeout(r, 500));
          const { data: check } = await supabase
            .from('profiles')
            .select('id')
            .eq('id', data.user.id)
            .maybeSingle();
          if (check?.id) rowExists = true;
        }

        // Phase 2: update the confirmed-existing row (max 5 × 300 ms = 1.5 s)
        let profileUpdateOk = false;
        if (rowExists) {
          for (let attempt = 0; attempt < 5 && !profileUpdateOk; attempt++) {
            if (attempt > 0) await new Promise(r => setTimeout(r, 300));
            const { error: upErr, data: upData } = await supabase
              .from('profiles')
              .update(profilePayload)
              .eq('id', data.user.id)
              .select('id');
            if (!upErr && upData && upData.length > 0) profileUpdateOk = true;
          }
        }

        if (!profileUpdateOk) {
          console.warn('[SylvaCrypt] Profile update did not confirm — vault keys may not be persisted. rowExists:', rowExists);
        }

        setSession(sessionInfo);
      }
      return { error: null };
    } catch (error) {
      return { error: error as Error };
    }
  };

  const signInWithUsername = async (username: string, password: string) => {
    // Phase 1 — Supabase auth (wrong credentials land here).
    // Errors from this phase are credential failures; the caller can show
    // "Invalid username or password." safely.
    const normalised = username.toLowerCase();
    
    let data: any = null;
    let authError: any = null;

    const email = `${normalised}@sylvacrypt.com`;
    const result = await supabase.auth.signInWithPassword({ email, password });
    
    if (!result.error) {
      data = result.data;
      authError = null;
    } else {
      authError = result.error;
    }

    if (authError) {
      // Only tag the error as a credential failure when Supabase explicitly
      // says the credentials are wrong (error code "invalid_credentials" or the
      // equivalent human-readable message).  Any other auth error — e.g.
      // "Email not confirmed" (happens when email verification is accidentally
      // enabled on a project that uses fake @sylvacrypt.com addresses),
      // rate-limit errors, network failures — must surface their real message so
      // the user and developers understand what actually went wrong instead of
      // getting a misleading "Invalid username or password." toast.
      const isCredentialError =
        authError.code === 'invalid_credentials' ||
        /invalid.*(login|credentials)/i.test(authError.message);
      const err = new Error(authError.message) as Error & { isCredentialError: boolean };
      err.isCredentialError = isCredentialError;
      return { error: err };
    }

    // Phase 2 — session setup (profile fetch, vault unlock, key sync).
    // Errors here are NOT credential failures — show the real message so the
    // user (and devs) understand what actually went wrong.
    try {
      if (data.user) {
        let profileData = await getProfile(data.user.id);

        // Self-heal: if handle_new_user() failed at registration time the profile
        // row will be missing even though auth succeeded.  Create it now so the
        // rest of the login flow (vault sync, public-key PATCH, etc.) can proceed
        // without hitting 404 errors on every subsequent request.
        if (!profileData) {
          const fallbackUsername = normalised; // email is normalised@sylvacrypt.com
          await supabase.from('profiles').insert({
            id: data.user.id,
            email: data.user.email ?? `${fallbackUsername}@sylvacrypt.com`,
            username: fallbackUsername,
            role: 'user',
            password_version: 1,
          }).then(null, () => {
            // INSERT may race with another tab or a trigger retry — tolerate the
            // duplicate-key error and continue; getProfile will succeed on retry.
          });
          profileData = await getProfile(data.user.id);
        }

        // If IndexedDB was wiped (no local salt) but we have a Supabase backup,
        // pre-seed the vault so unlockSession can decrypt the backed-up key pair.
        const localSalt = await getStoredSalt();
        if (!localSalt && profileData?.vault_salt) {
          const saltBytes = Uint8Array.from(atob(profileData.vault_salt), c => c.charCodeAt(0));
          await storeStoredSalt(saltBytes);
        }

        const kdfVersion = profileData?.kdf_version ?? 0;
        // Use the profile's stored username as the canonical value so the session
        // always reflects exactly what is in the DB, regardless of how the user
        // typed it at the login prompt.
        const canonicalUsername = profileData?.username ?? normalised;
        const sessionInfo = await unlockSession(
          data.user.id,
          canonicalUsername,
          password,
          profileData?.public_key ?? null,
          profileData?.encrypted_private_key ?? null,   // cloud backup for key restoration
          kdfVersion,
        );

        // Always sync vault backup + public key + KDF version to Supabase after a successful login
        const [saltB64, keyBlob] = await Promise.all([
          getStoredSaltBase64(),
          getEncryptedIdentityKeyBlob(),
        ]);
        const profileUpdates: Record<string, string | number | null> = {};
        if (sessionInfo.publicKeyBase64 !== profileData?.public_key)
          profileUpdates.public_key = sessionInfo.publicKeyBase64;
        if (saltB64) profileUpdates.vault_salt = saltB64;
        if (keyBlob) profileUpdates.encrypted_private_key = keyBlob;
        if ((profileData?.kdf_version ?? 0) !== kdfVersion)
          profileUpdates.kdf_version = kdfVersion;
        if (Object.keys(profileUpdates).length > 0) {
          // Fire-and-forget with exponential backoff — login proceeds immediately
          // while the profile sync retries in the background.  PostgREST 12 returns
          // 404 for a 0-row PATCH when the REST API wakes up before the RLS session
          // is valid; retrying heals the race without blocking the UI.
          (async () => {
            for (const delay of [0, 2000, 5000, 10000]) {
              if (delay) await new Promise(r => setTimeout(r, delay));
              const { error: pErr } = await supabase
                .from('profiles').update(profileUpdates).eq('id', data.user.id);
              if (!pErr) break;
              console.warn('[SylvaCrypt] Profile sync retry (delay', delay, 'ms):', pErr.message);
            }
          })();
        }

        // ── Proactive mnemonic restore + transparent legacy-hash migration ───
        // If IDB was wiped (e.g. user cleared browser data), the recovery phrase
        // is missing locally but may still be in the Supabase cloud backup.
        // getMnemonic() already tries IDB then the Supabase backup automatically
        // and heals IDB when it finds the cloud copy — so a single call here is
        // enough to silently self-heal the vault before the user ever clicks
        // "Reveal Recovery Phrase".  Fire-and-forget; failure is non-fatal.
        (async () => {
          const localMnemonic = await getMnemonic().catch(() => null);
          const storedHash = profileData?.mnemonic_hash;
          const storedSalt = profileData?.mnemonic_salt;
          const migratedFlag = localStorage.getItem('sc_mnemonic_argon2_migrated');
          if (localMnemonic && storedHash && storedSalt && migratedFlag !== '1') {
            const newHash = await migrateMnemonicHashIfNeeded(localMnemonic, storedSalt, storedHash);
            if (newHash && newHash !== storedHash) {
              const { error: migrateErr } = await supabase
                .from('profiles')
                .update({ mnemonic_hash: newHash })
                .eq('id', data.user.id);
              if (migrateErr) {
                console.warn('[SylvaCrypt] Mnemonic hash migration failed:', migrateErr.message);
              } else {
                localStorage.setItem('sc_mnemonic_argon2_migrated', '1');
              }
            } else {
              localStorage.setItem('sc_mnemonic_argon2_migrated', '1');
            }
          }
        })().catch(() => {});

        setSession(sessionInfo);
      }
      return { error: null };
    } catch (sessionError) {
      // Session setup failed AFTER a successful Supabase auth. The user IS
      // authenticated; we should NOT sign them out here — just surface the real
      // error message so it can be diagnosed and fixed.
      return { error: sessionError as Error };
    }
  };

  const updatePublicKey = async (publicKey: string) => {
    if (!user) return;
    await supabase.from('profiles').update({ public_key: publicKey }).eq('id', user.id);
  };

  const updateBio = async (bio: string, bioPrivate: boolean): Promise<{ error: Error | null }> => {
    try {
      if (!user) throw new Error('Not authenticated');
      const { error } = await supabase
        .from('profiles')
        .update({ bio: bio.trim() || null, bio_private: bioPrivate })
        .eq('id', user.id);
      if (error) throw error;
      await refreshProfile();
      return { error: null };
    } catch (error) {
      return { error: error as Error };
    }
  };

  const signOut = async () => {
    lockSession();
    await supabase.auth.signOut();
    setUser(null);
    setProfile(null);
    setSession(null);
  };

  /** Sign out from ALL devices (global Supabase sign-out). */
  const signOutAllDevices = async () => {
    lockSession();
    await supabase.auth.signOut({ scope: 'global' });
    setUser(null);
    setProfile(null);
    setSession(null);
  };

  /** Toggle username discovery opt-out. */
  const updateDiscoverable = async (value: boolean): Promise<{ error: Error | null }> => {
    try {
      if (!user) throw new Error('Not authenticated');
      const { error } = await supabase.from('profiles').update({ discoverable: value }).eq('id', user.id);
      if (error) throw error;
      await refreshProfile();
      return { error: null };
    } catch (error) {
      return { error: error as Error };
    }
  };

  const changeUsername = async (newUsername: string): Promise<{ error: Error | null; daysRemaining?: number }> => {
    try {
      if (!user) throw new Error('Not authenticated');
      const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;
      // Check cooldown
      if (profile?.username_last_changed) {
        const lastChanged = new Date(profile.username_last_changed).getTime();
        const elapsed = Date.now() - lastChanged;
        if (elapsed < FOURTEEN_DAYS_MS) {
          const daysRemaining = Math.ceil((FOURTEEN_DAYS_MS - elapsed) / (24 * 60 * 60 * 1000));
          return { error: new Error(`You can change your username again in ${daysRemaining} day${daysRemaining === 1 ? '' : 's'}.`), daysRemaining };
        }
      }
      // Check availability
      const trimmed = newUsername.trim().toLowerCase();
      if (!trimmed || trimmed.length < 3 || trimmed.length > 30) {
        throw new Error('Username must be 3–30 characters.');
      }
      if (!/^[a-z0-9_]+$/.test(trimmed)) {
        throw new Error('Username may only contain letters, numbers, and underscores.');
      }
      const { data: existing } = await supabase
        .from('profiles')
        .select('id')
        .eq('username', trimmed)
        .maybeSingle();
      if (existing) throw new Error('That username is already taken.');
      // Update email in auth (username@sylvacrypt.com format)
      const newEmail = `${trimmed}@sylvacrypt.com`;
      const { error: emailErr } = await supabase.auth.updateUser({ email: newEmail });
      if (emailErr) throw emailErr;
      // Update profile row
      const { error: profileErr } = await supabase
        .from('profiles')
        .update({ username: trimmed, username_last_changed: new Date().toISOString() })
        .eq('id', user.id);
      if (profileErr) throw profileErr;
      await refreshProfile();
      return { error: null };
    } catch (error) {
      return { error: error as Error };
    }
  };

  const deleteAccount = async (password: string): Promise<{ error: Error | null }> => {
    try {
      if (!user) throw new Error('Not authenticated');
      // Verify password by re-authenticating
      let authErr: any = null;
      if (profile?.email) {
        const { error } = await supabase.auth.signInWithPassword({ email: profile.email, password });
        authErr = error;
      } else {
        const normalised = (profile?.username || '').toLowerCase();
        const { error } = await supabase.auth.signInWithPassword({ email: `${normalised}@sylvacrypt.com`, password });
        authErr = error;
      }
      
      if (authErr) throw new Error('Incorrect password. Account not deleted.');
      // Clear all local encrypted data first (local-only, no race risk)
      await clearAllData();
      // Edge function atomically deletes profile then auth user in one server call.
      // Profile deletion was previously done client-side before this invoke, which
      // created a race window: profile gone but auth still valid if the function
      // timed out. Moving it server-side makes the entire operation atomic.
      const { error: fnErr } = await supabase.functions.invoke('delete-account', { method: 'POST' });
      if (fnErr) {
        const msg = await fnErr.context?.text?.() ?? fnErr.message;
        throw new Error(msg);
      }
      await signOut();
      return { error: null };
    } catch (error) {
      return { error: error as Error };
    }
  };

  const updateAvatar = async (file: File): Promise<{ error: Error | null; url?: string }> => {
    try {
      if (!user) throw new Error('Not authenticated');
      const ext = file.name.split('.').pop()?.toLowerCase() ?? 'jpg';
      const path = `${user.id}/avatar.${ext}`;
      const { error: uploadErr } = await supabase.storage
        .from('avatars')
        .upload(path, file, { upsert: true, contentType: file.type });
      if (uploadErr) throw uploadErr;
      const { data: urlData } = supabase.storage.from('avatars').getPublicUrl(path);
      // Append cache-buster so the browser reloads the new image
      const url = `${urlData.publicUrl}?t=${Date.now()}`;
      const { error: updateErr } = await supabase
        .from('profiles')
        .update({ avatar_url: urlData.publicUrl })
        .eq('id', user.id);
      if (updateErr) throw updateErr;
      await refreshProfile();
      return { error: null, url };
    } catch (error) {
      return { error: error as Error };
    }
  };

  const updateAvatarPrivacy = async (isPrivate: boolean): Promise<{ error: Error | null }> => {
    try {
      if (!user) throw new Error('Not authenticated');
      const { error } = await supabase
        .from('profiles')
        .update({ avatar_private: isPrivate })
        .eq('id', user.id);
      if (error) throw error;
      await refreshProfile();
      return { error: null };
    } catch (error) {
      return { error: error as Error };
    }
  };

  const migrateToNewPassword = async (newPassword: string): Promise<{ error: Error | null }> => {
    try {
      if (!user) throw new Error('Not authenticated');
      const breach = await checkPasswordBreach(newPassword);
      if (breach.breached) {
        throw new Error(`This password has appeared in ${breach.count.toLocaleString()} known data breaches. Please choose a different password.`);
      }
      if (breach.failed) {
        toast.warning('Password breach check skipped: service is currently unavailable.');
      }
      // Re-encrypt local vault data under the new password before changing Supabase auth
      // reEncryptVaultWithNewPassword already upgrades to Argon2id (v1) and stores it locally
      await reEncryptVaultWithNewPassword(newPassword);
      // Update Supabase auth password
      const { error: authErr } = await supabase.auth.updateUser({ password: newPassword });
      if (authErr) throw authErr;
      // Sync the newly re-encrypted key blob + salt + KDF version to Supabase
      const [saltB64, keyBlob] = await Promise.all([
        getStoredSaltBase64(),
        getEncryptedIdentityKeyBlob(),
      ]);
      const { error: profileErr } = await supabase
        .from('profiles')
        .update({
          password_version: 1,
          kdf_version: 1,
          ...(saltB64 && { vault_salt: saltB64 }),
          ...(keyBlob && { encrypted_private_key: keyBlob }),
        })
        .eq('id', user.id);
      if (profileErr) throw profileErr;
      await refreshProfile();
      return { error: null };
    } catch (error) {
      return { error: error as Error };
    }
  };

  /** Generate a fresh BIP-39 mnemonic, store it encrypted in the vault and hash in profiles. */
  const generateAndStoreMnemonic = async (): Promise<{ mnemonic: string | null; error: Error | null }> => {
    try {
      // Resolve user ID directly from the Supabase client rather than React state.
      // After signUp, the onAuthStateChange callback that sets `user` fires
      // asynchronously — relying on the `user` state here would throw
      // "Not authenticated" for new registrations even though auth succeeded.
      let resolvedUserId = user?.id ?? null;
      if (!resolvedUserId) {
        const { data: { user: currentUser } } = await supabase.auth.getUser();
        resolvedUserId = currentUser?.id ?? null;
      }
      if (!resolvedUserId) throw new Error('Not authenticated');

      const mnemonic = generateMnemonic();
      const { hash, saltBase64 } = await generateMnemonicHash(mnemonic);
      await storeMnemonic(mnemonic);
      const { error } = await supabase
        .from('profiles')
        .update({ mnemonic_hash: hash, mnemonic_salt: saltBase64 })
        .eq('id', resolvedUserId);
      if (error) throw error;
      return { mnemonic, error: null };
    } catch (error) {
      return { mnemonic: null, error: error as Error };
    }
  };

  /** Delete the current mnemonic and generate a brand-new one (Settings → regenerate). */
  const regenerateMnemonic = async (): Promise<{ mnemonic: string | null; error: Error | null }> => {
    try {
      if (!user) throw new Error('Not authenticated');
      await deleteMnemonic();
      return generateAndStoreMnemonic();
    } catch (error) {
      return { mnemonic: null, error: error as Error };
    }
  };

  /** Called from the forgot-password flow (unauthenticated). Delegates to the Edge Function. */
  const resetPasswordWithMnemonic = async (
    username: string,
    mnemonic: string,
    newPassword: string
  ): Promise<{ error: Error | null }> => {
    try {
      const { error } = await supabase.functions.invoke('reset-password', {
        method: 'POST',
        body: { username, mnemonic, newPassword },
      });
      if (error) {
        const msg = await (error as { context?: { text?: () => Promise<string> } }).context?.text?.() ?? error.message;
        throw new Error(msg);
      }
      return { error: null };
    } catch (error) {
      return { error: error as Error };
    }
  };

  return (
    <AuthContext.Provider value={{
      user, profile, session, loading,
      signInWithUsername, signUpWithUsername, signOut,
      refreshProfile, checkUsernameAvailable, updatePublicKey,
      updateBio, deleteAccount, changeUsername,
      updateAvatar, updateAvatarPrivacy, migrateToNewPassword,
      generateAndStoreMnemonic, regenerateMnemonic, resetPasswordWithMnemonic,
      updateDiscoverable, signOutAllDevices,
    }}>
      {children}
    </AuthContext.Provider>  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) throw new Error('useAuth must be used within an AuthProvider');
  return context;
}
