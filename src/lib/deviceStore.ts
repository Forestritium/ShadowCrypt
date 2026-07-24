import { generateUUID } from "@/lib/uuid";
/**
 * Device identity management for SylvaCrypt multi-device support.
 *
 * Each browser/device instance has a stable UUID (stored in localStorage)
 * and its own X25519 key pair (stored encrypted in the vault via localStore).
 *
 * Device key pair vs legacy user identity key pair:
 *   - Legacy: `identity_keypair` — kept for backward-compat single-device sessions.
 *   - Device:  `device_keypair`  — the per-device key used for all new multi-device sessions.
 *   On first login after this migration, the device key is seeded from the identity key so
 *   existing ratchet sessions remain valid.
 *
 * Ghost device prevention:
 *   Clearing browser history wipes localStorage, causing getOrCreateDeviceId() to
 *   generate a fresh UUID and register a new device row — even though it's the same
 *   physical browser. Over time this accumulates ghost rows that break message delivery
 *   (sender encrypts for all rows; receiver only matches the newest UUID).
 *
 *   Fix: storeEncryptedDeviceKeyPair() persists an AES-256-GCM blob in the
 *   user_devices row after first registration. On the next login, if localStorage
 *   is empty, recoverDeviceFromSupabase() fetches all approved device rows and
 *   tries to decrypt each blob with the current vault key. The row that decrypts
 *   successfully is the user's existing device — its UUID and key pair are
 *   restored, and no new row is created.
 */

import { supabase } from '@/db/supabase';
import { generateX25519KeyPair, encryptObject, decryptObject } from './crypto';
import { getDeviceKeyPair, saveDeviceKeyPair, getEncryptionKey } from './localStore';

export type { DeviceKeyPair } from './localStore';

// ─── Device ID (stable UUID, stored unencrypted in localStorage) ─────────────


const DEVICE_ID_KEY = 'sc_device_id';

/**
 * Returns the stable device UUID for this browser instance.
 * Generates and persists a new one if not yet set.
 */
export function getOrCreateDeviceId(): string {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = generateUUID();
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

/** Return the device ID only if it already exists (no creation). */
export function getDeviceId(): string | null {
  return localStorage.getItem(DEVICE_ID_KEY);
}

// ─── Device key pair bootstrap ───────────────────────────────────────────────

/**
 * Ensure the device key pair exists in the vault.
 * Seeds it from the legacy identity key pair so existing ratchet sessions stay valid.
 * If no legacy key is provided, generates a fresh X25519 pair.
 */
export async function ensureDeviceKeyPair(
  legacyKP?: { privateKeyBase64: string; publicKeyBase64: string } | null
): Promise<{ privateKeyBase64: string; publicKeyBase64: string }> {
  const existing = await getDeviceKeyPair();
  if (existing) return existing;

  const kp = legacyKP
    ? { privateKeyBase64: legacyKP.privateKeyBase64, publicKeyBase64: legacyKP.publicKeyBase64 }
    : generateX25519KeyPair();

  await saveDeviceKeyPair(kp);
  return kp;
}

// Re-export for convenience so callers only need to import from deviceStore
export { getDeviceKeyPair, saveDeviceKeyPair };

// ─── Ghost device prevention: encrypted keypair recovery ─────────────────────

type DeviceKP = { privateKeyBase64: string; publicKeyBase64: string };

/**
 * Persist an AES-256-GCM blob of the device key pair into the user_devices row
 * immediately after a successful device registration. This is the write half of
 * the ghost-device-prevention mechanism.
 *
 * @param deviceId  The stable device UUID (device_id column, not the PK id).
 * @param keyPair   The device key pair to encrypt and store.
 */
export async function storeEncryptedDeviceKeyPair(
  deviceId: string,
  keyPair: DeviceKP,
): Promise<void> {
  const vaultKey = getEncryptionKey();
  if (!vaultKey) return; // vault not unlocked — skip silently
  try {
    const encrypted = await encryptObject(vaultKey, keyPair);
    await supabase
      .from('user_devices')
      .update({ encrypted_device_keypair: encrypted })
      .eq('device_id', deviceId);
  } catch (err) {
    console.warn('[SylvaCrypt] storeEncryptedDeviceKeyPair failed (non-fatal):', err);
  }
}

/**
 * Recovery path: if localStorage was cleared (browser history wipe, site-data
 * clear), attempt to recover the existing device identity from Supabase instead
 * of registering a new ghost device row.
 *
 * Iterates over all approved device rows for the user (newest first). For each
 * row that has a stored blob, tries to decrypt it with the current vault key.
 * The row whose blob decrypts successfully is the user's existing device on this
 * machine — its UUID and key pair are restored into localStorage and the vault.
 *
 * Only runs when localStorage has no sc_device_id entry (i.e. was cleared).
 * Returns null when localStorage is intact (no-op fast path).
 *
 * @param userId  The authenticated Supabase user ID.
 */
export async function recoverDeviceFromSupabase(
  userId: string,
): Promise<{ deviceId: string; keyPair: DeviceKP } | null> {
  // Fast path: localStorage is intact — no recovery needed.
  if (localStorage.getItem(DEVICE_ID_KEY)) return null;

  const vaultKey = getEncryptionKey();
  if (!vaultKey) return null; // vault not yet unlocked — cannot decrypt

  const { data: devices } = await supabase
    .from('user_devices')
    .select('device_id, encrypted_device_keypair')
    .eq('user_id', userId)
    .eq('approved', true)
    .order('last_seen_at', { ascending: false });

  for (const row of devices ?? []) {
    if (!row.encrypted_device_keypair) continue;
    try {
      const kp = await decryptObject<DeviceKP>(vaultKey, row.encrypted_device_keypair as string);
      // Decryption succeeded — this row belongs to the current device.
      localStorage.setItem(DEVICE_ID_KEY, row.device_id as string);
      await saveDeviceKeyPair(kp);
      console.info('[SylvaCrypt] Device identity recovered from Supabase (localStorage was cleared).');
      return { deviceId: row.device_id as string, keyPair: kp };
    } catch {
      // Wrong vault key for this row (different device) — try next.
    }
  }
  return null; // Genuinely a new device — caller will register a fresh one.
}

/**
 * Prune ghost device rows created by repeated localStorage clears.
 * Keeps the most-recently-seen row for each unique public key and deletes the rest.
 * Called fire-and-forget after every login; message delivery continues regardless.
 *
 * @param userId  The authenticated Supabase user ID.
 */
export async function pruneGhostDevices(userId: string): Promise<void> {
  const { data: devices } = await supabase
    .from('user_devices')
    .select('id, public_key')
    .eq('user_id', userId)
    .order('last_seen_at', { ascending: false });

  if (!devices || devices.length <= 1) return;

  const seen = new Set<string>();
  const toDelete: string[] = [];

  for (const row of devices) {
    const pk = row.public_key as string;
    if (seen.has(pk)) {
      toDelete.push(row.id as string);
    } else {
      seen.add(pk);
    }
  }

  if (toDelete.length > 0) {
    await supabase.from('user_devices').delete().in('id', toDelete);
    console.info(`[SylvaCrypt] Pruned ${toDelete.length} ghost device row(s).`);
  }
}

// ─── Device name detection ────────────────────────────────────────────────────

/** Derive a human-readable device name from the User-Agent string. */
export function detectDeviceName(): string {
  const ua = navigator.userAgent;
  let browser = 'Browser';
  let os = 'Unknown OS';

  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/OPR\//.test(ua)) browser = 'Opera';
  else if (/Chrome\//.test(ua)) browser = 'Chrome';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Safari\//.test(ua) && !/Chrome/.test(ua)) browser = 'Safari';

  if (/iPhone|iPad/.test(ua)) os = 'iOS';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/Windows/.test(ua)) os = 'Windows';
  else if (/Mac OS X/.test(ua)) os = 'macOS';
  else if (/Linux/.test(ua)) os = 'Linux';

  return `${browser} on ${os}`;
}
