/**
 * Local encrypted storage using IndexedDB.
 * All data is encrypted with AES-256-GCM before being stored.
 * The encryption key is derived from the user's password.
 * 
 * This simulates SQLCipher-style full-database encryption.
 */

import { openDB, IDBPDatabase } from 'idb';
import { supabase } from '@/db/supabase';
import { encryptObject, decryptObject, deriveVaultKey } from './crypto';
import type { Contact, Group, LocalMessage, RatchetSession } from '@/types/types';

const DB_NAME = 'sylvacrypt_local';
// Bumped to 4 to add the outbox queue store for offline message sending.
const DB_VERSION = 4;

// Name of the IDB object store that holds the non-extractable vault CryptoKey.
// Storing the CryptoKey object directly (via Structured Clone) is the only way
// to persist a non-extractable key across page reloads without ever exporting
// its raw bytes to JavaScript — which would be impossible for non-extractable
// keys anyway and would leak key material if it were extractable.
const VAULT_KEYS_STORE = 'vault_keys';
const VAULT_KEY_IDB_KEY = 'current';
const MIGRATIONS_STORE = 'migrations_log';

// Per-version IndexedDB migrations. Each function is idempotent and receives
// the upgrade transaction's IDBDatabase. Register new migrations here when
// DB_VERSION is incremented.
type Migration = (db: IDBPDatabase<unknown>) => void | Promise<void>;
const migrations: Record<number, Migration> = {
  1: (database) => {
    if (!database.objectStoreNames.contains('encrypted_store')) {
      database.createObjectStore('encrypted_store');
    }
  },
  2: (database) => {
    if (!database.objectStoreNames.contains(VAULT_KEYS_STORE)) {
      database.createObjectStore(VAULT_KEYS_STORE);
    }
  },
  3: (database) => {
    if (!database.objectStoreNames.contains(MIGRATIONS_STORE)) {
      database.createObjectStore(MIGRATIONS_STORE, { keyPath: 'version' });
    }
  },
  4: (database) => {
    if (!database.objectStoreNames.contains('outbox')) {
      const store = database.createObjectStore('outbox', { keyPath: 'id' });
      store.createIndex('conversation_id', 'conversationId', { unique: false });
    }
  },
};

// sessionStorage token that marks the current tab as alive.  Set on every
// successful vault unlock/restore; cleared only on explicit logout.
// On page refresh the token survives (sessionStorage is tab-scoped, not
// navigation-scoped), so restoreVaultKey sees it and reloads the IDB key.
// On true tab close sessionStorage is cleared by the browser; on next open
// the token is absent, so a stale IDB key is ignored and the user must log in.
const TAB_TOKEN_KEY = 'sc_tab_alive';

type LocalDB = IDBPDatabase<unknown>;

let db: LocalDB | null = null;
let encryptionKey: CryptoKey | null = null;

// Initialize the database
async function runMigrations(database: IDBPDatabase<unknown>, fromVersion: number): Promise<void> {
  for (let v = fromVersion + 1; v <= DB_VERSION; v++) {
    const migration = migrations[v];
    if (migration) await migration(database);
  }
}

export async function getDB(): Promise<LocalDB> {
  if (!db) {
    db = await openDB(DB_NAME, DB_VERSION, {
      upgrade(database, oldVersion) {
        // Run every migration between the existing version and the target version.
        // Migrations are idempotent and additive so skipping any would be unsafe.
        runMigrations(database, oldVersion).catch(err => {
          console.error('[localStore] IndexedDB migration failed:', err);
        });
      },
    });
  }
  return db;
}

// Set the encryption key (called after successful login).
// Stores the CryptoKey object directly in IndexedDB via the Structured Clone
// Algorithm — this works even for non-extractable keys because the browser
// never exposes the raw bytes to JavaScript.  A tab-alive token in
// sessionStorage lets restoreVaultKey() distinguish a same-tab page refresh
// (token survives) from a new tab or true close (token absent).
// When "Keep Me Signed In" is explicitly OFF, the key is NOT written to IDB
// so the vault cannot be restored after the browser is fully closed.
export async function setEncryptionKey(key: CryptoKey): Promise<void> {
  encryptionKey = key;
  try {
    const keepSignedIn = localStorage.getItem('sc_keep_signed_in') === '1';
    const database = await getDB();
    if (keepSignedIn) {
      await database.put(VAULT_KEYS_STORE, key, VAULT_KEY_IDB_KEY);
    } else {
      // Remove any previously stored key so an old "keep on" session doesn't
      // silently persist after the user switches the toggle off.
      await database.delete(VAULT_KEYS_STORE, VAULT_KEY_IDB_KEY).catch(() => {});
    }
    sessionStorage.setItem(TAB_TOKEN_KEY, '1');
  } catch { /* non-fatal — in-memory key still works for the current page */ }
}

// Clear the encryption key (called on idle-lock; also called by lockSession on full logout)
export function clearEncryptionKey(): void {
  encryptionKey = null;
  try { sessionStorage.removeItem(TAB_TOKEN_KEY); } catch { /* ignore */ }
  // NOTE: sc_session_info is intentionally NOT cleared here.
  // Session info has a longer lifetime than the vault key — it persists until
  // the user explicitly signs out via lockSession(). This allows the vault to
  // be re-unlocked by re-entering the password without a full re-login.
  // Delete the IDB key asynchronously — don't await so lock never blocks.
  getDB()
    .then(database => database.delete(VAULT_KEYS_STORE, VAULT_KEY_IDB_KEY))
    .catch(() => {});
}

/**
 * Attempt to restore the vault encryption key from IndexedDB.
 * Returns true if successfully restored, false if not available.
 * Called on app load when a Supabase session already exists.
 *
 * When "Keep Me Signed In" is explicitly OFF (sc_keep_signed_in === '0'),
 * the IDB restore is skipped so a closed browser truly ends the session.
 * Treats an unset flag as ON to preserve behaviour for existing users.
 */
export async function restoreVaultKey(): Promise<boolean> {
  if (encryptionKey) return true; // Already loaded
  // Honour "Keep Me Signed In" = OFF or expired: do not restore from IDB.
  // sessionStorage is cleared on browser close, so if TAB_TOKEN_KEY is absent and
  // the flag is off (or the duration has elapsed) we know this is a fresh browser
  // start — deny auto-unlock.
  const keepSignedIn = (() => { try { return localStorage.getItem('sc_keep_signed_in') === '1'; } catch { return false; } })();
  const tabAlive = (() => { try { return sessionStorage.getItem(TAB_TOKEN_KEY) === '1'; } catch { return false; } })();
  if (!keepSignedIn && !tabAlive) return false;
  
  // If keepSignedIn is on but duration has elapsed (and this is not a same-tab
  // refresh), treat as expired — do not auto-unlock.
  if (keepSignedIn && !tabAlive) {
    try {
      const expiry = localStorage.getItem('sc_vault_expiry');
      if (expiry && Date.now() >= parseInt(expiry, 10)) {
        return false;
      }
    } catch { return false; }
  }

  try {
    const database = await getDB();
    const key = await database.get(VAULT_KEYS_STORE, VAULT_KEY_IDB_KEY) as CryptoKey | undefined;
    if (!key) return false;
    sessionStorage.setItem(TAB_TOKEN_KEY, '1'); // Keep token in sync for compat
    encryptionKey = key;
    return true;
  } catch {
    return false;
  }
}

/**
 * Re-sync the in-memory vault key to/from IDB based on the CURRENT value of
 * the "Keep Me Signed In" flag.
 *
 * Must be called immediately after the flag is written to localStorage so that
 * the IDB persistence state catches up without requiring a full re-login.
 *
 *  Toggle ON  → write the in-memory key to IDB (enables cross-restart restore)
 *  Toggle OFF → delete the key from IDB    (disables cross-restart restore)
 *
 * No-op if no key is currently in memory (user not logged in).
 */
export async function syncVaultKeyPersistence(): Promise<void> {
  if (!encryptionKey) return;
  const keepSignedIn = (() => {
    try { return localStorage.getItem('sc_keep_signed_in') === '1'; } catch { return false; }
  })();
  try {
    const database = await getDB();
    if (keepSignedIn) {
      await database.put(VAULT_KEYS_STORE, encryptionKey, VAULT_KEY_IDB_KEY);
      // Ensure the tab-alive token is set so the key can also be used for same-tab refreshes.
      try { sessionStorage.setItem(TAB_TOKEN_KEY, '1'); } catch { /* ignore */ }
    } else {
      await database.delete(VAULT_KEYS_STORE, VAULT_KEY_IDB_KEY).catch(() => {});
    }
  } catch { /* non-fatal */ }
}

function requireKey(): CryptoKey {
  if (!encryptionKey) {
    throw new Error('Encryption key not set. Please log in first.');
  }
  return encryptionKey;
}

/** Return the current vault key, or null if the vault is locked. */
export function getEncryptionKey(): CryptoKey | null {
  return encryptionKey;
}

/** Return true if the vault key is currently loaded in memory. */
export function isVaultUnlocked(): boolean {
  return encryptionKey !== null;
}

// Generic encrypted get/set (also exported for x3dh.ts prekey vault storage)
export async function getEncrypted<T>(storeKey: string): Promise<T | null> {
  const key = requireKey();
  const database = await getDB();
  const encrypted = await database.get('encrypted_store', storeKey);
  if (!encrypted || typeof encrypted !== 'string') return null;
  try {
    return await decryptObject<T>(key, encrypted);
  } catch {
    return null;
  }
}

export async function setEncrypted<T>(storeKey: string, value: T): Promise<void> {
  const key = requireKey();
  const database = await getDB();
  const encrypted = await encryptObject(key, value);
  await database.put('encrypted_store', encrypted, storeKey);
}

export async function deleteEncrypted(storeKey: string): Promise<void> {
  const database = await getDB();
  await database.delete('encrypted_store', storeKey);
}

// ========================
// CONTACTS
// ========================

export async function getContacts(): Promise<Contact[]> {
  return (await getEncrypted<Contact[]>('contacts')) ?? [];
}

export async function saveContact(contact: Contact): Promise<void> {
  const contacts = await getContacts();
  const idx = contacts.findIndex(c => c.id === contact.id);
  if (idx >= 0) {
    contacts[idx] = contact;
  } else {
    contacts.push(contact);
  }
  await setEncrypted('contacts', contacts);
}

export async function deleteContact(contactId: string): Promise<void> {
  const contacts = await getContacts();
  await setEncrypted(
    'contacts',
    contacts.filter(c => c.id !== contactId)
  );
}

/** Remove a contact and wipe all their conversation messages. */
export async function removeContactAndMessages(contactId: string, conversationId: string): Promise<void> {
  await Promise.all([
    deleteContact(contactId),
    deleteConversationMessages(conversationId),
  ]);
}

export async function getContact(contactId: string): Promise<Contact | null> {
  const contacts = await getContacts();
  return contacts.find(c => c.id === contactId) ?? null;
}

// ========================
// GROUPS
// ========================

export async function getGroups(): Promise<Group[]> {
  return (await getEncrypted<Group[]>('groups')) ?? [];
}

export async function saveGroup(group: Group): Promise<void> {
  const groups = await getGroups();
  const idx = groups.findIndex(g => g.id === group.id);
  if (idx >= 0) {
    groups[idx] = group;
  } else {
    groups.push(group);
  }
  await setEncrypted('groups', groups);
}

export async function deleteGroup(groupId: string): Promise<void> {
  const groups = await getGroups();
  await setEncrypted(
    'groups',
    groups.filter(g => g.id !== groupId)
  );
}

// ========================
// MESSAGES
// ========================

export async function getMessages(conversationId: string): Promise<LocalMessage[]> {
  const key = `messages:${conversationId}`;
  return (await getEncrypted<LocalMessage[]>(key)) ?? [];
}

export async function saveMessage(message: LocalMessage): Promise<void> {
  const key = `messages:${message.conversationId}`;
  const messages = await getMessages(message.conversationId);
  const idx = messages.findIndex(m => m.id === message.id);
  if (idx >= 0) {
    messages[idx] = message;
  } else {
    messages.push(message);
  }
  // Keep last 500 messages per conversation
  const trimmed = messages.slice(-500);
  await setEncrypted(key, trimmed);
}

export async function deleteConversationMessages(conversationId: string): Promise<void> {
  await deleteEncrypted(`messages:${conversationId}`);
}

// ========================
// RATCHET SESSIONS
// ========================

export async function getRatchetSession(
  conversationId: string
): Promise<RatchetSession | null> {
  return getEncrypted<RatchetSession>(`ratchet_v3:${conversationId}`);
}

export async function saveRatchetSession(session: RatchetSession): Promise<void> {
  await setEncrypted(`ratchet_v3:${session.conversationId}`, session);
}

/** Delete the ratchet session for a conversation (forces fresh re-initialization). */
export async function deleteRatchetSession(conversationId: string): Promise<void> {
  await deleteEncrypted(`ratchet_v3:${conversationId}`);
}

/**
 * Wipe every ratchet session from the encrypted vault plus every sender-IDK
 * record from localStorage.  Called once during the v338 migration to flush
 * sessions that were established with the wrong (device) key in X3DH DH2 so
 * that fresh X3DH handshakes are performed with the correct identity keys.
 */
export async function clearAllRatchetSessions(): Promise<void> {
  try {
    const database = await getDB();
    const allKeys = await database.getAllKeys('encrypted_store') as string[];
    const ratchetKeys = allKeys.filter(k => typeof k === 'string' && k.startsWith('ratchet_v3:'));
    await Promise.all(ratchetKeys.map(k => database.delete('encrypted_store', k)));
  } catch (e) {
    console.warn('[SylvaCrypt] clearAllRatchetSessions (IDB) failed:', e);
  }
  // Also remove every sc_sidk: entry from localStorage
  try {
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('sc_sidk:')) toRemove.push(key);
    }
    toRemove.forEach(k => localStorage.removeItem(k));
  } catch (e) {
    console.warn('[SylvaCrypt] clearAllRatchetSessions (localStorage) failed:', e);
  }
}

// ========================
// IDENTITY KEYS
// ========================

interface IdentityKeyPair {
  privateKeyBase64: string;
  publicKeyBase64: string;
  ed25519Priv?: string; // Ed25519 private key (base64)
  ed25519Pub?: string; // Ed25519 public key (base64)
}

export async function getIdentityKeyPair(): Promise<IdentityKeyPair | null> {
  return getEncrypted<IdentityKeyPair>('identity_keypair');
}

export async function saveIdentityKeyPair(kp: IdentityKeyPair): Promise<void> {
  await setEncrypted('identity_keypair', kp);
}

// ========================
// DEVICE KEY PAIR
// ========================

// ========================
// SENDER IDENTITY KEY TRACKING
// ========================
// Stored per ratchet session so sendEncryptedMessage can detect when the
// sender's identity key has changed (vault re-sync after a key-loss event).
// If the stored idk doesn't match the current key the session chain is
// undecryptable by the receiver and must be cleared before the next send.

// ── Sender IDK stored in plain localStorage (not the encrypted vault) ────────
// The sender's own identity PUBLIC key is not sensitive (it's already public in
// the Supabase profiles table).  Using the encrypted vault here caused a critical
// race: if the vault key was briefly unavailable (idle-lock timeout firing between
// two async awaits), getEncrypted() would throw, be caught as null, and the
// stale-session guard would incorrectly delete a valid ratchet session — causing
// every subsequent send to create a fresh init that the receiver couldn't decrypt.
// Plain localStorage is always synchronously readable, eliminating the race.
const _SIDK_PREFIX = 'sc_sidk:';

/** Return the identity public key that was active when sessionKey was created. */
export function getLastKnownSenderIdk(sessionKey: string): Promise<string | null> {
  return Promise.resolve(localStorage.getItem(`${_SIDK_PREFIX}${sessionKey}`));
}

/** Record the sender's identity public key for the given session. */
export function setLastKnownSenderIdk(sessionKey: string, pub: string): Promise<void> {
  try { localStorage.setItem(`${_SIDK_PREFIX}${sessionKey}`, pub); } catch { /* storage quota */ }
  return Promise.resolve();
}

/** Remove the sender idk record (called when the session itself is deleted). */
export function deleteLastKnownSenderIdk(sessionKey: string): Promise<void> {
  localStorage.removeItem(`${_SIDK_PREFIX}${sessionKey}`);
  return Promise.resolve();
}

/** Per-device X25519 key pair (distinct from the legacy user identity key). */
export interface DeviceKeyPair {
  privateKeyBase64: string;
  publicKeyBase64: string;
}

/** Retrieve this device's X25519 key pair from the vault. */
export async function getDeviceKeyPair(): Promise<DeviceKeyPair | null> {
  return getEncrypted<DeviceKeyPair>('device_keypair');
}

/** Persist this device's X25519 key pair in the vault. */
export async function saveDeviceKeyPair(kp: DeviceKeyPair): Promise<void> {
  await setEncrypted('device_keypair', kp);
}

// ========================
// USER PREFERENCES
// ========================

export async function clearAllData(): Promise<void> {
  const database = await getDB();
  await database.clear('encrypted_store');
}

// Store the encryption salt for this device (not sensitive, just needed for key re-derivation)
export async function getStoredSalt(): Promise<Uint8Array | null> {
  const database = await getDB();
  const raw = await database.get('encrypted_store', '__salt__');
  if (!raw || typeof raw !== 'string') return null;
  return Uint8Array.from(atob(raw), c => c.charCodeAt(0));
}

export async function storeStoredSalt(salt: Uint8Array): Promise<void> {
  const database = await getDB();
  await database.put(
    'encrypted_store',
    btoa(String.fromCharCode(...salt)),
    '__salt__'
  );
}

/** Return the stored salt as a base64 string (for Supabase backup). */
export async function getStoredSaltBase64(): Promise<string | null> {
  const database = await getDB();
  const raw = await database.get('encrypted_store', '__salt__');
  return (raw && typeof raw === 'string') ? raw : null;
}

/**
 * Return the raw AES-GCM encrypted identity key pair blob stored in IndexedDB.
 * This is the same ciphertext saved to Supabase as a cloud backup.
 */
export async function getEncryptedIdentityKeyBlob(): Promise<string | null> {
  const database = await getDB();
  const blob = await database.get('encrypted_store', 'identity_keypair');
  return (blob && typeof blob === 'string') ? blob : null;
}

/**
 * Restore the vault from a Supabase cloud backup (called when IndexedDB was cleared).
 * Writes the salt, encrypted key blob, and KDF version directly — no decryption needed here.
 */
export async function restoreVaultFromBackup(
  saltBase64: string,
  encryptedKeyBlob: string,
  kdfVersion = 0,
): Promise<void> {
  const database = await getDB();
  await database.put('encrypted_store', saltBase64, '__salt__');
  await database.put('encrypted_store', encryptedKeyBlob, 'identity_keypair');
  await database.put('encrypted_store', kdfVersion, '__kdf_version__');
}

// ========================
// MNEMONIC PHRASE
// ========================

/** Store the BIP-39 recovery mnemonic encrypted in the vault (IDB).
 *  Also uploads an AES-GCM blob to Supabase profiles.encrypted_mnemonic so the
 *  phrase can be restored after an IDB wipe without requiring a full re-login.
 *  The Supabase write is fire-and-forget; a failed backup does not throw. */
export async function storeMnemonic(mnemonic: string, optInCloudBackup = false): Promise<void> {
  // 1. Write to local IDB (primary store)
  await setEncrypted('identity_mnemonic', mnemonic);

  // 2. Upload encrypted blob to Supabase as cloud backup (only if opted in)
  if (!optInCloudBackup) return;

  try {
    const key = requireKey();
    
    const encryptedBlob = await encryptObject(key, mnemonic);

    
    const { data: { user } } = await supabase.auth.getUser();
    if (user?.id) {
      await supabase
        .from('profiles')
        .update({ encrypted_mnemonic: encryptedBlob })
        .eq('id', user.id);
    }
  } catch (err) {
    // Non-fatal: local vault already holds the mnemonic.
    console.warn('[vault] storeMnemonic: Supabase backup failed (non-fatal):', err);
  }
}

/** Retrieve the stored recovery mnemonic from the vault.
 *  Falls back to the Supabase cloud backup if the IDB record is missing. */
export async function getMnemonic(): Promise<string | null> {
  // 1. Try local IDB first (fastest path, no network)
  const local = await getEncrypted<string>('identity_mnemonic');
  if (local) return local;

  // 2. Fallback: restore from Supabase encrypted_mnemonic backup
  try {
    
    const { data: { user } } = await supabase.auth.getUser();
    if (!user?.id) return null;

    const { data: profile } = await supabase
      .from('profiles')
      .select('encrypted_mnemonic')
      .eq('id', user.id)
      .single();

    if (!profile?.encrypted_mnemonic) return null;

    const key = requireKey();
    
    const restored = await decryptObject<string>(key, profile.encrypted_mnemonic);
    if (restored) {
      // Heal the IDB entry so subsequent reads are instant
      await setEncrypted('identity_mnemonic', restored);
    }
    return restored;
  } catch (err) {
    console.warn('[vault] getMnemonic: cloud restore failed:', err);
    return null;
  }
}

/** Delete the stored mnemonic from IDB and clear the Supabase backup. */
export async function deleteMnemonic(): Promise<void> {
  await deleteEncrypted('identity_mnemonic');
  // Best-effort: clear the cloud backup too so a regenerated phrase is not
  // accidentally restored from an outdated blob on the next sign-in.
  try {
    
    const { data: { user } } = await supabase.auth.getUser();
    if (user?.id) {
      await supabase
        .from('profiles')
        .update({ encrypted_mnemonic: null })
        .eq('id', user.id);
    }
  } catch {
    // Ignore — the old blob will be overwritten when the new mnemonic is stored.
  }
}

// ========================
// VAULT RE-ENCRYPTION
// ========================

/** Read the stored KDF version (0 = PBKDF2, 1 = Argon2id). Defaults to 0. */
export async function getKdfVersion(): Promise<number> {
  const database = await getDB();
  const raw = await database.get('encrypted_store', '__kdf_version__');
  return typeof raw === 'number' ? raw : 0;
}

/** Persist the KDF version used for this vault. */
export async function storeKdfVersion(version: number): Promise<void> {
  const database = await getDB();
  await database.put('encrypted_store', version, '__kdf_version__');
}

/**
 * Re-encrypts all vault data under a new password.
 * Called during migration from PIN to password-based auth.
 * The old encryption key must already be set in memory (user just logged in).
 *
 * This always upgrades the vault to Argon2id (v1) for better brute-force resistance.
 */
export async function reEncryptVaultWithNewPassword(newPassword: string): Promise<void> {
  const oldKey = requireKey(); // must be set from current session
  const salt = await getStoredSalt();
  if (!salt) throw new Error('No vault salt found — cannot re-encrypt.');

  
  const newKey = await deriveVaultKey(newPassword, salt, 1);

  // Read ALL encrypted entries (except salt & metadata), decrypt with old key, re-encrypt with new key
  const database = await getDB();
  const tx = database.transaction('encrypted_store', 'readonly');
  const store = tx.objectStore('encrypted_store');
  const allKeys = (await store.getAllKeys()) as string[];
  await tx.done;

  

  // ── Phase 1: Re-encrypt into staging keys (_reenc:<key>) ───────────────────
  // Writing directly to the live keys is non-atomic: a mid-loop crash leaves
  // some entries encrypted with the old key and some with the new key, making
  // the vault unreadable. Instead, write all re-encrypted values to temporary
  // staging keys first. Only commit (swap) after every entry succeeds.
  const staging: Array<{ storeKey: string; reEncrypted: string }> = [];

  for (const storeKey of allKeys) {
    if (storeKey === '__salt__' || storeKey === '__kdf_version__') continue;
    const encrypted = await database.get('encrypted_store', storeKey);
    if (!encrypted || typeof encrypted !== 'string') continue;
    try {
      const plaintext = await decryptObject<unknown>(oldKey, encrypted);
      const reEncrypted = await encryptObject(newKey, plaintext);
      staging.push({ storeKey, reEncrypted });
    } catch {
      // Skip entries that fail to decrypt (stale / corrupted) — they will be
      // left as-is under the old key rather than lost entirely
    }
  }

  // ── Phase 2: Atomic commit in a single readwrite transaction ────────────────
  // All staging writes happen in one transaction: either all succeed or none do.
  // This prevents a torn-write state where some live keys use the new key.
  const commitTx = database.transaction('encrypted_store', 'readwrite');
  const commitStore = commitTx.objectStore('encrypted_store');
  for (const { storeKey, reEncrypted } of staging) {
    commitStore.put(reEncrypted, storeKey);
  }
  await commitTx.done;

  // ── Phase 3: Upgrade KDF version and activate the new key ───────────────────
  await storeKdfVersion(1);
  await setEncryptionKey(newKey);
}

// ========================
// AUTO-DELETE (30 days)
// ========================

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Called once on app load. Iterates all message stores and removes
 * any message older than 30 days. Runs silently — errors are swallowed.
 */
export async function autoDeleteOldMessages(): Promise<void> {
  try {
    const database = await getDB();
    const tx = database.transaction('encrypted_store', 'readonly');
    const store = tx.objectStore('encrypted_store');
    const allKeys = await store.getAllKeys();
    await tx.done;

    const now = Date.now();
    const messageKeys = (allKeys as string[]).filter(k => k.startsWith('messages:'));

    for (const key of messageKeys) {
      const msgs = await getEncrypted<LocalMessage[]>(key);
      if (!msgs) continue;
      const filtered = msgs.filter(m => now - m.timestamp < THIRTY_DAYS_MS);
      if (filtered.length !== msgs.length) {
        if (filtered.length === 0) {
          await deleteEncrypted(key);
        } else {
          await setEncrypted(key, filtered);
        }
      }
    }
  } catch {
    // Fail silently — never interrupt the user experience
  }
}
