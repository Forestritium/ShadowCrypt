/**
 * Local encrypted storage using IndexedDB.
 * All data is encrypted with AES-256-GCM before being stored.
 * The encryption key is derived from the user's password.
 * 
 * This simulates SQLCipher-style full-database encryption.
 */

import { openDB, IDBPDatabase } from 'idb';
import { encryptObject, decryptObject } from './crypto';
import type { Contact, Group, LocalMessage, RatchetSession } from '@/types/types';

const DB_NAME = 'shadowcrypt_local';
const DB_VERSION = 1;

type LocalDB = IDBPDatabase<unknown>;

let db: LocalDB | null = null;
let encryptionKey: CryptoKey | null = null;

// Initialize the database
async function getDB(): Promise<LocalDB> {
  if (!db) {
    db = await openDB(DB_NAME, DB_VERSION, {
      upgrade(database) {
        // Encrypted blobs store — key is a namespaced identifier
        if (!database.objectStoreNames.contains('encrypted_store')) {
          database.createObjectStore('encrypted_store');
        }
      },
    });
  }
  return db;
}

// Set the encryption key (called after successful login)
// Also persists it to sessionStorage so page reloads within the same tab restore it.
export async function setEncryptionKey(key: CryptoKey): Promise<void> {
  encryptionKey = key;
  try {
    const raw = await crypto.subtle.exportKey('raw', key);
    sessionStorage.setItem('sc_vault_key', btoa(String.fromCharCode(...new Uint8Array(raw))));
  } catch { /* ignore */ }
}

// Clear the encryption key (called on logout)
export function clearEncryptionKey(): void {
  encryptionKey = null;
  try {
    sessionStorage.removeItem('sc_vault_key');
    sessionStorage.removeItem('sc_session_info');
  } catch { /* ignore */ }
}

/**
 * Attempt to restore the vault encryption key from sessionStorage.
 * Returns true if successfully restored, false if not available.
 * Called on app load when Supabase session already exists.
 */
export async function restoreVaultKey(): Promise<boolean> {
  if (encryptionKey) return true; // Already loaded
  try {
    const stored = sessionStorage.getItem('sc_vault_key');
    if (!stored) return false;
    const raw = Uint8Array.from(atob(stored), c => c.charCodeAt(0));
    const key = await crypto.subtle.importKey(
      'raw', raw,
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt']
    );
    encryptionKey = key;
    return true;
  } catch {
    return false;
  }
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

// Generic encrypted get/set
async function getEncrypted<T>(storeKey: string): Promise<T | null> {
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

async function setEncrypted<T>(storeKey: string, value: T): Promise<void> {
  const key = requireKey();
  const database = await getDB();
  const encrypted = await encryptObject(key, value);
  await database.put('encrypted_store', encrypted, storeKey);
}

async function deleteEncrypted(storeKey: string): Promise<void> {
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
  return getEncrypted<RatchetSession>(`ratchet:${conversationId}`);
}

export async function saveRatchetSession(session: RatchetSession): Promise<void> {
  await setEncrypted(`ratchet:${session.conversationId}`, session);
}

/** Delete the ratchet session for a conversation (forces fresh re-initialization). */
export async function deleteRatchetSession(conversationId: string): Promise<void> {
  await deleteEncrypted(`ratchet:${conversationId}`);
}

// ========================
// IDENTITY KEYS
// ========================

interface IdentityKeyPair {
  privateKeyBase64: string;
  publicKeyBase64: string;
}

export async function getIdentityKeyPair(): Promise<IdentityKeyPair | null> {
  return getEncrypted<IdentityKeyPair>('identity_keypair');
}

export async function saveIdentityKeyPair(kp: IdentityKeyPair): Promise<void> {
  await setEncrypted('identity_keypair', kp);
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

/** Store the BIP-39 recovery mnemonic encrypted in the vault. */
export async function storeMnemonic(mnemonic: string): Promise<void> {
  await setEncrypted('identity_mnemonic', mnemonic);
}

/** Retrieve the stored recovery mnemonic from the vault. */
export async function getMnemonic(): Promise<string | null> {
  return getEncrypted<string>('identity_mnemonic');
}

/** Delete the stored mnemonic (called before regenerating a new one). */
export async function deleteMnemonic(): Promise<void> {
  await deleteEncrypted('identity_mnemonic');
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

  const { deriveVaultKey } = await import('./crypto');
  const newKey = await deriveVaultKey(newPassword, salt, 1);

  // Read ALL encrypted entries (except salt & metadata), decrypt with old key, re-encrypt with new key
  const database = await getDB();
  const tx = database.transaction('encrypted_store', 'readonly');
  const store = tx.objectStore('encrypted_store');
  const allKeys = (await store.getAllKeys()) as string[];
  await tx.done;

  const { encryptObject, decryptObject } = await import('./crypto');

  for (const storeKey of allKeys) {
    if (storeKey === '__salt__' || storeKey === '__kdf_version__') continue;
    const encrypted = await database.get('encrypted_store', storeKey);
    if (!encrypted || typeof encrypted !== 'string') continue;
    try {
      const plaintext = await decryptObject<unknown>(oldKey, encrypted);
      const reEncrypted = await encryptObject(newKey, plaintext);
      await database.put('encrypted_store', reEncrypted, storeKey);
    } catch {
      // Skip entries that fail to decrypt — they may be stale or corrupted
    }
  }

  // Upgrade KDF version and switch active key
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
