import { useContext, useEffect, useState, type ReactNode } from 'react';
import { supabase } from '@/db/supabase';
import type { User } from '@supabase/supabase-js';
import type { Profile } from '@/types/types';
import { toast } from 'sonner';
import { unlockSession, lockSession, restoreSessionInfo } from '@/lib/session';
import {
  clearAllData, restoreVaultKey, reEncryptVaultWithNewPassword,
  storeMnemonic, deleteMnemonic,
  getStoredSaltBase64, getEncryptedIdentityKeyBlob,
  storeKdfVersion,
} from '@/lib/localStore';
import { generateMnemonic, generateMnemonicHash } from '@/lib/mnemonic';
import { AuthContext, type SessionInfo } from '@/contexts/AuthContext.types';

export async function getProfile(userId: string): Promise<Profile | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .maybeSingle();
  if (error) {
    console.error('Failed to fetch profile:', error);
    return null;
  }
  return data;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshProfile = async () => {
    if (!user) { setProfile(null); return; }
    const profileData = await getProfile(user.id);
    setProfile(profileData);
  };

  useEffect(() => {
    supabase.auth.getSession()
      .then(async ({ data: { session: authSession } }) => {
        setUser(authSession?.user ?? null);
        if (authSession?.user) {
          getProfile(authSession.user.id).then(setProfile);
          // Try to restore vault key and session info from sessionStorage
          const vaultOk = await restoreVaultKey();
          const restoredSession = restoreSessionInfo();
          if (vaultOk && restoredSession) {
            setSession(restoredSession);
          }
        }
      })
      .catch(error => toast.error(`Session error: ${error.message}`))
      .finally(() => setLoading(false));

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, authSession) => {
      setUser(authSession?.user ?? null);
      if (authSession?.user) {
        getProfile(authSession.user.id).then(setProfile);
      } else {
        setProfile(null);
        setSession(null);
      }
    });

    return () => subscription.unsubscribe();
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

  const signUpWithUsername = async (username: string, password: string) => {
    try {
      // Normalise to lowercase so the Supabase email "user@shadowcrypt.com" and
      // the profiles.username set by the DB trigger always match.
      const normalised = username.toLowerCase();
      const email = `${normalised}@shadowcrypt.com`;
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
        await supabase
          .from('profiles')
          .update({
            public_key: sessionInfo.publicKeyBase64,
            password_version: 1,
            kdf_version: 1,
            ...(saltB64 && { vault_salt: saltB64 }),
            ...(keyBlob && { encrypted_private_key: keyBlob }),
          })
          .eq('id', data.user.id);
        setSession(sessionInfo);
      }
      return { error: null };
    } catch (error) {
      return { error: error as Error };
    }
  };

  const signInWithUsername = async (username: string, password: string) => {
    try {
      // Always normalise to lowercase — profiles.username and Supabase auth emails
      // are stored lowercase (Supabase lowercases emails; the DB trigger derives
      // the username via split_part on that already-lowercased email).
      // Without this, typing "Alice" to log in constructs "Alice@shadowcrypt.com"
      // which, while Supabase auth resolves case-insensitively, would store the
      // mixed-case value in SessionInfo and cause profile lookups to miss.
      const normalised = username.toLowerCase();
      const email = `${normalised}@shadowcrypt.com`;
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      if (data.user) {
        const profileData = await getProfile(data.user.id);

        // If IndexedDB was wiped (no local salt) but we have a Supabase backup,
        // pre-seed the vault so unlockSession can decrypt the backed-up key pair.
        const { getStoredSalt, storeStoredSalt } = await import('@/lib/localStore');
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
          await supabase.from('profiles').update(profileUpdates).eq('id', data.user.id);
        }

        setSession(sessionInfo);
      }
      return { error: null };
    } catch (error) {
      return { error: error as Error };
    }
  };

  const updatePublicKey = async (publicKey: string) => {
    if (!user) return;
    await supabase.from('profiles').update({ public_key: publicKey }).eq('id', user.id);
  };

  const updateBio = async (bio: string): Promise<{ error: Error | null }> => {
    try {
      if (!user) throw new Error('Not authenticated');
      const { error } = await supabase
        .from('profiles')
        .update({ bio: bio.trim() || null })
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
      // Update email in auth (username@shadowcrypt.com format)
      const newEmail = `${trimmed}@shadowcrypt.com`;
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
      const email = profile?.email ?? `${profile?.username}@shadowcrypt.com`;
      const { error: authErr } = await supabase.auth.signInWithPassword({ email, password });
      if (authErr) throw new Error('Incorrect password. Account not deleted.');
      // Delete profile row first
      await supabase.from('profiles').delete().eq('id', user.id);
      // Clear all local encrypted data
      await clearAllData();
      // Delete the auth user via admin (requires service role — call edge function)
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
      if (!user) throw new Error('Not authenticated');
      const mnemonic = generateMnemonic();
      const { hash, saltBase64 } = await generateMnemonicHash(mnemonic);
      await storeMnemonic(mnemonic);
      const { error } = await supabase
        .from('profiles')
        .update({ mnemonic_hash: hash, mnemonic_salt: saltBase64 })
        .eq('id', user.id);
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
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) throw new Error('useAuth must be used within an AuthProvider');
  return context;
}
