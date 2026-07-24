import { generateUUID } from "@/lib/uuid";
/**
 * Session management: derives encryption key from password,
 * manages identity key pair, manages per-device key pair,
 * and wires up local storage.
 */

import {
  generateX25519KeyPair,
  generateEd25519KeyPair,
  toBase64,
  fromBase64,
  computeFingerprint,
} from './crypto';
import { deriveVaultKeyInWorker } from './cryptoWorker';
import { getDB } from './localStore';
import {
  setEncryptionKey,
  clearEncryptionKey,
  getIdentityKeyPair,
  saveIdentityKeyPair,
  getStoredSalt,
  storeStoredSalt,
  restoreVaultFromBackup,
  getKdfVersion,
  storeKdfVersion,
  clearAllRatchetSessions,
  getEncrypted,
  setEncrypted,
} from './localStore';
import {
  getOrCreateDeviceId,
  ensureDeviceKeyPair,
  detectDeviceName,
  recoverDeviceFromSupabase,
  storeEncryptedDeviceKeyPair,
  pruneGhostDevices,
} from './deviceStore';

export interface SessionInfo {
  userId: string;
  username: string;
  publicKeyBase64: string;
  fingerprint: string;
  /** Stable UUID identifying this browser/device instance. */
  deviceId: string;
  /** This device's X25519 public key (may equal publicKeyBase64 for the first device). */
  devicePublicKey: string;
}

let currentSession: SessionInfo | null = null;

export function getCurrentSession(): SessionInfo | null {
  return currentSession;
}

const SESSION_STORAGE_KEY = 'sc_session_info';
const SESSION_LOCAL_KEY = 'sc_session_info_persist'; // used when "keep me signed in" is on

/**
 * Keep-Me-Signed-In duration helpers.
 *
 * localStorage keys:
 *   sc_keep_signed_in      — '0' = off; anything else = on (legacy + new)
 *   sc_keep_signed_in_days — '1'|'3'|'5'|'7'|'14'|'30'|'forever'
 *                            default: '14' (14 days)
 *   sc_vault_expiry        — Unix ms timestamp; absent = no expiry
 */

export type KeepSignedInDuration = '1' | '3' | '5' | '7' | '14' | '30' | 'forever';
export const KEEP_SIGNED_IN_OPTIONS: { label: string; value: KeepSignedInDuration | 'off' }[] = [
  { label: 'Off',      value: 'off' },
  { label: '1 day',   value: '1' },
  { label: '3 days',  value: '3' },
  { label: '5 days',  value: '5' },
  { label: '7 days',  value: '7' },
  { label: '14 days', value: '14' },
  { label: '30 days', value: '30' },
  { label: 'Forever', value: 'forever' },
];

/** Read the current keep-signed-in setting. Returns 'off' or a duration string. */
export function getKeepSignedInSetting(): 'off' | KeepSignedInDuration {
  try {
    if (localStorage.getItem('sc_keep_signed_in') !== '1') return 'off';
    return (localStorage.getItem('sc_keep_signed_in_days') as KeepSignedInDuration) ?? '14';
  } catch { return 'off'; }
}

/** Persist the keep-signed-in setting and recompute the vault expiry timestamp. */
export function setKeepSignedInSetting(value: 'off' | KeepSignedInDuration): void {
  try {
    if (value === 'off') {
      localStorage.setItem('sc_keep_signed_in', '0');
      localStorage.removeItem('sc_keep_signed_in_days');
      localStorage.removeItem('sc_vault_expiry');
    } else {
      localStorage.setItem('sc_keep_signed_in', '1');
      localStorage.setItem('sc_keep_signed_in_days', value);
      if (value === 'forever') {
        localStorage.removeItem('sc_vault_expiry');
      } else {
        const ms = parseInt(value, 10) * 24 * 60 * 60 * 1000;
        localStorage.setItem('sc_vault_expiry', String(Date.now() + ms));
      }
    }
  } catch { /* non-fatal */ }
}

/** Returns true when the persisted session is still within its allowed duration. */
export function isKeepSignedInValid(): boolean {
  try {
    if (localStorage.getItem('sc_keep_signed_in') !== '1') return false;
    const expiry = localStorage.getItem('sc_vault_expiry');
    if (!expiry) return true; // 'forever' or legacy (no expiry stored)
    return Date.now() < parseInt(expiry, 10);
  } catch { return false; }
}

/**
 * Returns true when the user has "Keep Me Signed In" enabled.
 * Treats an unset flag (first-time users) as ON so existing sessions are not
 * broken when the user has never touched the toggle.  Only an explicit '0'
 * (the user consciously turned the toggle off) suppresses cross-session persistence.
 */
function isKeepSignedIn(): boolean {
  try { return localStorage.getItem('sc_keep_signed_in') === '1'; } catch { return false; }
}

async function getEphemeralKey(): Promise<CryptoKey> {
  let raw = window.name;
  if (!raw || !raw.startsWith('sc_eph_')) {
    const key = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );
    const exported = await crypto.subtle.exportKey('raw', key);
    raw = 'sc_eph_' + Array.from(new Uint8Array(exported))
      .map(b => b.toString(16).padStart(2, '0')).join('');
    window.name = raw;
  }
  
  const hex = raw.slice(7);
  const bytes = new Uint8Array(hex.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** Persist session info.
 *  Always writes to sessionStorage (survives same-tab refresh).
 *  Only writes to localStorage when "Keep Me Signed In" is enabled so that
 *  closing the browser actually clears the session when the user opted out. */
async function persistSessionInfo(info: SessionInfo): Promise<void> {
  try {
    const encoded = JSON.stringify(info);
    
    // Encrypt for sessionStorage
    const key = await getEphemeralKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode(encoded)
    );
    const payload = {
      iv: Array.from(iv).map(b => b.toString(16).padStart(2, '0')).join(''),
      data: Array.from(new Uint8Array(encrypted)).map(b => b.toString(16).padStart(2, '0')).join('')
    };
    sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(payload));

    if (isKeepSignedIn()) {
      await setEncrypted('session_info', info);
      localStorage.removeItem(SESSION_LOCAL_KEY); // Clean up legacy plaintext
    } else {
      // Remove any previously persisted entry so it doesn't outlive this session.
      localStorage.removeItem(SESSION_LOCAL_KEY);
    }
  } catch { /* ignore */ }
}

/** Restore session info.
 *  Checks sessionStorage first (same-tab refresh), then localStorage only when
 *  "Keep Me Signed In" is enabled and the session hasn't expired. */
export async function restoreSessionInfo(): Promise<SessionInfo | null> {
  if (currentSession) return currentSession;
  try {
    // 1. Same-tab refresh path — sessionStorage survives page reload regardless
    //    of the "keep signed in" preference.
    const raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (raw) {
      try {
        const payload = JSON.parse(raw);
        if (payload.iv && payload.data) {
          const key = await getEphemeralKey();
          const iv = new Uint8Array(payload.iv.match(/.{1,2}/g)!.map((b: string) => parseInt(b, 16)));
          const data = new Uint8Array(payload.data.match(/.{1,2}/g)!.map((b: string) => parseInt(b, 16)));
          const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
          const info = JSON.parse(new TextDecoder().decode(decrypted)) as SessionInfo;
          currentSession = info;
          return info;
        } else {
          // Legacy plaintext fallback
          const info = JSON.parse(raw) as SessionInfo;
          currentSession = info;
          return info;
        }
      } catch (e) {
        console.warn('Failed to decrypt session storage:', e);
      }
    }
    // 2. Cross-restart path — only restore from localStorage when the user has
    //    "Keep Me Signed In" turned on and the session is still within its duration.
    if (isKeepSignedIn() && isKeepSignedInValid()) {
      localStorage.removeItem(SESSION_LOCAL_KEY); // Clean up legacy plaintext
      const info = await getEncrypted<SessionInfo>('session_info');
      if (info) {
        currentSession = info;
        // Re-hydrate sessionStorage so subsequent calls (same tab) hit path 1.
        persistSessionInfo(info).catch(() => {});
        return info;
      }
    }
    return null;
  } catch {
    return null;
  }
}

// Called after successful Supabase login
// Derives the encryption key from the user's password and sets up local storage
export async function unlockSession(
  userId: string,
  username: string,
  password: string,
  storedPublicKey?: string | null,
  encryptedKeyBackup?: string | null,
  kdfVersion = 0,
): Promise<SessionInfo> {
  // Get or create salt for this user
  let salt = await getStoredSalt();
  if (!salt) {
    salt = crypto.getRandomValues(new Uint8Array(16));
    await storeStoredSalt(salt);
  }

  // Read persisted KDF version (falls back to the profile-supplied default)
  const localKdfVersion = await getKdfVersion();
  const effectiveKdfVersion = localKdfVersion || kdfVersion;

  // Derive encryption key from password using the correct KDF
  const encKey = await deriveVaultKeyInWorker(password, salt, effectiveKdfVersion);
  await setEncryptionKey(encKey);

  // Persist the KDF version locally so future logins know which algorithm to use
  if (localKdfVersion !== effectiveKdfVersion) {
    await storeKdfVersion(effectiveKdfVersion);
  }

  // Get or restore identity key pair
  let identityKP = await getIdentityKeyPair();
  if (!identityKP) {
    if (encryptedKeyBackup) {
      // Vault was cleared (e.g. browser data wiped) — restore key pair from cloud backup
      const saltBase64 = btoa(String.fromCharCode(...salt));
      await restoreVaultFromBackup(saltBase64, encryptedKeyBackup, effectiveKdfVersion);
      identityKP = await getIdentityKeyPair();
    }
    if (!identityKP) {
      // No backup available — generate a fresh X25519 key pair
      const newKP = generateX25519KeyPair();
      const edKP = generateEd25519KeyPair();
      identityKP = {
        privateKeyBase64: newKP.privateKeyBase64,
        publicKeyBase64: newKP.publicKeyBase64,
        ed25519Priv: edKP.privateKeyBase64,
        ed25519Pub: edKP.publicKeyBase64,
      };
      await saveIdentityKeyPair(identityKP);
    }
  }

  // Generate Ed25519 keypair if missing (migration)
  if (identityKP && (!identityKP.ed25519Priv || !identityKP.ed25519Pub)) {
    const edKP = generateEd25519KeyPair();
    identityKP = {
      ...identityKP,
      ed25519Priv: edKP.privateKeyBase64,
      ed25519Pub: edKP.publicKeyBase64,
    };
    await saveIdentityKeyPair(identityKP);
  }

  // Guard: if the restored key is a legacy uncompressed P-256 key (65 bytes),
  // it is incompatible with X25519 DH. Silently replace it with a fresh X25519
  // pair so the profile sync below will push the new key to the server.
  if (fromBase64(identityKP.publicKeyBase64).length !== 32) {
    console.warn('[SylvaCrypt] Legacy P-256 identity key detected — regenerating X25519 key pair.');
    const newKP = generateX25519KeyPair();
    const edKP = generateEd25519KeyPair();
    identityKP = { 
      privateKeyBase64: newKP.privateKeyBase64, 
      publicKeyBase64: newKP.publicKeyBase64,
      ed25519Priv: edKP.privateKeyBase64,
      ed25519Pub: edKP.publicKeyBase64,
    };
    await saveIdentityKeyPair(identityKP);
  }

  // Always use the LOCAL identity key as the canonical public key.
  // storedPublicKey (from profiles) may be stale — the local key is authoritative
  // for encryption. The profile will be updated if there is a mismatch.
  const publicKeyBase64 = identityKP.publicKeyBase64;
  const fingerprint = await computeFingerprint(publicKeyBase64);
  void storedPublicKey; // consumed by caller to trigger profile sync

  // ── Multi-device: ensure this device has its own key pair ─────────────────
  //
  // Recovery path (ghost-device prevention):
  //   Clearing browser history wipes localStorage, which would cause
  //   getOrCreateDeviceId() to generate a fresh UUID and register a new row in
  //   user_devices — even though it's the same physical browser. Over multiple
  //   clear cycles the same browser accumulates ghost device rows; the sender
  //   encrypts once per row, but the receiver's current session only matches the
  //   newest UUID, so messages addressed to old UUIDs are silently skipped.
  //
  //   recoverDeviceFromSupabase() runs only when localStorage has no sc_device_id
  //   entry. It fetches all approved device rows for the user, tries to decrypt
  //   each encrypted_device_keypair blob with the current vault key, and — on
  //   success — restores the matching UUID + key pair. No new row is created.
  const deviceName = detectDeviceName();
  let deviceId: string;
  let deviceKP: { privateKeyBase64: string; publicKeyBase64: string };

  const recovered = await recoverDeviceFromSupabase(userId);
  if (recovered) {
    deviceId = recovered.deviceId;
    deviceKP = recovered.keyPair;
    // Row already exists — just refresh last_seen_at via registerDevice upsert.
    import('./sessionRelay').then(({ registerDevice }) => {
      registerDevice(userId, deviceId, deviceKP.publicKeyBase64, deviceName).catch(err => {
        console.warn('[SylvaCrypt] Device last-seen refresh failed (non-fatal):', err);
      });
    });
  } else {
    deviceId = getOrCreateDeviceId();
    deviceKP = await ensureDeviceKeyPair(identityKP);
    // Register new device, then immediately store the encrypted key pair blob so
    // future localStorage clears recover this identity instead of creating a ghost row.
    import('./sessionRelay').then(({ registerDevice }) => {
      registerDevice(userId, deviceId, deviceKP.publicKeyBase64, deviceName)
        .then(() => storeEncryptedDeviceKeyPair(deviceId, deviceKP))
        .catch(err => {
          console.warn('[SylvaCrypt] Device registration failed (non-fatal):', err);
        });
    });
  }

  // Prune any ghost rows created by prior localStorage clears (dedupes by public_key,
  // keeping the most-recently-seen row). Fire-and-forget — does not block send/receive.
  pruneGhostDevices(userId).catch(err => {
    console.warn('[SylvaCrypt] Ghost device pruning failed (non-fatal):', err);
  });

  // Publish X3DH prekeys (signed prekey + OPK batch + ML-KEM key).
  // Fire-and-forget: prekey publication is non-fatal — if it fails the session still
  // works via the legacy single-DH path; the next login will retry.
  import('./sessionX3dh').then(({ publishPrekeys, replenishOPKsIfNeeded }) => {
    publishPrekeys(
      userId,
      identityKP.ed25519Priv!,
      identityKP.publicKeyBase64,
      identityKP.ed25519Pub!
    )
      .then(() => replenishOPKsIfNeeded(userId))
      .catch(err => console.warn('[X3DH] Prekey publication failed (non-fatal):', err));
  });

  currentSession = {
    userId,
    username,
    publicKeyBase64,
    fingerprint,
    deviceId,
    devicePublicKey: deviceKP.publicKeyBase64,
  };

  // ── One-time migration v338: clear sessions derived with the wrong key ───────
  // Before v338 X3DH used the device key pair for DH2 instead of the identity
  // key pair, producing permanently mismatched secrets.
  const MIGRATION_FLAG_V338 = 'sc_x3dh_v338_migrated';
  if (!localStorage.getItem(MIGRATION_FLAG_V338)) {
    clearAllRatchetSessions()
      .then(() => { localStorage.setItem(MIGRATION_FLAG_V338, '1'); })
      .catch(err => console.warn('[SylvaCrypt] v338 ratchet migration failed (non-fatal):', err));
  }

  // ── One-time migration v343: force a clean-slate ratchet reset ────────────
  // Between v338 and v343 several X3DH / Double-Ratchet fixes were deployed
  // (identity-key selection, stale-session guard, session-key mismatch).
  // Any session established under the pre-v343 code may carry diverged chain
  // keys that cause permanent decrypt failures.  Wiping all stored ratchet
  // sessions here ensures every conversation restarts with a fresh, correct
  // X3DH handshake on the next send.  The companion DB migration 00051 clears
  // all in-flight relay rows so stale ciphertexts never hit the new sessions.
  const MIGRATION_FLAG_V343 = 'sc_ratchet_v343_reset';
  if (!localStorage.getItem(MIGRATION_FLAG_V343)) {
    clearAllRatchetSessions()
      .then(() => { localStorage.setItem(MIGRATION_FLAG_V343, '1'); })
      .catch(err => console.warn('[SylvaCrypt] v343 ratchet migration failed (non-fatal):', err));
  }

  // ── One-time migration SylvaCrypt: force a clean-slate ratchet reset ────────
  // The HKDF info string was changed from "ShadowCrypt-InitV2" to "SylvaCrypt-InitV2".
  // Existing sessions will fail to decrypt. Wiping all stored ratchet sessions
  // forces a fresh X3DH handshake with the new info string.
  const MIGRATION_FLAG_SYLVACRYPT = 'sylvacrypt_init_v2_reset';
  if (!localStorage.getItem(MIGRATION_FLAG_SYLVACRYPT)) {
    clearAllRatchetSessions()
      .then(() => { localStorage.setItem(MIGRATION_FLAG_SYLVACRYPT, '1'); })
      .catch(err => console.warn('[SylvaCrypt] SylvaCrypt ratchet migration failed (non-fatal):', err));
  }

  persistSessionInfo(currentSession).catch(console.error);

  // ── Ensure keep-signed-in expiry is set for new/migrating sessions ────────
  // For first-time users (or after browser data clear), sc_vault_expiry is not
  // set. Default to 14 days so the session doesn't persist forever unless the
  // user explicitly chooses "Forever" in Settings.
  try {
    const keepOn = localStorage.getItem('sc_keep_signed_in') === '1';
    const hasExpiry = localStorage.getItem('sc_vault_expiry') !== null;
    const hasDays = localStorage.getItem('sc_keep_signed_in_days') !== null;
    if (keepOn && !hasExpiry && !hasDays) {
      // New user — set 14-day default
      localStorage.setItem('sc_keep_signed_in_days', '14');
      localStorage.setItem('sc_vault_expiry', String(Date.now() + 14 * 24 * 60 * 60 * 1000));
    } else if (keepOn && !hasExpiry && hasDays) {
      // Has a days preference but expiry was never stamped (e.g. migrating from old build)
      const days = localStorage.getItem('sc_keep_signed_in_days');
      if (days && days !== 'forever') {
        localStorage.setItem('sc_vault_expiry', String(Date.now() + parseInt(days, 10) * 24 * 60 * 60 * 1000));
      }
    }
  } catch { /* non-fatal */ }

  return currentSession;
}

/**
 * Re-sync the in-memory session info to/from localStorage based on the CURRENT
 * value of the "Keep Me Signed In" flag.
 *
 * Must be called immediately after the flag changes so that the localStorage
 * entry is written (toggle ON) or removed (toggle OFF) without requiring a
 * full re-login.
 */
export function syncSessionPersistence(): void {
  if (!currentSession) return;
  // persistSessionInfo already reads isKeepSignedIn() internally.
  persistSessionInfo(currentSession).catch(console.error);
}

// Called on logout
export function lockSession(): void {
  clearEncryptionKey();
  currentSession = null;
  try { sessionStorage.removeItem(SESSION_STORAGE_KEY); } catch { /* ignore */ }
  try { localStorage.removeItem(SESSION_LOCAL_KEY); } catch { /* ignore */ }
  import('./relay').then(r => r.clearRelayCache()).catch(() => {});
  import('./relay').then(r => r.clearRelayChannel?.()).catch(() => {});
  import('./dbStore').then(db => db.clearMessagesChannel?.()).catch(() => {});
  // We can't synchronously delete from IDB easily without converting lockSession to async,
  // but clearing the encryption key effectively destroys the session IDB access anyway,
  // and we also clear the session_info in IDB here async-ly.
  getDB().then(db => db.delete('encrypted_store', 'session_info')).catch(() => {});
}

/**
 * Rebuild a SessionInfo from persisted data when the session info storage
 * was cleared (e.g. after an old idle-lock bug) but the vault key is still in
 * memory (IDB restore succeeded). Saves the rebuilt info so subsequent
 * restoreSessionInfo() calls return it without hitting localStorage again.
 */
export function rebuildSession(
  userId: string,
  username: string,
  publicKeyBase64: string,
  fingerprint: string,
): SessionInfo {
  // Reuse existing deviceId if available; fall back to the stable localStorage
  // UUID before generating a fresh one.  generateUUID() must only fire
  // when no ID has ever been stored — never on a cold-start restore where the
  // localStorage entry already exists but currentSession is still null.
  const deviceId = currentSession?.deviceId
    ?? localStorage.getItem('sc_device_id')
    ?? generateUUID();
  const devicePublicKey = currentSession?.devicePublicKey ?? publicKeyBase64;
  currentSession = { userId, username, publicKeyBase64, fingerprint, deviceId, devicePublicKey };
  persistSessionInfo(currentSession).catch(console.error);
  return currentSession;
}

// Get the current user's private key for encryption
export async function getIdentityPrivateKey(): Promise<string | null> {
  const kp = await getIdentityKeyPair();
  return kp?.privateKeyBase64 ?? null;
}

// Generate a conversation ID from two user IDs (deterministic)
export function makeConversationId(userId1: string, userId2: string): string {
  const sorted = [userId1, userId2].sort();
  return toBase64(
    new TextEncoder().encode(`dm:${sorted[0]}:${sorted[1]}`)
  );
}
