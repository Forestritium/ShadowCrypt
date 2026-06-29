/**
 * Session management: derives encryption key from password,
 * manages identity key pair, and wires up local storage.
 */

import {
  deriveVaultKey,
  generateX25519KeyPair,
  toBase64,
  fromBase64,
  computeFingerprint,
} from './crypto';
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
} from './localStore';

export interface SessionInfo {
  userId: string;
  username: string;
  publicKeyBase64: string;
  fingerprint: string;
}

let currentSession: SessionInfo | null = null;

export function getCurrentSession(): SessionInfo | null {
  return currentSession;
}

const SESSION_STORAGE_KEY = 'sc_session_info';

/** Persist session info to sessionStorage so page reloads restore it. */
function persistSessionInfo(info: SessionInfo): void {
  try {
    sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(info));
  } catch { /* ignore */ }
}

/** Restore session info from sessionStorage (called on page reload). */
export function restoreSessionInfo(): SessionInfo | null {
  if (currentSession) return currentSession;
  try {
    const raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const info = JSON.parse(raw) as SessionInfo;
    currentSession = info;
    return info;
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
  const encKey = await deriveVaultKey(password, salt, effectiveKdfVersion);
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
      identityKP = {
        privateKeyBase64: newKP.privateKeyBase64,
        publicKeyBase64: newKP.publicKeyBase64,
      };
      await saveIdentityKeyPair(identityKP);
    }
  }

  // Guard: if the restored key is a legacy uncompressed P-256 key (65 bytes),
  // it is incompatible with X25519 DH. Silently replace it with a fresh X25519
  // pair so the profile sync below will push the new key to the server.
  if (fromBase64(identityKP.publicKeyBase64).length !== 32) {
    console.warn('[ShadowCrypt] Legacy P-256 identity key detected — regenerating X25519 key pair.');
    const newKP = generateX25519KeyPair();
    identityKP = { privateKeyBase64: newKP.privateKeyBase64, publicKeyBase64: newKP.publicKeyBase64 };
    await saveIdentityKeyPair(identityKP);
  }

  // Always use the LOCAL identity key as the canonical public key.
  // storedPublicKey (from profiles) may be stale — the local key is authoritative
  // for encryption. The profile will be updated if there is a mismatch.
  const publicKeyBase64 = identityKP.publicKeyBase64;
  const fingerprint = await computeFingerprint(publicKeyBase64);
  void storedPublicKey; // consumed by caller to trigger profile sync

  currentSession = {
    userId,
    username,
    publicKeyBase64,
    fingerprint,
  };

  persistSessionInfo(currentSession);
  return currentSession;
}

// Called on logout
export function lockSession(): void {
  clearEncryptionKey();
  currentSession = null;
  try { sessionStorage.removeItem(SESSION_STORAGE_KEY); } catch { /* ignore */ }
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
