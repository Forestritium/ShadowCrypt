import { generateUUID } from "@/lib/uuid";
/**
 * Relay messaging service: uses Supabase Realtime as a zero-knowledge relay.
 * Messages are encrypted client-side BEFORE being sent.
 * The server only sees opaque ciphertext and routes it to the recipient.
 * Messages are deleted from the relay table after delivery.
 *
 * v5.1.58: QR contact exchange, safety number fingerprint, reaction fix, device cap, relay cascade cleanup
 * When sending, the message is encrypted separately for every approved device
 * of the recipient (one relay row per target device).  The ratchet session key
 * includes the remote device ID so that each device pair has an independent
 * Double Ratchet state.
 * Backward compat: messages without sender/recipient_device_id are processed
 * by all devices of the recipient exactly as before (legacy path).
 */

import { supabase } from '@/db/supabase';
import { toBase64, computeFingerprint } from '@/lib/crypto';
import type { EncryptedEnvelope, RelayMessage, Contact, ContactRequest, UserDevice, KeyChangeAlert, X3DHInit, RatchetSession } from '@/types/types';
import {
  initSessionSender,
  initSessionReceiver,
  ratchetEncrypt,
  ratchetDecrypt,
} from './doubleRatchet';
import {
  getRatchetSession,
  saveRatchetSession,
  deleteRatchetSession,
  getIdentityKeyPair,
  getLastKnownSenderIdk,
  setLastKnownSenderIdk,
  deleteLastKnownSenderIdk,
} from './localStore';

import { getCurrentSession } from './session';
import { fetchPrekeyBundle, x3dhSenderSetup, initRatchetFromX3DH, createSealedSenderBox, openSealedSenderBox, x3dhReceiverSetupFull, consumeOPKPrivate } from './x3dh';
import { getEncrypted } from './localStore';
import { getDeviceKeyPair } from './deviceStore';
import { saveMessageToDBFull, updateContactPublicKey, updateMessageContentInDB, markMessageDeletedForEveryoneInDB } from './dbStore';
import { encryptPushPayload } from './pushCrypto';
import type { LocalMessage } from '@/types/types';

let _cachedIdentityKP: any = undefined;
let _cachedDeviceKP: any = undefined;

export function clearRelayCache(): void {
  _cachedIdentityKP = undefined;
  _cachedDeviceKP = undefined;
}

async function getIdentityKeyPairCached() {
  if (_cachedIdentityKP !== undefined) return _cachedIdentityKP;
  _cachedIdentityKP = await getIdentityKeyPair();
  return _cachedIdentityKP;
}

async function getDeviceKeyPairCached() {
  if (_cachedDeviceKP !== undefined) return _cachedDeviceKP;
  _cachedDeviceKP = await getDeviceKeyPair();
  return _cachedDeviceKP;
}

// ─── File attachment rate-limit helpers ───────────────────────────────────────

export const FILE_DAILY_LIMIT_BYTES = 62_914_560; // 60 MB

/** Returns total file bytes uploaded today by the user. */
export async function getTodayFileBytes(userId: string): Promise<number> {
  const { data, error } = await supabase.rpc('get_file_send_bytes', { p_user_id: userId });
  if (error) return 0;
  return (data as number) ?? 0;
}

/** Thrown when the user has exhausted their 60 MB/day file allowance. */
export class FileLimitError extends Error {
  resetAt: Date;
  remainingBytes: number;
  constructor(resetAt: Date, remainingBytes: number) {
    super('Daily file limit reached');
    this.name = 'FileLimitError';
    this.resetAt = resetAt;
    this.remainingBytes = remainingBytes;
  }
}

/** Returns today's image send count for the user. */
export async function getTodayImageCount(userId: string): Promise<number> {
  const { data, error } = await supabase.rpc('get_image_send_count', { p_user_id: userId });
  if (error) return 0;
  return (data as number) ?? 0;
}

// ─── Voice message rate-limit helpers ────────────────────────────────────────

export const VOICE_DAILY_LIMIT_SECONDS = 600; // 10 minutes

/** Returns total voice seconds sent today by the user. */
export async function getTodayVoiceDuration(userId: string): Promise<number> {
  const { data, error } = await supabase.rpc('get_voice_send_duration', { p_user_id: userId });
  if (error) return 0;
  return (data as number) ?? 0;
}

/** Thrown when the user has exhausted their 10 minutes/day voice allowance. */
export class VoiceLimitError extends Error {
  resetAt: Date;
  remainingSeconds: number;
  constructor(resetAt: Date, remainingSeconds: number) {
    super('Daily voice limit reached');
    this.name = 'VoiceLimitError';
    this.resetAt = resetAt;
    this.remainingSeconds = remainingSeconds;
  }
}

/**
 * Upload an image file to Supabase Storage and return its public URL.
 * Throws an ImageLimitError if the user has hit their daily 10-image cap.
 */
export class ImageLimitError extends Error {
  resetAt: Date;
  constructor(resetAt: Date) {
    super('Daily image limit reached');
    this.name = 'ImageLimitError';
    this.resetAt = resetAt;
  }
}

/**
 * Encrypt a File with AES-256-GCM using a fresh random key.
 * Returns the ciphertext Blob and the base64-encoded key.
 * Format: 12-byte IV prepended to the ciphertext (same as encryptObject).
 */
async function encryptFileAESGCM(file: File): Promise<{ blob: Blob; keyBase64: string }> {
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  const cryptoKey = await crypto.subtle.importKey(
    'raw', rawKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt']
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plainbuf = await file.arrayBuffer();
  const cipherbuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, plainbuf);

  // Prepend IV so the recipient can extract it: [12 bytes IV][ciphertext]
  const combined = new Uint8Array(12 + cipherbuf.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(cipherbuf), 12);

  const keyBase64 = toBase64(rawKey);
  return { blob: new Blob([combined], { type: 'application/octet-stream' }), keyBase64 };
}

/**
 * Decrypt an AES-256-GCM ciphertext blob fetched from Supabase Storage.
 * Expects the blob to start with a 12-byte IV followed by the ciphertext.
 * Returns the decrypted bytes as an ArrayBuffer.
 */
async function decryptBlobAESGCM(blob: Blob, keyBase64: string): Promise<ArrayBuffer> {
  const raw = Uint8Array.from(atob(keyBase64), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    'raw', raw, { name: 'AES-GCM', length: 256 }, false, ['decrypt']
  );
  const combined = new Uint8Array(await blob.arrayBuffer());
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, cryptoKey, ciphertext);
}

/**
 * Upload an image to Supabase Storage as AES-256-GCM ciphertext.
 * Atomically checks and increments the daily 10-image cap via
 * try_increment_image_send_count RPC before upload — prevents TOCTOU race
 * where two concurrent uploads both pass a read-then-check limit.
 */
export async function uploadChatImage(
  userId: string,
  file: File
): Promise<{ storagePath: string; imageKeyBase64: string }> {
  // Atomic check-and-increment: returns false if limit already reached
  const reset = new Date();
  reset.setUTCHours(24, 0, 0, 0);

  const { data: allowed, error: rlErr } = await supabase.rpc('try_increment_image_send_count', { p_user_id: userId });
  if (rlErr) throw new Error(`Rate-limit check failed: ${rlErr.message}`);
  if (!allowed) throw new ImageLimitError(reset);

  const { blob: ciphertextBlob, keyBase64 } = await encryptFileAESGCM(file);

  const storagePath = `${userId}/${generateUUID()}.enc`;
  const { error: uploadErr } = await supabase.storage
    .from('chat-images')
    .upload(storagePath, ciphertextBlob, { contentType: 'application/octet-stream', upsert: false });
  if (uploadErr) throw new Error(`Image upload failed: ${uploadErr.message}`);

  return { storagePath, imageKeyBase64: keyBase64 };
}

/**
 * Fetch an encrypted image blob from Supabase Storage via a short-lived signed URL,
 * decrypt it with the provided AES-256-GCM key, and return an object URL for display.
 * The caller is responsible for calling URL.revokeObjectURL() when done.
 */
export async function fetchAndDecryptChatImage(
  storagePath: string,
  imageKeyBase64: string
): Promise<string> {
  // Create a signed URL valid for 1 hour — no public CDN exposure
  const { data: signedData, error: signErr } = await supabase.storage
    .from('chat-images')
    .createSignedUrl(storagePath, 300);
  if (signErr || !signedData?.signedUrl) throw new Error('Failed to create signed URL');

  const response = await fetch(signedData.signedUrl);
  if (!response.ok) throw new Error(`Failed to fetch encrypted image: ${response.status}`);
  const ciphertextBlob = await response.blob();

  const plainbuf = await decryptBlobAESGCM(ciphertextBlob, imageKeyBase64);
  return URL.createObjectURL(new Blob([plainbuf]));
}

/**
 * Upload a voice recording blob to Supabase Storage as AES-256-GCM ciphertext.
 * Atomically checks and increments the daily 10-minute cap via
 * try_increment_voice_send_duration RPC before upload — prevents TOCTOU race.
 */
export async function uploadVoiceMessage(
  userId: string,
  blob: Blob,
  durationSeconds: number,
  mimeType: string
): Promise<{ storagePath: string; voiceKeyBase64: string; voiceDuration: number }> {
  const reset = new Date();
  reset.setUTCHours(24, 0, 0, 0);

  const { data: allowed, error: rlErr } = await supabase.rpc('try_increment_voice_send_duration', {
    p_user_id: userId,
    p_seconds: Math.ceil(durationSeconds),
  });
  if (rlErr) throw new Error(`Rate-limit check failed: ${rlErr.message}`);
  if (!allowed) {
    const usedSeconds = await getTodayVoiceDuration(userId);
    const remaining = Math.max(0, VOICE_DAILY_LIMIT_SECONDS - usedSeconds);
    throw new VoiceLimitError(reset, remaining);
  }

  const file = new File([blob], 'voice.webm', { type: mimeType });
  const { blob: ciphertextBlob, keyBase64 } = await encryptFileAESGCM(file);

  const storagePath = `${userId}/${generateUUID()}.enc`;
  const { error: uploadErr } = await supabase.storage
    .from('chat-voices')
    .upload(storagePath, ciphertextBlob, { contentType: 'application/octet-stream', upsert: false });
  if (uploadErr) throw new Error(`Voice upload failed: ${uploadErr.message}`);

  return { storagePath, voiceKeyBase64: keyBase64, voiceDuration: durationSeconds };
}

/**
 * Upload any file to Supabase Storage as AES-256-GCM ciphertext.
 * Atomically checks and increments the daily 60 MB cap via
 * try_increment_file_send_bytes RPC before upload — prevents TOCTOU race.
 */
export async function uploadChatFile(
  userId: string,
  file: File
): Promise<{ storagePath: string; fileKeyBase64: string; fileName: string; fileSize: number; fileMimeType: string }> {
  const reset = new Date();
  reset.setUTCHours(24, 0, 0, 0);

  const { data: allowed, error: rlErr } = await supabase.rpc('try_increment_file_send_bytes', {
    p_user_id: userId,
    p_bytes: file.size,
  });
  if (rlErr) throw new Error(`Rate-limit check failed: ${rlErr.message}`);
  if (!allowed) {
    const usedBytes = await getTodayFileBytes(userId);
    const remaining = Math.max(0, FILE_DAILY_LIMIT_BYTES - usedBytes);
    throw new FileLimitError(reset, remaining);
  }

  const { blob: ciphertextBlob, keyBase64 } = await encryptFileAESGCM(file);

  const storagePath = `${userId}/${generateUUID()}.enc`;
  const { error: uploadErr } = await supabase.storage
    .from('chat-files')
    .upload(storagePath, ciphertextBlob, { contentType: 'application/octet-stream', upsert: false });
  if (uploadErr) throw new Error(`File upload failed: ${uploadErr.message}`);

  return {
    storagePath,
    fileKeyBase64: keyBase64,
    fileName: file.name.trim().slice(0, 255),
    fileSize: file.size,
    fileMimeType: file.type || 'application/octet-stream',
  };
}

/**
 * Fetch an encrypted file blob from Supabase Storage via a short-lived signed URL,
 * decrypt with AES-256-GCM, and return an object URL for download.
 * The caller is responsible for calling URL.revokeObjectURL() when done.
 */
export async function fetchAndDecryptChatFile(
  storagePath: string,
  fileKeyBase64: string,
  mimeType: string
): Promise<string> {
  const { data: signedData, error: signErr } = await supabase.storage
    .from('chat-files')
    .createSignedUrl(storagePath, 300);
  if (signErr || !signedData?.signedUrl) throw new Error('Failed to create signed URL for file');

  const response = await fetch(signedData.signedUrl);
  if (!response.ok) throw new Error(`Failed to fetch encrypted file: ${response.status}`);
  const ciphertextBlob = await response.blob();

  const plainbuf = await decryptBlobAESGCM(ciphertextBlob, fileKeyBase64);
  return URL.createObjectURL(new Blob([plainbuf], { type: mimeType || 'application/octet-stream' }));
}

/**
 * Fetch an encrypted voice blob from Supabase Storage via a short-lived signed URL,
 * decrypt it with the provided AES-256-GCM key, and return an object URL for playback.
 * The caller is responsible for calling URL.revokeObjectURL() when done.
 */
export async function fetchAndDecryptVoiceMessage(
  storagePath: string,
  voiceKeyBase64: string
): Promise<string> {
  const { data: signedData, error: signErr } = await supabase.storage
    .from('chat-voices')
    .createSignedUrl(storagePath, 300);
  if (signErr || !signedData?.signedUrl) throw new Error('Failed to create signed URL for voice');

  const response = await fetch(signedData.signedUrl);
  if (!response.ok) throw new Error(`Failed to fetch encrypted voice: ${response.status}`);
  const ciphertextBlob = await response.blob();

  const plainbuf = await decryptBlobAESGCM(ciphertextBlob, voiceKeyBase64);
  return URL.createObjectURL(new Blob([plainbuf], { type: 'audio/webm' }));
}

// Send an encrypted message to a recipient
// ─── Device registry ─────────────────────────────────────────────────────────

/**
 * Register (or upsert) a device in the user_devices table.
 * - First device for a user → primary + auto-approved.
 * - Subsequent devices → pending approval by primary.
 * Called automatically from unlockSession on every login.
 */
export async function registerDevice(
  userId: string,
  deviceId: string,
  publicKey: string,
  deviceName: string
): Promise<UserDevice> {
  // Check if this specific device is already registered
  const { data: existing } = await supabase
    .from('user_devices')
    .select('*')
    .eq('user_id', userId)
    .eq('device_id', deviceId)
    .maybeSingle();

  if (existing) {
    // Already registered — just refresh last_seen_at
    const { data: updated } = await supabase
      .from('user_devices')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', existing.id)
      .select()
      .single();
    return (updated ?? existing) as UserDevice;
  }

  // Check how many devices this user already has
  const { count } = await supabase
    .from('user_devices')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId);

  const isPrimary = (count ?? 0) === 0;
  const isApproved = isPrimary; // primary is self-approved; secondary needs explicit approval

  const { data, error } = await supabase
    .from('user_devices')
    .insert({
      user_id: userId,
      device_id: deviceId,
      device_name: deviceName,
      public_key: publicKey,
      is_primary: isPrimary,
      approved: isApproved,
    })
    .select()
    .single();

  if (error) throw new Error(`Device registration failed: ${error.message}`);
  return data as UserDevice;
}

/** Fetch all approved devices for a given user (used before encrypting messages). */
export async function fetchApprovedDevices(userId: string): Promise<UserDevice[]> {
  const { data, error } = await supabase
    .from('user_devices')
    .select('*')
    .eq('user_id', userId)
    .eq('approved', true)
    .order('added_at', { ascending: true });
  if (error) {
    console.warn('[SylvaCrypt] fetchApprovedDevices error:', error.message);
    return [];
  }
  return (data ?? []) as UserDevice[];
}

// ─── Performance helpers ──────────────────────────────────────────────────────

/**
 * Refresh the Supabase JWT only when the token is within 60 seconds of
 * expiry.  getSession() is served from the in-memory cache (no network call)
 * so the check itself is free.  autoRefreshToken:true in supabase.ts already
 * proactively refreshes well before expiry, so this guard fires only in edge
 * cases (very long idle sessions, clock skew).  Skipping the unconditional
 * refreshSession() saves ~200–400 ms on every send.
 */
async function refreshSessionIfNeeded(): Promise<void> {
  const { data: { session } } = await supabase.auth.getSession();
  const secsLeft = (session?.expires_at ?? 0) - Math.floor(Date.now() / 1000);
  if (secsLeft < 60) {
    await supabase.auth.refreshSession().catch(() => {});
  }
}

/** In-memory cache for approved device lists.  Device lists change rarely
 *  (only on add/remove linked device) so a 30-second TTL is safe and avoids
 *  a Supabase round-trip (~150–300 ms) on every message sent. */
const _deviceCache = new Map<string, { devices: UserDevice[]; ts: number }>();
const DEVICE_CACHE_TTL_MS = 120_000;

async function fetchApprovedDevicesCached(userId: string): Promise<UserDevice[]> {
  const cached = _deviceCache.get(userId);
  if (cached && Date.now() - cached.ts < DEVICE_CACHE_TTL_MS) return cached.devices;
  const devices = await fetchApprovedDevices(userId);
  _deviceCache.set(userId, { devices, ts: Date.now() });
  return devices;
}

/** Invalidate the device cache for a user (call after adding/removing a device). */
export function invalidateDeviceCache(userId: string): void {
  _deviceCache.delete(userId);
}

/** Fetch ALL devices for the current user (own account, includes pending). */
export async function fetchMyDevices(userId: string): Promise<UserDevice[]> {
  const { data, error } = await supabase
    .from('user_devices')
    .select('*')
    .eq('user_id', userId)
    .order('added_at', { ascending: true });
  if (error) return [];
  return (data ?? []) as UserDevice[];
}

/**
 * Approve a pending device.
 *
 * Calls the approve_device() SECURITY DEFINER DB function instead of a direct
 * UPDATE so that the primary-device check is enforced at the DB level:
 *   - The function verifies auth.uid() has an is_primary=TRUE+approved=TRUE row
 *   - The tightened RLS UPDATE policy blocks direct approved=true flips
 * This means a JWT-compromised session cannot self-approve a rogue device.
 */
export async function approveDevice(deviceRowId: string): Promise<void> {
  const { error } = await supabase.rpc('approve_device', { p_device_row_id: deviceRowId });
  if (error) throw new Error(`Approve device failed: ${error.message}`);
  
  const { data } = await supabase.auth.getUser();
  if (data.user) invalidateDeviceCache(data.user.id);
}

/**
 * Remove a linked device. The device will no longer receive messages.
 * Callers should also clear ratchet sessions for that device locally.
 */
export async function removeLinkedDevice(deviceRowId: string): Promise<void> {
  const { error } = await supabase
    .from('user_devices')
    .delete()
    .eq('id', deviceRowId);
  if (error) throw new Error(`Remove device failed: ${error.message}`);

  const { data } = await supabase.auth.getUser();
  if (data.user) invalidateDeviceCache(data.user.id);
}

/**
 * Subscribe to device changes for the current user.
 * The primary device uses this to receive approval-request notifications for new devices.
 */
export function subscribeToDeviceChanges(
  userId: string,
  onChange: (device: UserDevice, event: 'INSERT' | 'UPDATE' | 'DELETE') => void
): () => void {
  const channel = supabase
    .channel(`devices:${userId}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'user_devices', filter: `user_id=eq.${userId}` },
      (payload: any) => onChange((payload as any).new as UserDevice, 'INSERT')
    )
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'user_devices', filter: `user_id=eq.${userId}` },
      (payload: any) => onChange((payload as any).new as UserDevice, 'UPDATE')
    )
    .on(
      'postgres_changes',
      { event: 'DELETE', schema: 'public', table: 'user_devices', filter: `user_id=eq.${userId}` },
      (payload: any) => onChange((payload as any).old as UserDevice, 'DELETE')
    )
    .subscribe();
  return () => { supabase.removeChannel(channel); };
}

export async function sendEncryptedMessage(
  senderId: string,
  senderUsername: string,
  recipientId: string,
  conversationId: string,
  plaintext: string,
  recipientPublicKey: string,
  messageId?: string,
  imageAttachment?: { storagePath: string; imageKeyBase64: string },
  replyTo?: import('@/types/types').ReplyTo | null,
  voiceAttachment?: { storagePath: string; voiceKeyBase64: string; voiceDuration: number },
  fileAttachment?: { storagePath: string; fileKeyBase64: string; fileName: string; fileSize: number; fileMimeType: string },
  isViewOnce?: boolean,
  ttlSeconds?: number | null
): Promise<LocalMessage> {
  // ── Determine sender device identity ──────────────────────────────────────
  // Prefer the per-device key pair; fall back to the legacy identity key pair
  // for clients that have not yet been migrated (vault not yet containing device_keypair).
  const deviceKP = await getDeviceKeyPairCached();
  const myKP = deviceKP ?? (await getIdentityKeyPairCached());
  if (!myKP) throw new Error('Identity key pair not found. Please re-login.');

  // Retrieve the sender's device ID from session (may be null on legacy clients).
  // Fall back to the stable localStorage value so sender_device_id is never null
  // when currentSession hasn't been populated yet (keep-me-signed-in async path).
  // A null sender_device_id on the relay row causes the receiver to use the
  // bare conversationId as the ratchet session key instead of
  // conversationId:senderDeviceId — a mismatch that breaks decryption.
  
  const session_ = getCurrentSession();
  const myDeviceId = session_?.deviceId ?? localStorage.getItem('sc_device_id');

  if (!navigator.onLine) {
    throw new Error('offline');
  }

  // ── Refresh the Supabase JWT before any DB writes (only if nearly expired) ──
  // relay_messages INSERT has RLS `WITH CHECK (auth.uid() = sender_id)`.
  // When the JWT has expired auth.uid() returns NULL, the check fails with a
  // 42501 RLS error, and the caller sees "Failed to send."  autoRefreshToken
  // in supabase.ts already proactively refreshes well before expiry, so the
  // unconditional refreshSession() call previously here was a ~200-400ms
  // network round-trip wasted on every single message.  We now only refresh
  // when the token is within 60 seconds of expiry.
  await refreshSessionIfNeeded();

  // ── Guard against null / stale recipient public key ───────────────────────
  // The contacts table may carry a null or empty public_key if the contact's
  // profile row did not exist when the contact relationship was established
  // (handle_new_user trigger failure).  Fetch a fresh key from the DB before
  // attempting DH so we never silently feed a zero-length key to x25519.
  let resolvedRecipientPublicKey = recipientPublicKey;
  if (!resolvedRecipientPublicKey) {
    const liveKey = await getUserPublicKey(recipientId);
    if (!liveKey) throw new Error("Contact hasn't set up encryption keys yet. Ask them to log in first.");
    resolvedRecipientPublicKey = liveKey;
    // Persist the key so future sends don't repeat the DB round-trip
    await updateContactPublicKey(senderId, recipientId, liveKey).catch(() => {});
  }

  // ── Fetch all approved recipient devices ───────────────────────────────────
  // If the recipient has registered devices, we encrypt once per device so
  // every linked device can independently decrypt with its own ratchet session.
  // Fall back to the single legacy key when no devices are registered.
  const recipientDevices = await fetchApprovedDevicesCached(recipientId);

  // Build target list: [{deviceId, publicKey}].
  // publicKey = the device's registered public key, used ONLY for:
  //   (a) recipient_device_id routing (which device to deliver to), and
  //   (b) legacy single-DH fallback when no X3DH prekey bundle exists.
  // It is NOT the key used for the Double Ratchet init when X3DH is available —
  // that role belongs exclusively to bundle.ik_pub (the identity key). See the
  // X3DH init block below where effectivePubKey is overridden to bundle.ik_pub.
  type TargetDevice = { deviceId: string | null; publicKey: string };
  let targets: TargetDevice[];
  if (recipientDevices.length === 0) {
    targets = [{ deviceId: null, publicKey: resolvedRecipientPublicKey }];
  } else {
    targets = recipientDevices.map(d => ({
      deviceId: d.device_id,
      publicKey: d.public_key,   // device key — routing + legacy DH only
    }));
  }

  // ── Build the ratchet plaintext (same for all devices) ────────────────────
  // v:2 = image; v:3 = voice; v:4 = file.  Plain text stays as a bare string.
  let ratchetPlaintext = plaintext;
  if (fileAttachment) {
    ratchetPlaintext = JSON.stringify({
      v: 4, t: plaintext,
      fsp: fileAttachment.storagePath, fk: fileAttachment.fileKeyBase64,
      fn: fileAttachment.fileName, fs: fileAttachment.fileSize, ft: fileAttachment.fileMimeType,
    });
  } else if (voiceAttachment) {
    ratchetPlaintext = JSON.stringify({
      v: 3, t: plaintext,
      vsp: voiceAttachment.storagePath, vk: voiceAttachment.voiceKeyBase64,
      vd: voiceAttachment.voiceDuration,
    });
  } else if (imageAttachment) {
    ratchetPlaintext = JSON.stringify({
      v: 2, t: plaintext,
      isp: imageAttachment.storagePath, ik: imageAttachment.imageKeyBase64,
    });
  }

  const extras: Record<string, unknown> = {};
  if (replyTo) extras.replyTo = replyTo;
  if (isViewOnce) extras.viewOnce = true;
  if (ttlSeconds && ttlSeconds > 0) extras.ttlSeconds = ttlSeconds;

  // ── Encrypt and insert one relay row per target device ────────────────────
  // Sequential (not concurrent) to avoid a last-write-wins race on
  // saveRatchetSession: each device has an independent sessionKey, but a
  // concurrent send of two messages would interleave IDB reads/writes for the
  // SAME sessionKey — the second read sees stale state, both advance it
  // independently, last write wins, and the receiver gets two messages
  // encrypted with the same chain state (same message key → second decrypt fails).
  const sharedMsgId = messageId ?? generateUUID();

  // Accumulate rows for a single batch insert to minimize network latency
  const relayRows: any[] = [];

  for (const target of targets) {
    // Session key includes the remote device ID so each device pair has an
    // independent Double Ratchet state.
    const sessionKey = target.deviceId
      ? `${conversationId}:${target.deviceId}`
      : conversationId;

    let ratchetSession = await getRatchetSession(sessionKey);
    let effectivePubKey = target.publicKey;

    // ── Stale-session guard ────────────────────────────────────────────────
    // If our identity key changed since this session was created (e.g. vault
    // was re-synced after a profile-PATCH failure), the receiver can no longer
    // follow the chain derived from the old key.  Clear the session so the next
    // message is a fresh Double Ratchet init.
    //
    // IMPORTANT: only act on a POSITIVE mismatch (storedIdk is non-null AND
    // different from the current key).  A null storedIdk means the record has
    // not been written yet for this session (e.g. first send after the
    // localStorage migration or a fresh install) — in that case we trust the
    // existing session and just populate the record.  Treating null as "stale"
    // used to be intentional for the v325 one-time migration, but now that
    // storedIdk lives in plain localStorage every session starts with null and
    // the old condition would destroy every valid ratchet state on the first
    // send, causing the receiver to receive an incompatible X3DH fresh-init
    // that the legacy retry path cannot decrypt.
    if (ratchetSession) {
      const TTL_MS = 90 * 24 * 60 * 60 * 1000;
      if (ratchetSession.createdAt && Date.now() - ratchetSession.createdAt > TTL_MS) {
        // TTL: Expire sessions older than 90 days to enforce re-keying
        await deleteRatchetSession(sessionKey).catch(() => {});
        await deleteLastKnownSenderIdk(sessionKey).catch(() => {});
        ratchetSession = null;
      } else {
        const storedIdk = await getLastKnownSenderIdk(sessionKey).catch(() => null);
        if (storedIdk && storedIdk !== myKP.publicKeyBase64) {
          // Positive key-change: clear and re-init below.
          await deleteRatchetSession(sessionKey).catch(() => {});
          await deleteLastKnownSenderIdk(sessionKey).catch(() => {});
          ratchetSession = null;
        } else if (!storedIdk) {
          // No record yet — populate without touching the session.
          await setLastKnownSenderIdk(sessionKey, myKP.publicKeyBase64).catch(() => {});
        }
      }
    }

    if (!ratchetSession) {
      // ── X3DH session init (preferred) ──────────────────────────────────────
      // Attempt to fetch the recipient's prekey bundle and run a full X3DH
      // key agreement.  Falls back to the legacy single-DH init when:
      //   (a) the recipient has not published prekeys, or
      //   (b) the X3DH module throws unexpectedly.
      let x3dhInitMeta: X3DHInit | null = null;
      try {
        
        const bundle = await fetchPrekeyBundle(recipientId, target.deviceId);
        if (bundle) {
      // ── SPK-rotation guard ────────────────────────────────────────────
      // (Removed: checking SPK rotation here was dead code because this block
      // only runs when ratchetSession is already null. If the receiver rotated
      // their SPK, they will fail to decrypt our message and their client will
      // reset the session and reply with a fresh X3DH setup, which self-heals.)
          // ── CRITICAL: X3DH sender MUST use the identity private key for
          // IK_A so that DH1 = DH(IK_A, SPK_B) and DH2 = DH(EK_A, IK_B)
          // use identity keys on both sides.  The recipient's prekey bundle
          // always publishes ik_pub = their identity public key, so the
          // receiver will compute DH(IK_B, EK_A) with their identity private
          // key.  If we pass the device key here, DH1 becomes
          // DH(devicePriv_A, SPK_B) while the receiver still uses identity
          // keys → shared-secret mismatch → decrypt failure on the other end.
          
          const identityKP = await getIdentityKeyPairCached();
          const ikPrivForX3DH  = identityKP?.privateKeyBase64  ?? myKP.privateKeyBase64;
          const ikPubForX3DH   = identityKP?.publicKeyBase64   ?? myKP.publicKeyBase64;

          const x3dhResult = await x3dhSenderSetup(ikPrivForX3DH, bundle);

          // ── CRITICAL: use the identity key (bundle.ik_pub) as the DR remote
          // key, NOT the device key stored in target.publicKey.
          //
          // The sender's first Double Ratchet step in initSessionSenderFromSecret:
          //   dhOut = DH(eph_priv, effectivePubKey)
          // The receiver's first DH ratchet step:
          //   dhOut = DH(identity_priv, eph_pub)
          // For X25519 commutativity these are equal only when:
          //   effectivePubKey === identity_pub  (i.e. bundle.ik_pub)
          //
          // Using target.publicKey (the device key) here causes the sender's
          // dhOut to diverge from the receiver's → mismatched chain keys →
          // every message silently fails decryption.
          effectivePubKey = bundle.ik_pub;

          ratchetSession = await initRatchetFromX3DH(
            sessionKey,
            x3dhResult.sessionSecret,
            myKP.privateKeyBase64,
            myKP.publicKeyBase64,
            effectivePubKey,
            true,
          );
          x3dhInitMeta = {
            eph_pub:       x3dhResult.ephemeralPub,
            opk_id:        x3dhResult.opkId,
            kem_ct:        x3dhResult.kemCiphertext,
            sender_ik_pub: ikPubForX3DH,
            spk_id:        bundle.spk_id,
          };
        }
      } catch (x3dhErr) {
        console.warn('[X3DH] Prekey init failed, falling back to legacy DH:', x3dhErr);
        ratchetSession = null;
      }

      // ── Legacy single-DH fallback ─────────────────────────────────────────
      if (!ratchetSession) {
        try {
          ratchetSession = await initSessionSender(sessionKey, myKP.privateKeyBase64, effectivePubKey);
        } catch (err) {
          if ((err as Error).message?.startsWith('LEGACY_KEY_FORMAT')) {
            const freshKey = await getUserPublicKey(recipientId);
            if (!freshKey || freshKey === effectivePubKey) {
              throw new Error(
                'LEGACY_KEY_FORMAT: This contact needs to re-login to update their encryption key before you can message them.'
              );
            }
            await updateContactPublicKey(senderId, recipientId, freshKey);
            effectivePubKey = freshKey;
            ratchetSession = await initSessionSender(sessionKey, myKP.privateKeyBase64, effectivePubKey);
          } else {
            throw err;
          }
        }
      }

      // Record the identity key used to create this session.
      await setLastKnownSenderIdk(sessionKey, myKP.publicKeyBase64).catch(() => {});

      // Persist the SPK ID used for this X3DH session so the rotation guard
      // above can detect when the receiver publishes a new SPK.  Stored in
      // localStorage (small string, low frequency, no sensitive material).
      if (x3dhInitMeta?.spk_id) {
        try { localStorage.setItem(`sc_spk_id_${sessionKey}`, x3dhInitMeta.spk_id); } catch { /* non-fatal */ }
      }

      // ── Sealed-sender certificate ─────────────────────────────────────────
      // Encrypt the sender's identity into a box only the recipient can open.
      // Stored alongside the relay row; the recipient verifies it to confirm
      // sender identity without trusting the plaintext sender_id DB field.
      let sealedSenderBox: string | null = null;
      try {
        const recipientIKPub = effectivePubKey;
        
        const box = await createSealedSenderBox(
          senderId, myKP.privateKeyBase64, myKP.publicKeyBase64, recipientIKPub,
        );
        sealedSenderBox = JSON.stringify(box);
      } catch (sealErr) {
        throw new Error(`[X3DH] Sealed sender box creation failed: ${sealErr instanceof Error ? sealErr.message : String(sealErr)}`);
      }

      // Attach X3DH init metadata and sealed sender cert to the outer payload
      // so the receiver can bootstrap their session and verify sender identity.
      // Both fields go outside the ratchet ciphertext (needed before decrypt).
      (ratchetSession as unknown as { _x3dhMeta: X3DHInit | null; _sealedSenderBox: string | null })
        ._x3dhMeta = x3dhInitMeta;
      (ratchetSession as unknown as { _x3dhMeta: X3DHInit | null; _sealedSenderBox: string | null })
        ._sealedSenderBox = sealedSenderBox;
    }

    const { envelope, updatedSession } = await ratchetEncrypt(ratchetSession, ratchetPlaintext);

    // Extract X3DH and sealed-sender metadata attached during init (first message only)
    const sessionWithMeta = ratchetSession as unknown as {
      _x3dhMeta?: X3DHInit | null;
      _sealedSenderBox?: string | null;
    };
    const x3dhMeta = sessionWithMeta._x3dhMeta ?? null;
    const sealedSenderBox = sessionWithMeta._sealedSenderBox ?? null;
    // Clean up transient fields before persisting
    delete sessionWithMeta._x3dhMeta;
    delete sessionWithMeta._sealedSenderBox;

    await saveRatchetSession(updatedSession);

    // Include the sender's current identity public key as an unencrypted hint
    // (`sik`) in the payload.  The receiver adds it to keysToTry on decrypt
    // failure so a fresh session re-init always uses the exact key that was
    // active when this message was created — even if the profile DB or contact
    // cache is momentarily stale.
    //
    // `mid` (message id) is also included unencrypted so the receiver stores
    // the message under the same UUID the sender used.  This is essential for
    // edit (v5) and delete-for-all (v6) relay notifications which reference the
    // original message by that shared ID.
    //
    // `x3dh` carries the X3DH initialisation metadata on the first message of
    // a new X3DH-bootstrapped session; omitted for all subsequent messages.
    const payload = JSON.stringify({
      ...envelope,
      ...(Object.keys(extras).length ? extras : {}),
      sik: myKP.publicKeyBase64,
      mid: sharedMsgId,
      ...(x3dhMeta ? { x3dh: x3dhMeta } : {}),
    });

    const relayExpiresAt = ttlSeconds
      ? new Date(Date.now() + ttlSeconds * 1000).toISOString()
      : null;
    
    relayRows.push({
      recipient_id:       recipientId,
      sender_id:          senderId,
      conversation_id:    conversationId,
      encrypted_payload:  payload,
      sender_device_id:   myDeviceId,
      recipient_device_id: target.deviceId,
      sender_cert:        sealedSenderBox,
      is_view_once:       isViewOnce ?? false,
      ttl_seconds:        ttlSeconds ?? null,
      expires_at:         relayExpiresAt,
    });
  }

  let finalTimestamp = Date.now();
  if (relayRows.length > 0) {
    const { data, error } = await supabase
      .from('relay_messages')
      .insert(relayRows)
      .select('created_at')
      .limit(1);

    if (error) {
      console.error(`[SylvaCrypt] Relay batch insert failed:`, error.message);
      throw new Error(`Failed to send message: ${error.message}`);
    }
    if (data && data.length > 0 && data[0].created_at) {
      finalTimestamp = new Date(data[0].created_at).getTime();
    }
  }

  const localMsg: LocalMessage = {
    id: sharedMsgId,
    conversationId,
    senderId,
    senderUsername,
    content: plaintext,
    timestamp: finalTimestamp,
    status: 'sent',
    isOwn: true,
    imageUrl: null,
    imageStoragePath: imageAttachment?.storagePath ?? null,
    imageKeyBase64: imageAttachment?.imageKeyBase64 ?? null,
    replyTo: replyTo ?? null,
    voiceStoragePath: voiceAttachment?.storagePath ?? null,
    voiceKeyBase64: voiceAttachment?.voiceKeyBase64 ?? null,
    voiceDuration: voiceAttachment?.voiceDuration ?? null,
    fileStoragePath: fileAttachment?.storagePath ?? null,
    fileKeyBase64: fileAttachment?.fileKeyBase64 ?? null,
    fileName: fileAttachment?.fileName ?? null,
    fileSize: fileAttachment?.fileSize ?? null,
    fileMimeType: fileAttachment?.fileMimeType ?? null,
    isViewOnce: isViewOnce ?? false,
    viewOnceConsumed: false,
    ttlSeconds: ttlSeconds ?? null,
    expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null,
  };

  await saveMessageToDBFull(senderId, recipientId, localMsg);
  return localMsg;
}

// ─── 5-minute edit/delete window (matches UI enforcement) ────────────────────
export const MESSAGE_EDIT_WINDOW_MS = 5 * 60 * 1000;

/**
 * Send an encrypted edit notification (v5) through the Double Ratchet relay.
 * The receiver's `receiveAndDecryptMessage` will detect v5 and update their
 * local copy of the message instead of inserting a new row.
 *
 * Only plain-text message content can be edited (no media re-upload).
 */
export async function sendEditedMessage(
  senderId: string,
  recipientId: string,
  conversationId: string,
  originalMessageId: string,
  newContent: string,
  recipientPublicKey: string
): Promise<void> {
  const deviceKP = await getDeviceKeyPairCached();
  const myKP = deviceKP ?? (await getIdentityKeyPairCached());
  if (!myKP) throw new Error('Identity key pair not found.');

  
  const session_ = getCurrentSession();
  const myDeviceId = session_?.deviceId ?? localStorage.getItem('sc_device_id');

  const recipientDevices = await fetchApprovedDevicesCached(recipientId);
  type TargetDevice = { deviceId: string | null; publicKey: string };
  const targets: TargetDevice[] = recipientDevices.length === 0
    ? [{ deviceId: null, publicKey: recipientPublicKey }]
    : recipientDevices.map(d => ({ deviceId: d.device_id, publicKey: d.public_key }));

  const ratchetPlaintext = JSON.stringify({ v: 5, mid: originalMessageId, t: newContent });

  await refreshSessionIfNeeded();

  const relayRows: any[] = [];
  // Sequential per-device loop — mirrors sendEncryptedMessage (see comment there).
  for (const target of targets) {
    const sessionKey = target.deviceId ? `${conversationId}:${target.deviceId}` : conversationId;

    // ── Stale-session guard (mirrors sendEncryptedMessage) ─────────────────
    let ratchetSession = await getRatchetSession(sessionKey);
    if (ratchetSession) {
      const TTL_MS = 90 * 24 * 60 * 60 * 1000;
      if (ratchetSession.createdAt && Date.now() - ratchetSession.createdAt > TTL_MS) {
        await deleteRatchetSession(sessionKey).catch(() => {});
        await deleteLastKnownSenderIdk(sessionKey).catch(() => {});
        ratchetSession = null;
      } else {
        const storedIdk = await getLastKnownSenderIdk(sessionKey).catch(() => null);
        if (storedIdk && storedIdk !== myKP.publicKeyBase64) {
          await deleteRatchetSession(sessionKey).catch(() => {});
          await deleteLastKnownSenderIdk(sessionKey).catch(() => {});
          ratchetSession = null;
        } else if (!storedIdk) {
          await setLastKnownSenderIdk(sessionKey, myKP.publicKeyBase64).catch(() => {});
        }
      }
    }
    if (!ratchetSession) {
      ratchetSession = await initSessionSender(sessionKey, myKP.privateKeyBase64, target.publicKey);
      await setLastKnownSenderIdk(sessionKey, myKP.publicKeyBase64).catch(() => {});
    } else {
      // Keep the idk record current even when reusing an existing session
      await setLastKnownSenderIdk(sessionKey, myKP.publicKeyBase64).catch(() => {});
    }

    const { envelope, updatedSession } = await ratchetEncrypt(ratchetSession, ratchetPlaintext);
    await saveRatchetSession(updatedSession);
    relayRows.push({
      recipient_id: recipientId,
      sender_id: senderId,
      conversation_id: conversationId,
      encrypted_payload: JSON.stringify({ ...envelope, sik: myKP.publicKeyBase64 }),
      sender_device_id: myDeviceId,
      recipient_device_id: target.deviceId,
    });
  }

  if (relayRows.length > 0) {
    const { error } = await supabase.from('relay_messages').insert(relayRows);
    if (error) throw new Error(`Edit relay batch insert failed: ${error.message}`);
  }
}

/**
 * Send an encrypted delete-for-everyone notification (v6) through the relay.
 * The receiver will tombstone their local copy of the message.
 */
export async function sendDeleteForEveryone(
  senderId: string,
  recipientId: string,
  conversationId: string,
  messageId: string,
  recipientPublicKey: string
): Promise<void> {
  const deviceKP = await getDeviceKeyPairCached();
  const myKP = deviceKP ?? (await getIdentityKeyPairCached());
  if (!myKP) throw new Error('Identity key pair not found.');

  
  const session_ = getCurrentSession();
  const myDeviceId = session_?.deviceId ?? localStorage.getItem('sc_device_id');

  const recipientDevices = await fetchApprovedDevicesCached(recipientId);
  type TargetDevice = { deviceId: string | null; publicKey: string };
  const targets: TargetDevice[] = recipientDevices.length === 0
    ? [{ deviceId: null, publicKey: recipientPublicKey }]
    : recipientDevices.map(d => ({ deviceId: d.device_id, publicKey: d.public_key }));

  const ratchetPlaintext = JSON.stringify({ v: 6, mid: messageId });

  await refreshSessionIfNeeded();

  const relayRows: any[] = [];
  // Sequential per-device loop — mirrors sendEncryptedMessage (see comment there).
  for (const target of targets) {
    const sessionKey = target.deviceId ? `${conversationId}:${target.deviceId}` : conversationId;

    // ── Stale-session guard (mirrors sendEncryptedMessage) ─────────────────
    let ratchetSession = await getRatchetSession(sessionKey);
    if (ratchetSession) {
      const TTL_MS = 90 * 24 * 60 * 60 * 1000;
      if (ratchetSession.createdAt && Date.now() - ratchetSession.createdAt > TTL_MS) {
        await deleteRatchetSession(sessionKey).catch(() => {});
        await deleteLastKnownSenderIdk(sessionKey).catch(() => {});
        ratchetSession = null;
      } else {
        const storedIdk = await getLastKnownSenderIdk(sessionKey).catch(() => null);
        if (storedIdk && storedIdk !== myKP.publicKeyBase64) {
          await deleteRatchetSession(sessionKey).catch(() => {});
          await deleteLastKnownSenderIdk(sessionKey).catch(() => {});
          ratchetSession = null;
        } else if (!storedIdk) {
          await setLastKnownSenderIdk(sessionKey, myKP.publicKeyBase64).catch(() => {});
        }
      }
    }
    if (!ratchetSession) {
      ratchetSession = await initSessionSender(sessionKey, myKP.privateKeyBase64, target.publicKey);
      await setLastKnownSenderIdk(sessionKey, myKP.publicKeyBase64).catch(() => {});
    } else {
      // Keep the idk record current even when reusing an existing session
      await setLastKnownSenderIdk(sessionKey, myKP.publicKeyBase64).catch(() => {});
    }

    const { envelope, updatedSession } = await ratchetEncrypt(ratchetSession, ratchetPlaintext);
    await saveRatchetSession(updatedSession);
    relayRows.push({
      recipient_id: recipientId,
      sender_id: senderId,
      conversation_id: conversationId,
      encrypted_payload: JSON.stringify({ ...envelope, sik: myKP.publicKeyBase64 }),
      sender_device_id: myDeviceId,
      recipient_device_id: target.deviceId,
    });
  }

  if (relayRows.length > 0) {
    const { error } = await supabase.from('relay_messages').insert(relayRows);
    if (error) throw new Error(`Delete relay batch insert failed: ${error.message}`);
  }
}

// Per-session ratchet lock — ensures only one decrypt runs at a time per
// conversation session key.  Prevents the Realtime handler and the drain loop
// from concurrently advancing the same Double Ratchet chain, which causes a
// last-write-wins race on saveRatchetSession and corrupts chain state:
//   1. Both callers read the same ratchetSession from IDB
//   2. Both advance the chain independently and call saveRatchetSession
//   3. Last write wins — the first write's advanced state is overwritten
//   4. Next incoming message expects msg# N+1 but session is already at N+2 → decrypt fails
//
// Implementation: a simple promise-chain mutex per sessionKey.  A new waiter
// chains onto the tail of the existing promise; the running holder releases on
// finally.  No starvation possible (FIFO queue).
const sessionLocks = new Map<string, Promise<void>>();

async function withSessionLock<T>(sessionKey: string, fn: () => Promise<T>): Promise<T> {
  const prev = sessionLocks.get(sessionKey) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>(resolve => { release = resolve; });
  sessionLocks.set(sessionKey, next);
  try {
    await prev;
    return await fn();
  } finally {
    release();
    // Remove the entry once no more waiters reference this exact promise.
    if (sessionLocks.get(sessionKey) === next) sessionLocks.delete(sessionKey);
  }
}

// In-flight relay message IDs — shared across all callers in this module.
// Prevents the polling drain and the Realtime WebSocket from processing the
// same relay row simultaneously (which causes double decrypt-fail noise and
// races on the delete).
const processingRelayIds = new Set<string>();

// Relay messages that have been fully exhausted (all decrypt attempts failed and
// the DB row was deleted).  Entries expire after 5 minutes so a genuine retry
// (e.g. after a key-recovery) is not permanently blocked by a stale entry from
// an earlier failed attempt.
const exhaustedRelayIds = new Map<string, number>(); // id → expiry timestamp (ms)
const EXHAUSTED_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** True when a relay row's server-computed expiry has already passed. */
function isRelayExpired(relayMessage: RelayMessage): boolean {
  if (!relayMessage.expires_at) return false;
  return new Date(relayMessage.expires_at).getTime() <= Date.now();
}

// Receive and decrypt a relay message
export async function receiveAndDecryptMessage(
  relayMessage: RelayMessage,
  myUserId: string,
  myUsername: string,
  senderUsername: string,
  senderPublicKey: string
): Promise<LocalMessage | null> {
  // ── Deduplication guard ────────────────────────────────────────────────────
  // Skip messages that are already being processed by another concurrent caller
  // (e.g. Realtime handler + drain loop both seeing the same row).
  // Also skip messages that have already been exhausted and deleted in this
  // session — the first caller's `finally` clears processingRelayIds, but
  // exhaustedRelayIds persists for the page lifetime so a racing second caller
  // cannot slip through after the first one finishes.
  //
  // NOTE: JWT refresh is intentionally NOT done here.  The drain loop in
  // ChatPage calls refreshSession() once before iterating over all pending
  // rows, so every message in that cycle shares one fresh token.  Refreshing
  // per-message causes concurrent-refresh races: if the Realtime handler and
  // the drain loop process different rows at the same time, both call
  // refreshSession() simultaneously, the second call invalidates the first
  // call's in-flight RLS check, and one message is silently dropped.
  if (processingRelayIds.has(relayMessage.id)) return null;
  const exhaustedUntil = exhaustedRelayIds.get(relayMessage.id);
  if (exhaustedUntil && Date.now() < exhaustedUntil) return null;
  processingRelayIds.add(relayMessage.id);

  // ── Per-session lock ───────────────────────────────────────────────────────
  // Compute the same sessionKey the inner function uses so we can lock on it
  // before entering.  This prevents two concurrent decrypt calls for DIFFERENT
  // relay rows on the SAME conversation from interleaving their
  // getRatchetSession → ratchetDecrypt → saveRatchetSession sequences, which
  // would cause a last-write-wins corruption of the ratchet chain state.
  const _senderDeviceId = relayMessage.sender_device_id;
  const _sessionKey = _senderDeviceId
    ? `${relayMessage.conversation_id}:${_senderDeviceId}`
    : relayMessage.conversation_id;

  try {
    return await withSessionLock(_sessionKey, () =>
      _receiveAndDecryptMessageInner(
        relayMessage, myUserId, myUsername, senderUsername, senderPublicKey
      )
    );
  } catch (err) {
    // Mark the row as exhausted so a single permanently-undecryptable message
    // (corrupt payload, stale ratchet, etc.) cannot stall the drain loop and
    // block newer messages behind it.  The relay row stays in the table; it
    // will be retried after EXHAUSTED_TTL_MS.
    console.error('[SylvaCrypt] receiveAndDecryptMessage failed for relay row:', relayMessage.id, err);
    exhaustedRelayIds.set(relayMessage.id, Date.now() + EXHAUSTED_TTL_MS);
    return null;
  } finally {
    processingRelayIds.delete(relayMessage.id);
  }
}

async function _buildRecoveredLocalMessage(
  relayMessage: RelayMessage,
  conversationId: string,
  _myUserId: string,
  senderUsername: string,
  payloadMid: string | null,
  decrypted: string,
): Promise<LocalMessage> {
  let content = decrypted;
  let imageStoragePath: string | null = null, imageKeyBase64: string | null = null;
  let voiceStoragePath: string | null = null, voiceKeyBase64: string | null = null, voiceDuration: number | null = null;
  let fileStoragePath: string | null = null, fileKeyBase64: string | null = null;
  let fileName: string | null = null, fileSize: number | null = null, fileMimeType: string | null = null;
  try {
    const p: { v?: number; t?: string; isp?: string; ik?: string; vsp?: string; vk?: string; vd?: number; fsp?: string; fk?: string; fn?: string; fs?: number; ft?: string } = JSON.parse(decrypted);
    if (p.v === 2) { content = p.t ?? ''; imageStoragePath = p.isp ?? null; imageKeyBase64 = p.ik ?? null; }
    else if (p.v === 3) { content = p.t ?? ''; voiceStoragePath = p.vsp ?? null; voiceKeyBase64 = p.vk ?? null; voiceDuration = p.vd ?? null; }
    else if (p.v === 4) { content = p.t ?? ''; fileStoragePath = p.fsp ?? null; fileKeyBase64 = p.fk ?? null; fileName = p.fn ?? null; fileSize = p.fs ?? null; fileMimeType = p.ft ?? null; }
    else if (p.v && p.t !== undefined) content = p.t;
  } catch { /* plain text */ }
  return {
    id: payloadMid ?? relayMessage.id, conversationId,
    senderId: relayMessage.sender_id, senderUsername,
    content, timestamp: new Date(relayMessage.created_at).getTime(),
    status: 'delivered', isOwn: false, imageUrl: null,
    imageStoragePath, imageKeyBase64, replyTo: null,
    voiceStoragePath, voiceKeyBase64, voiceDuration,
    fileStoragePath, fileKeyBase64, fileName, fileSize, fileMimeType,
    ttlSeconds: relayMessage.ttl_seconds ?? null,
    expiresAt: relayMessage.expires_at ? new Date(relayMessage.expires_at).getTime() : null,
  };
}

async function _receiveAndDecryptMessageInner(
  relayMessage: RelayMessage,
  myUserId: string,
  myUsername: string,
  senderUsername: string,
  senderPublicKey: string
): Promise<LocalMessage | null> {
  const conversationId = relayMessage.conversation_id;

  // ── Self-destruct guard ────────────────────────────────────────────────────
  // Don't decrypt or persist a relay row that is already past its expiry.
  if (isRelayExpired(relayMessage)) {
    try {
      await supabase
        .from('relay_messages')
        .delete()
        .eq('id', relayMessage.id)
        .eq('recipient_id', myUserId);
    } catch { /* non-fatal */ }
    return null;
  }

  // ── Multi-device: skip messages not addressed to this device ──────────────
  // If recipient_device_id is set, only the matching device should process it.
  // IMPORTANT: fall back to the localStorage value if currentSession hasn't
  // been populated yet (drain fires before unlockSession completes on page
  // refresh / keep-me-signed-in path).  localStorage is synchronous and always
  // holds the stable UUID regardless of async session state.
  
  const session_ = getCurrentSession();
  const myDeviceId = session_?.deviceId ?? localStorage.getItem('sc_device_id');

  if (relayMessage.recipient_device_id && relayMessage.recipient_device_id !== myDeviceId) {
    console.debug(
      `[SylvaCrypt] relay ${relayMessage.id}: recipient_device_id mismatch —` +
      ` row=${relayMessage.recipient_device_id}, mine=${myDeviceId ?? 'null'} — skipping (sibling device)`
    );
    // Message is for a sibling device. If that device hasn't picked it up within
    // 10 minutes (stale device / cleared localStorage), delete it so it never
    // loops in the drain forever.
    try {
      const age = Date.now() - new Date(relayMessage.created_at).getTime();
      if (age > 10 * 60 * 1000) {
        await supabase.from('relay_messages').delete()
          .eq('id', relayMessage.id).eq('recipient_id', myUserId);
      }
    } catch { /* non-fatal */ }
    return null;
  }

  // ── Resolve session key and own key pair ───────────────────────────────────
  const senderDeviceId = relayMessage.sender_device_id;
  const sessionKey = senderDeviceId
    ? `${conversationId}:${senderDeviceId}`
    : conversationId;

  const deviceKP = await getDeviceKeyPairCached();
  const myKP = deviceKP ?? (await getIdentityKeyPairCached());
  if (!myKP) {
    // Vault not yet unlocked — leave message for next drain cycle.
    return null;
  }

  // ── Resolve the best initial public key for a fresh receiver session ───────
  // Prefer the sender's device public key (most current); fall back to the
  // contact's stored key.  Also fetch the live profile key so we can try it
  // on decryption failure without hitting the network again.
  let initPubKey = senderPublicKey;
  const [senderDevices, liveProfileKey] = await Promise.all([
    senderDeviceId ? fetchApprovedDevices(relayMessage.sender_id) : Promise.resolve([]),
    getUserPublicKey(relayMessage.sender_id).catch(() => null),
  ]);
  if (senderDeviceId) {
    const senderDevice = senderDevices.find(d => d.device_id === senderDeviceId);
    if (senderDevice?.public_key) initPubKey = senderDevice.public_key;
  }

  // ── Helper: attempt one full decrypt with a given receiver init key ────────
  // (defined inline so it captures myKP, sessionKey, relayMessage via closure)

  // Parse `sik` (sender identity key hint, added in v325), `mid` (shared
  // message ID, added in v328), and `x3dh` (X3DH init metadata, added in v332)
  // before the try/catch so all are available in catch/retry blocks.
  let payloadSik: string | null = null;
  let payloadMid: string | null = null;
  let payloadX3DH: X3DHInit | null = null;
  try {
    const outer = JSON.parse(relayMessage.encrypted_payload) as {
      sik?: string; mid?: string; x3dh?: X3DHInit;
    };
    payloadSik  = outer.sik  ?? null;
    payloadMid  = outer.mid  ?? null;
    payloadX3DH = outer.x3dh ?? null;
  } catch { /* ignore — will be null */ }

  try {
    const parsedPayload = JSON.parse(relayMessage.encrypted_payload) as EncryptedEnvelope & { sik?: string; replyTo?: import('@/types/types').ReplyTo };
    const envelope: EncryptedEnvelope = parsedPayload;

    let ratchetSession = await getRatchetSession(sessionKey);
    let decrypted: string | null = null;
    let updatedSession: RatchetSession | null = null;

    // ── Attempt 1: Try decrypting with existing session ──────────────────────
    // If the page reloaded after a successful X3DH init but before the relay row
    // was deleted, we must use the already-saved session instead of re-running
    // X3DH init (which would fail because the OPK was already consumed).
    if (ratchetSession) {
      try {
        const result = await ratchetDecrypt(ratchetSession, envelope);
        decrypted = result.plaintext;
        updatedSession = result.updatedSession;
      } catch (err) {
        // Fall through to re-init
      }
    }

    // ── X3DH receiver init (if no session or session failed) ────────────────
    if (!decrypted && payloadX3DH) {
      try {
        
        const getKEMSecKey = async () => {
          
          const stored = await getEncrypted<{ publicKeyBase64: string; secretKeyBase64: string }>('x3dh_kem_keypair');
          return stored?.secretKeyBase64 ?? undefined;
        };

        const spkStored = await getEncrypted<{ id: string; privateKeyBase64: string; publicKeyBase64: string }>('x3dh_spk');

        if (spkStored && spkStored.id === payloadX3DH.spk_id) {
          const opkPriv = payloadX3DH.opk_id
            ? (await consumeOPKPrivate(payloadX3DH.opk_id) ?? undefined)
            : undefined;
          const kemSecKey = await getKEMSecKey();

          // ── CRITICAL: X3DH receiver MUST use the identity private key for
          // both X3DH key agreement (DH2 = DH(IK_B, EK_A)) AND the Double
          // Ratchet initialisation below.
          //
          // Why the DR init also needs the identity key:
          //   The sender's initSessionSenderFromSecret generates a fresh
          //   ephemeral DR key (eph) and computes the first DH ratchet step as:
          //     dhOut = DH(eph.priv, effectivePubKey)
          //   where effectivePubKey = recipient's contacts/profile public key =
          //   the IDENTITY public key.  The receiver's first DH ratchet step is:
          //     dhOut = DH(DHs.priv, eph.pub)
          //   For the two dhOut values to be equal (X25519 commutativity):
          //     DHs.priv MUST correspond to effectivePubKey = identity_pub.
          //   Passing the DEVICE key here produces a different dhOut →
          //   mismatched chain key → every message fails to decrypt.
          
          const identityKP = await getIdentityKeyPairCached();
          // Guard: if the identity key is not yet available (vault unlock still
          // in progress), do NOT fall back to the device key — that would compute
          // a wrong X3DH shared secret and permanently corrupt the session.
          // Throw so the catch block sets ratchetSession=null and the message
          // falls through to legacy DH (or defers on the next drain cycle).
          if (!identityKP) {
            throw new Error('[X3DH] Identity key unavailable during receiver init — deferring to legacy path');
          }
          const ikPrivForX3DH = identityKP.privateKeyBase64;
          const ikPubForX3DH  = identityKP.publicKeyBase64;

          const sessionSecret = await x3dhReceiverSetupFull(
            ikPrivForX3DH,
            payloadX3DH.sender_ik_pub,
            {
              ephemeralPub: payloadX3DH.eph_pub,
              spkPriv:      spkStored.privateKeyBase64,
              opkPriv,
              kemCiphertext: payloadX3DH.kem_ct,
            },
            kemSecKey,
          );
          // NOTE: do NOT call deleteRatchetSession here.  If the subsequent
          // ratchetDecrypt fails (wrong shared secret, stale message, etc.) the
          // pre-existing session in IDB is still recoverable by the retry paths
          // below.  saveRatchetSession(updatedSession) called on success
          // overwrites the old entry atomically, so the explicit delete is
          // redundant when things work and harmful when they don't.
          ratchetSession = await initRatchetFromX3DH(
            sessionKey,
            sessionSecret,
            ikPrivForX3DH,   // identity priv — MUST match effectivePubKey used by sender
            ikPubForX3DH,    // identity pub
            payloadX3DH.sender_ik_pub,
            false,
          );
          console.debug(`[X3DH] Receiver init OK for relay ${relayMessage.id} (spk_id=${payloadX3DH.spk_id.slice(0, 8)}…)`);
        } else {
          console.warn(
            `[X3DH] SPK mismatch for relay ${relayMessage.id}: ` +
            `message spk_id=${payloadX3DH.spk_id?.slice(0, 8)}…, ` +
            `vault spk_id=${spkStored?.id?.slice(0, 8) ?? 'null'}… — ` +
            `falling back to legacy DH`
          );
          ratchetSession = null;
        }
      } catch (x3dhErr) {
        console.warn('[X3DH] Receiver init failed, falling back to legacy DH:', x3dhErr);
        ratchetSession = null;
      }
    }

    // ── Legacy single-DH fallback (no X3DH metadata, or SPK mismatch) ─────────
    if (!decrypted && !ratchetSession) {
      ratchetSession = await initSessionReceiver(
        sessionKey, myKP.privateKeyBase64, myKP.publicKeyBase64, initPubKey
      );
    }

    // Detect stale session missing header-encryption key (pre-v2.4.0 sessions).
    if (!decrypted && envelope.encryptedHeader && ratchetSession && !ratchetSession.HK && !ratchetSession.HKr) {
      console.warn('[SylvaCrypt] Stale session missing HK — clearing for re-init');
      await deleteRatchetSession(sessionKey);
      ratchetSession = await initSessionReceiver(
        sessionKey, myKP.privateKeyBase64, myKP.publicKeyBase64, initPubKey
      );
    }

    if (!decrypted && ratchetSession) {
      const result = await ratchetDecrypt(ratchetSession, envelope);
      decrypted = result.plaintext;
      updatedSession = result.updatedSession;
    }
    
    if (!decrypted || !updatedSession) {
      throw new Error('Failed to decrypt message after all init attempts');
    }
    // saveRatchetSession is intentionally deferred until AFTER the relay row is
    // confirmed deleted (see the delete-retry block below).
    //
    // Why this ordering matters:
    //   If we advance the ratchet here and the relay-row DELETE then fails
    //   (expired JWT, transient network error, RLS flap), the row stays in the
    //   table.  The next drain cycle re-fetches the same ciphertext and tries to
    //   decrypt it with the *already-advanced* ratchet state → decryption fails
    //   → the message is permanently lost.
    //
    //   Deferring guarantees atomicity: either the delete succeeds (relay row
    //   gone, ratchet advanced, message saved) or nothing is committed (relay
    //   row stays, ratchet unchanged, next drain retries successfully).

    // ── Sealed-sender cert verification ───────────────────────────────────────
    // When the relay row carries a sender_cert, decrypt it and verify the
    // certified sender identity. A valid cert is required for X3DH handshake
    // (first) messages so the receiver can authenticate the sender's identity
    // key; subsequent messages in an established Double Ratchet session do not
    // carry a cert because the sender was already authenticated at init.
    if (relayMessage.sender_cert) {
      try {
        
        const box = JSON.parse(relayMessage.sender_cert) as import('@/lib/x3dh').SealedSenderBox;
        const cert = await openSealedSenderBox(box, myKP.privateKeyBase64);
        if (cert) {
          // Verify that the certified sender identity matches what we have on record
          if (cert.sender_id !== relayMessage.sender_id) {
            throw new Error(
              `[SealedSender] Certified sender_id (${cert.sender_id}) ` +
              `differs from relay sender_id (${relayMessage.sender_id}) — rejecting spoofing attempt.`
            );
          } else if (payloadSik && cert.sender_ik_pub !== payloadSik) {
            throw new Error(
              `[SealedSender] Certified IK (${cert.sender_ik_pub.slice(0, 8)}…) ` +
              `differs from payload sik hint — rejecting.`
            );
          }
        } else {
           throw new Error('[SealedSender] Cert verification failed to return valid cert.');
        }
      } catch (certErr) {
        throw new Error(`[SealedSender] Verification error: ${certErr instanceof Error ? certErr.message : String(certErr)}`);
      }
    } else if (payloadX3DH) {
      // First messages bootstrapped via X3DH must carry a cert so the receiver
      // can authenticate the sender's identity key before trusting it.
      throw new Error(`[SealedSender] Missing required sender certificate on E2EE handshake.`);
    }
    // Non-first messages in an existing Double Ratchet session do not need a
    // sender certificate — the sender identity was already authenticated when
    // the session was initialized.

    // Parse v2/v3/v4/v5/v6 structured payloads
    let content = decrypted;
    let imageStoragePath: string | null = null, imageKeyBase64: string | null = null;
    let voiceStoragePath: string | null = null, voiceKeyBase64: string | null = null, voiceDuration: number | null = null;
    let fileStoragePath: string | null = null, fileKeyBase64: string | null = null;
    let fileName: string | null = null, fileSize: number | null = null, fileMimeType: string | null = null;
    try {
      const parsed: {
        v?: number; t?: string; mid?: string;
        isp?: string; ik?: string;
        vsp?: string; vk?: string; vd?: number;
        fsp?: string; fk?: string; fn?: string; fs?: number; ft?: string;
      } = JSON.parse(decrypted);

      if (parsed.v === 5 && parsed.mid) {
        // ── Edit notification: update the stored message on the receiver's side ──
        const editedAt = Date.now();
        await updateMessageContentInDB(myUserId, parsed.mid, parsed.t ?? '', editedAt);
        const { error: v5DelErr } = await supabase
          .from('relay_messages')
          .delete()
          .eq('id', relayMessage.id)
          .eq('recipient_id', myUserId);
        // Only advance ratchet after relay row is confirmed gone.
        if (!v5DelErr) await saveRatchetSession(updatedSession);
        // Return a synthetic LocalMessage carrying the mutation signal
        return {
          id: parsed.mid,
          conversationId,
          senderId: relayMessage.sender_id,
          senderUsername,
          content: parsed.t ?? '',
          timestamp: editedAt,
          status: 'delivered' as const,
          isOwn: false,
          isEdited: true,
          editedAt,
          _mutationType: 'edit' as const,
        };
      }

      if (parsed.v === 6 && parsed.mid) {
        // ── Delete-for-everyone: tombstone the message on the receiver's side ──
        await markMessageDeletedForEveryoneInDB(myUserId, parsed.mid);
        const { error: v6DelErr } = await supabase
          .from('relay_messages')
          .delete()
          .eq('id', relayMessage.id)
          .eq('recipient_id', myUserId);
        // Only advance ratchet after relay row is confirmed gone.
        if (!v6DelErr) await saveRatchetSession(updatedSession);
        return {
          id: parsed.mid,
          conversationId,
          senderId: relayMessage.sender_id,
          senderUsername,
          content: '',
          timestamp: Date.now(),
          status: 'delivered' as const,
          isOwn: false,
          isDeletedForEveryone: true,
          _mutationType: 'delete' as const,
        };
      }

      if (parsed.v === 2) {
        content = parsed.t ?? '';
        imageStoragePath = parsed.isp ?? null; imageKeyBase64 = parsed.ik ?? null;
      } else if (parsed.v === 3) {
        content = parsed.t ?? '';
        voiceStoragePath = parsed.vsp ?? null; voiceKeyBase64 = parsed.vk ?? null; voiceDuration = parsed.vd ?? null;
      } else if (parsed.v === 4) {
        content = parsed.t ?? '';
        fileStoragePath = parsed.fsp ?? null; fileKeyBase64 = parsed.fk ?? null;
        fileName = parsed.fn ?? null; fileSize = parsed.fs ?? null; fileMimeType = parsed.ft ?? null;
      }
    } catch { /* plain-text message */ }

    type PayloadExtras = { replyTo?: import('@/types/types').ReplyTo; viewOnce?: boolean; ttlSeconds?: number };
    const envExtras = parsedPayload as EncryptedEnvelope & PayloadExtras;
    const isViewOnce = !!(envExtras.viewOnce ?? relayMessage.is_view_once);
    const ttlSeconds = envExtras.ttlSeconds ?? relayMessage.ttl_seconds ?? null;
    const expiresAt = relayMessage.expires_at
      ? new Date(relayMessage.expires_at).getTime()
      : (ttlSeconds ? new Date(relayMessage.created_at).getTime() + ttlSeconds * 1000 : null);

    const localMsg: LocalMessage = {
      id: payloadMid ?? relayMessage.id,
      conversationId,
      senderId: relayMessage.sender_id,
      senderUsername,
      content,
      timestamp: new Date(relayMessage.created_at).getTime(),
      status: 'delivered',
      isOwn: relayMessage.sender_id === myUserId,
      imageUrl: null,
      imageStoragePath, imageKeyBase64,
      replyTo: envExtras.replyTo ?? null,
      voiceStoragePath, voiceKeyBase64, voiceDuration,
      fileStoragePath, fileKeyBase64, fileName, fileSize, fileMimeType,
      isViewOnce,
      viewOnceConsumed: relayMessage.sender_id === myUserId, // sender already saw it while composing
      ttlSeconds,
      expiresAt,
    };

    // Retry relay-row DELETE up to 3 times with a fresh JWT on each attempt.
    // Only advance the ratchet and persist the message AFTER the row is
    // confirmed gone.  If delete fails after all retries we return null — the
    // relay row stays in the table, the ratchet is NOT advanced, and the next
    // drain cycle will re-process the same row with the same (unchanged) ratchet
    // state → decryption succeeds again.  This prevents the "advanced ratchet +
    // stale relay row" corruption that causes permanent message loss.
    let relayDeleted = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const { error: delErr } = await supabase
        .from('relay_messages')
        .delete()
        .eq('id', relayMessage.id)
        .eq('recipient_id', myUserId);
      if (!delErr) { relayDeleted = true; break; }
      console.warn(`[SylvaCrypt] Relay delete attempt ${attempt + 1}/3 failed:`, delErr.message);
      if (attempt < 2) await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
    }
    if (!relayDeleted) {
      // Could not confirm relay row removal.  Ratchet is NOT advanced so the
      // same ciphertext will decrypt correctly on the next drain cycle.
      console.error('[SylvaCrypt] Relay row delete failed after 3 attempts — deferring to next drain:', relayMessage.id);
      return null;
    }

    // Delete confirmed: advance ratchet then return the message immediately
    // so it appears in the UI without waiting for the DB write (~150-300ms).
    // saveMessageToDBFull runs in the background; the relay row is already gone
    // so there is no risk of double-processing on a retry.
    await saveRatchetSession(updatedSession);
    void myUsername;

    // Background DB persist — fire-and-forget with retry.
    // The message is already surfaced to the UI via the return value below;
    // this write is for persistence only and must not block rendering.
    void (async () => {
      const saveOk = await saveMessageToDBFull(myUserId, myUserId, localMsg);
      if (!saveOk) {
        for (const delay of [800, 2000]) {
          await new Promise(r => setTimeout(r, delay));
          const retryOk = await saveMessageToDBFull(myUserId, myUserId, localMsg);
          if (retryOk) break;
          if (delay === 2000) {
            console.warn('[SylvaCrypt] saveMessageToDBFull failed after all retries — message only in live UI:', localMsg.id);
          }
        }
      }
    })();

    return localMsg;
  } catch (err) {
    console.debug('[SylvaCrypt] Failed to decrypt relay message (attempt 1):', err);

    // ── Resilient recovery: try X3DH (when applicable) then legacy DH ────────
    //
    // Root cause of most failures:
    //   (a) Stale / diverged ratchet state after a sender session reset.
    //       The primary path already tries X3DH when payloadX3DH is present.
    //       If it reached here, either the SPK matched and decrypt still failed
    //       (diverged chain) or the SPK mismatched (legacy DH fallback failed).
    //       Recovery: try X3DH again (SPK may have been re-published) then
    //       legacy DH with multiple key variants.
    //   (b) Stale contact key.  Fix: re-init with live profile key.
    //   (c) Sender IK changed mid-session.  Fix: use payloadSik hint.
    // ─────────────────────────────────────────────────────────────────────────
    const senderDeviceId2 = relayMessage.sender_device_id;
    const sessionKey2 = senderDeviceId2
      ? `${conversationId}:${senderDeviceId2}`
      : conversationId;

    // ── Recovery attempt 0: X3DH re-init (only when metadata present) ────────
    // The primary path already tried this, but a transient vault-read failure or
    // a concurrent SPK rotation could have caused it to fall through.  One retry
    // here costs little and covers those edge cases.
    if (payloadX3DH) {
      const deviceKP0 = await getDeviceKeyPairCached();
      const myKP0 = deviceKP0 ?? (await getIdentityKeyPairCached());
      if (myKP0) {
        try {
          
          
          const spk0 = await getEncrypted<{ id: string; privateKeyBase64: string; publicKeyBase64: string }>('x3dh_spk');

          if (spk0 && spk0.id === payloadX3DH.spk_id) {
            const opkPriv0 = payloadX3DH.opk_id
              ? (await consumeOPKPrivate(payloadX3DH.opk_id) ?? undefined)
              : undefined;
            const kem0 = await getEncrypted<{ secretKeyBase64: string }>('x3dh_kem_keypair');
            
            const ikKP0 = await getIdentityKeyPairCached();
            const ikPriv0 = ikKP0?.privateKeyBase64 ?? myKP0.privateKeyBase64;
            const ikPub0  = ikKP0?.publicKeyBase64  ?? myKP0.publicKeyBase64;

            const secret0 = await x3dhReceiverSetupFull(
              ikPriv0, payloadX3DH.sender_ik_pub,
              { ephemeralPub: payloadX3DH.eph_pub, spkPriv: spk0.privateKeyBase64, opkPriv: opkPriv0, kemCiphertext: payloadX3DH.kem_ct },
              kem0?.secretKeyBase64,
            );
            await deleteRatchetSession(sessionKey2).catch(() => {});
            // Use identity key pair for DR init — same requirement as primary path:
            // sender's first DR step targeted identity_pub (effectivePubKey), so
            // receiver's DHs.priv must be identity_priv for DH commutativity.
            const freshX3DH = await initRatchetFromX3DH(sessionKey2, secret0, ikPriv0, ikPub0, payloadX3DH.sender_ik_pub, false);
            const { plaintext: decX3DH, updatedSession: usX3DH } = await ratchetDecrypt(freshX3DH, JSON.parse(relayMessage.encrypted_payload));
            const recoveredX3DH = await _buildRecoveredLocalMessage(relayMessage, conversationId, myUserId, senderUsername, payloadMid, decX3DH);
            const { error: x3dhRecDelErr } = await supabase.from('relay_messages').delete().eq('id', relayMessage.id).eq('recipient_id', myUserId);
            if (x3dhRecDelErr) {
              console.warn('[SylvaCrypt] X3DH recovery: relay delete failed, deferring to next drain:', x3dhRecDelErr.message);
              throw x3dhRecDelErr; // fall through to next recovery attempt / drain
            }
            // Delete confirmed: advance ratchet then return immediately.
            await saveRatchetSession(usX3DH);
            void (async () => {
              const saveOkX3DH = await saveMessageToDBFull(myUserId, myUserId, recoveredX3DH);
              if (!saveOkX3DH) {
                await new Promise(r => setTimeout(r, 800));
                await saveMessageToDBFull(myUserId, myUserId, recoveredX3DH);
              }
            })();
            console.info(`[SylvaCrypt] Recovered via X3DH retry: relay ${relayMessage.id}`);
            return recoveredX3DH;
          }
        } catch (x3dhRetryErr) {
          console.debug('[SylvaCrypt] X3DH recovery attempt failed:', x3dhRetryErr);
        }
      }
    }

    // ── Recovery attempts 1-N: legacy DH with multiple key variants ───────────
    // Collect keys to try (in priority order):
    //   1. payloadSik    — sender's identity key embedded in the relay payload (v325+)
    //   2. initPubKey    — device key or stored contact key resolved above
    //   3. liveProfileKey — live profile key fetched from Supabase
    //   4. senderPublicKey — original contact key passed from handleIncomingRelay
    const keysToTry = [...new Set([payloadSik, initPubKey, liveProfileKey, senderPublicKey].filter((k): k is string => !!k))];

    for (const tryKey of keysToTry) {
      const deviceKP2 = await getDeviceKeyPairCached();
      const myKP2 = deviceKP2 ?? (await getIdentityKeyPairCached());
      if (!myKP2) break;

      try {
        // Delete any stale session so initSessionReceiver starts from scratch.
        await deleteRatchetSession(sessionKey2).catch(() => {});
        const freshSession = await initSessionReceiver(
          sessionKey2, myKP2.privateKeyBase64, myKP2.publicKeyBase64, tryKey
        );
        const { plaintext: decrypted2, updatedSession: us2 } = await ratchetDecrypt(
          freshSession, JSON.parse(relayMessage.encrypted_payload)
        );
        // Deferred saveRatchetSession — only commit after relay row is deleted.

        // If we succeeded with a different key, persist it so future messages
        // also use the correct key automatically.
        if (tryKey !== senderPublicKey) {
          await updateContactPublicKey(myUserId, relayMessage.sender_id, tryKey).catch(() => {});
        }

        const recovered = await _buildRecoveredLocalMessage(relayMessage, conversationId, myUserId, senderUsername, payloadMid, decrypted2);
        const { error: legacyDelErr } = await supabase.from('relay_messages').delete()
          .eq('id', relayMessage.id).eq('recipient_id', myUserId);
        if (legacyDelErr) {
          console.warn('[SylvaCrypt] Legacy DH recovery: relay delete failed, deferring to next drain:', legacyDelErr.message);
          throw legacyDelErr; // try next key variant, or fall through to exhausted path
        }
        // Delete confirmed: advance ratchet then return immediately.
        await saveRatchetSession(us2);
        void (async () => {
          const saveOkLegacy = await saveMessageToDBFull(myUserId, myUserId, recovered);
          if (!saveOkLegacy) {
            await new Promise(r => setTimeout(r, 800));
            await saveMessageToDBFull(myUserId, myUserId, recovered);
          }
        })();
        void myUsername;
        console.info(`[SylvaCrypt] Recovered message ${relayMessage.id} via legacy DH (key: ${tryKey === senderPublicKey ? 'stored' : 'live'}).`);
        return recovered;
      } catch (retryErr) {
        console.debug(`[SylvaCrypt] Retry with key attempt failed:`, retryErr);
        // Continue to next key
      }
    }

    // All recovery attempts failed — delete the relay row unconditionally.
    // Leaving it in the table causes every drain / Realtime event to re-fetch
    // and re-fail it forever, blocking the drain queue.
    //
    // The DELETE policy is: auth.uid() = recipient_id.  If the JWT is expired,
    // auth.uid() returns NULL and the delete silently matches 0 rows — the
    // message stays and loops.  Refresh the token first to avoid this.
    console.debug('[SylvaCrypt] All decryption attempts exhausted — discarding relay message', relayMessage.id);
    try {
      const { error: delErr } = await supabase
        .from('relay_messages')
        .delete()
        .eq('id', relayMessage.id)
        .eq('recipient_id', myUserId);
      if (delErr) {
        console.warn('[SylvaCrypt] Delete of undecryptable relay message failed (will retry next drain):', delErr.message);
      }
      // Mark exhausted regardless of delete success — prevents the racing
      // concurrent caller (drain loop vs Realtime) from reprocessing the same
      // undecryptable row and doubling the console noise.  Expires after 5 min
      // so a key-recovery event can still retry delivery later.
      exhaustedRelayIds.set(relayMessage.id, Date.now() + EXHAUSTED_TTL_MS);

      // CRITICAL: The session is completely broken. Delete the cached session
      // so the next outgoing message from this device forces a fresh X3DH setup.
      await deleteRatchetSession(sessionKey).catch(() => {});
      try { localStorage.removeItem(`sc_idk_${sessionKey}`); } catch { /* ignore */ }
      try { localStorage.removeItem(`sc_spk_id_${sessionKey}`); } catch { /* ignore */ }

      
      const placeholder: import('@/types/types').LocalMessage = {
        id: relayMessage.id,
        conversationId,
        senderId: relayMessage.sender_id,
        senderUsername,
        content: '⚠️ Message could not be decrypted. The secure session was reset. Please send a message to restore the secure connection.',
        timestamp: new Date(relayMessage.created_at).getTime(),
        status: 'failed',
        isOwn: relayMessage.sender_id === myUserId,
      };
      
      await saveMessageToDBFull(myUserId, myUserId, placeholder);
      return placeholder;
    } catch { /* non-fatal */ }
    void myUsername;
    return null;
  }
}

// Fetch any pending relay messages (for when user was offline).
// Expired TTL rows are removed before they can be decrypted/resent; this
// prevents old self-destructing messages from suddenly appearing when a
// recipient comes back online after the expiry deadline.
export async function fetchPendingRelayMessages(userId: string): Promise<RelayMessage[]> {
  const { data, error } = await supabase
    .from('relay_messages')
    .select('*')
    .eq('recipient_id', userId)
    .order('created_at', { ascending: true })
    .limit(200);

  if (error) {
    console.error('[SylvaCrypt] Failed to fetch pending messages:', error);
    return [];
  }

  const rows = (data ?? []) as RelayMessage[];
  const active: RelayMessage[] = [];
  const expiredIds: string[] = [];

  for (const row of rows) {
    if (isRelayExpired(row)) {
      expiredIds.push(row.id);
    } else {
      active.push(row);
    }
  }

  if (expiredIds.length > 0) {
    const { error: delErr } = await supabase
      .from('relay_messages')
      .delete()
      .in('id', expiredIds)
      .eq('recipient_id', userId);
    if (delErr) {
      console.warn('[SylvaCrypt] Failed to purge expired relay rows:', delErr.message);
    }
  }

  return active;
}

// Subscribe to incoming relay messages via Supabase Realtime.
//
// onReady is called every time the channel reaches SUBSCRIBED status — both on
// the initial connection and after any reconnect. The caller should use it to
// re-drain relay_messages so that messages inserted during the connection
// window (after the initial fetch but before the channel was live) are never
// silently dropped.
//
type RelayListener = {
  onMessage: (msg: RelayMessage) => void | Promise<void>;
  onReady?: () => void;
};
let sharedRelayChannel: ReturnType<typeof supabase.channel> | null = null;
const relayListeners = new Set<RelayListener>();

export function clearRelayChannel(): void {
  if (sharedRelayChannel) {
    supabase.removeChannel(sharedRelayChannel);
    sharedRelayChannel = null;
  }
  relayListeners.clear();
}

// Resilience features:
//  - CHANNEL_ERROR / TIMED_OUT → channel is torn down and recreated after a
//    short back-off so the subscription self-heals without a page reload.
//  - onReady (drain) fires on every SUBSCRIBED event, including reconnects, so
//    any messages that arrived during the outage are fetched immediately.
export function subscribeToRelay(
  userId: string,
  onMessage: (msg: RelayMessage) => void | Promise<void>,
  onReady?: () => void
) {
  const listener: RelayListener = { onMessage, onReady };
  relayListeners.add(listener);

  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  function createChannel() {
    // Unique instance ID prevents channel-name collisions when React StrictMode
    // double-mounts effects or when CHANNEL_ERROR triggers a reconnect before
    // the old channel is fully removed.  Two channels with the same name share
    // one server-side subscription — Supabase delivers each INSERT to exactly
    // one of them non-deterministically, causing ~50% message loss.
    const instanceId = generateUUID().slice(0, 8);
    const ch = supabase
      .channel(`relay-${userId}-${instanceId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'relay_messages',
          filter: `recipient_id=eq.${userId}`,
        },
        (payload: any) => {
          relayListeners.forEach(({ onMessage: cb }) => {
            try {
              const maybePromise = cb(payload.new as RelayMessage);
              // onMessage is async in the current app; catch any rejected promise
              // so a single bad row cannot tear down the Realtime channel.
              if (maybePromise) {
                maybePromise.catch(err =>
                  console.error('[SylvaCrypt] Relay realtime handler error:', err)
                );
              }
            } catch (err) {
              console.error('[SylvaCrypt] Relay realtime handler error:', err);
            }
          });
        }
      )
      .subscribe((status: any) => {
        if (status === 'SUBSCRIBED') {
          // Drain any messages that arrived during the gap (initial connect or
          // after a reconnect).  onReady is intentionally called on every
          // SUBSCRIBED event — not just the first — so offline messages are
          // fetched each time the channel comes back.
          relayListeners.forEach(({ onReady: readyCb }) => {
            if (readyCb) readyCb();
          });
        }

        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          // The WebSocket channel entered a terminal error state.  Remove it
          // and schedule a reconnect so messages are never permanently missed.
          console.warn(`[SylvaCrypt] Relay channel ${status} — reconnecting in 3 s`);
          supabase.removeChannel(ch).catch(() => {});
          if (sharedRelayChannel === ch) {
            sharedRelayChannel = null;
            retryTimer = setTimeout(createChannel, 3000);
          }
        }
      });

    sharedRelayChannel = ch;
  }

  if (!sharedRelayChannel) {
    createChannel();
  } else {
    if ((sharedRelayChannel as unknown as { state: string }).state === 'joined') {
      if (onReady) onReady();
    }
  }

  return () => {
    relayListeners.delete(listener);
    if (retryTimer !== null) clearTimeout(retryTimer);
    // Intentional: Do not remove the channel on unsubscribe to reuse it
    // across navigations without paying the WebSocket handshake penalty.
  };
}

// ─── Message reactions ────────────────────────────────────────────────────────

import type { MessageReaction } from '@/types/types';

// Broadcast event shapes on the reactions channel
interface ReactionAddBroadcast {
  type: 'add';
  id: string;
  messageId: string;
  conversationId: string;
  senderId: string;
  emoji: string;
  createdAt: number;
}
interface ReactionRemoveBroadcast {
  type: 'remove';
  id?: string;
  messageId: string;
  senderId: string;
  emoji: string;
}

type ReactionListener = {
  onAdd: (reaction: MessageReaction) => void;
  onRemove: (reactionId: string | undefined, messageId: string, senderId: string, emoji: string) => void;
};

// Single shared Realtime channel per conversation. Both the listeners
// (subscribeToReactions) and the senders (addReaction/removeReaction) must use
// the EXACT SAME channel object, otherwise broadcast messages can be lost when
// a send-only channel has no listeners or is not fully subscribed yet.
const _reactionChannels = new Map<string, {
  channel: ReturnType<typeof supabase.channel>;
  listeners: Set<ReactionListener>;
  subscribed: boolean;
  // Payloads queued while the channel is still connecting. Flushed once
  // the channel fires SUBSCRIBED. Calling channel.on('system') AFTER
  // subscribe() has already been called does not work in Supabase Realtime
  // (the event system is sealed once the channel is live), so we maintain
  // our own queue instead.
  pending: Array<ReactionAddBroadcast | ReactionRemoveBroadcast>;
} | null>();

function getReactionChannel(conversationId: string) {
  let entry = _reactionChannels.get(conversationId);
  if (!entry) {
    const listeners = new Set<ReactionListener>();
    const pending: Array<ReactionAddBroadcast | ReactionRemoveBroadcast> = [];

    const channel = supabase
      .channel(`reactions:${conversationId}`, { config: { broadcast: { ack: false } } })
      .on('broadcast', { event: 'reaction' }, ({ payload }: any) => {
        const p = payload as ReactionAddBroadcast | ReactionRemoveBroadcast;
        listeners.forEach(({ onAdd, onRemove }) => {
          if (p.type === 'add') {
            onAdd({
              id: p.id,
              messageId: p.messageId,
              senderId: p.senderId,
              emoji: p.emoji,
              createdAt: p.createdAt,
            });
          } else {
            onRemove(p.id, p.messageId, p.senderId, p.emoji);
          }
        });
      })
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'message_reactions', filter: `conversation_id=eq.${conversationId}` },
        (payload: any) => {
          const row = payload.new as Record<string, unknown>;
          const reaction: MessageReaction = {
            id: row.id as string,
            messageId: row.message_id as string,
            senderId: row.sender_id as string,
            emoji: row.emoji as string,
            createdAt: new Date(row.created_at as string).getTime(),
          };
          listeners.forEach(({ onAdd }) => onAdd(reaction));
        }
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'message_reactions', filter: `conversation_id=eq.${conversationId}` },
        (payload: any) => {
          const row = payload.new as Record<string, unknown>;
          const reaction: MessageReaction = {
            id: row.id as string,
            messageId: row.message_id as string,
            senderId: row.sender_id as string,
            emoji: row.emoji as string,
            createdAt: new Date(row.created_at as string).getTime(),
          };
          listeners.forEach(({ onAdd }) => onAdd(reaction));
        }
      )
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'message_reactions', filter: `conversation_id=eq.${conversationId}` },
        (payload: any) => {
          const row = payload.old as Record<string, unknown>;
          listeners.forEach(({ onRemove }) =>
            onRemove(row.id as string, row.message_id as string, row.sender_id as string, row.emoji as string)
          );
        }
      )
      .subscribe((status: any) => {
        if (!entry) return;
        entry.subscribed = status === 'SUBSCRIBED';
        if (status === 'SUBSCRIBED' && pending.length > 0) {
          // Flush any broadcasts that were queued before the channel was ready.
          const toFlush = pending.splice(0);
          toFlush.forEach(p =>
            entry!.channel.send({ type: 'broadcast', event: 'reaction', payload: p })
          );
        }
      });

    entry = { channel, listeners, subscribed: false, pending };
    _reactionChannels.set(conversationId, entry);
  }
  return entry;
}

function sendReactionBroadcast(conversationId: string, payload: ReactionAddBroadcast | ReactionRemoveBroadcast) {
  const entry = getReactionChannel(conversationId);
  if (entry.subscribed) {
    // Channel is live — send immediately.
    entry.channel.send({ type: 'broadcast', event: 'reaction', payload });
  } else {
    // Channel is still connecting. Enqueue the payload; the subscribe()
    // callback above will flush it once status === 'SUBSCRIBED'.
    entry.pending.push(payload);
  }
}

/**
 * Add an emoji reaction to a message. No-op if the same reaction already exists.
 * Reactions are stored server-side as low-sensitivity metadata (emoji only).
 *
 * After the DB write, the reaction is broadcast on the shared conversation channel
 * so the recipient sees it instantly without waiting for postgres_changes delivery
 * (which requires server-side RLS evaluation that can be delayed or silently dropped).
 */
export async function addReaction(
  messageId: string,
  conversationId: string,
  senderId: string,
  recipientId: string,
  emoji: string
): Promise<void> {
  const { data, error } = await supabase
    .from('message_reactions')
    .upsert(
      { message_id: messageId, conversation_id: conversationId, sender_id: senderId, recipient_id: recipientId, emoji },
      { onConflict: 'message_id,sender_id,emoji' }
    )
    .select('id, created_at')
    .maybeSingle();
  if (error) {
    console.error('[SylvaCrypt] addReaction error:', error.message);
    return;
  }
  const payload: ReactionAddBroadcast = {
    type: 'add',
    id: (data?.id as string) ?? generateUUID(),
    messageId,
    conversationId,
    senderId,
    emoji,
    createdAt: data?.created_at
      ? new Date(data.created_at as string).getTime()
      : Date.now(),
  };
  sendReactionBroadcast(conversationId, payload);
}

/**
 * Remove the caller's emoji reaction from a message.
 * Broadcasts the removal so the recipient's UI updates immediately.
 */
export async function removeReaction(
  messageId: string,
  conversationId: string,
  senderId: string,
  emoji: string
): Promise<void> {
  const { error } = await supabase
    .from('message_reactions')
    .delete()
    .eq('message_id', messageId)
    .eq('sender_id', senderId)
    .eq('emoji', emoji);
  if (error) {
    console.error('[SylvaCrypt] removeReaction error:', error.message);
    return;
  }
  const payload: ReactionRemoveBroadcast = { type: 'remove', messageId, senderId, emoji };
  sendReactionBroadcast(conversationId, payload);
}

/**
 * Fetch all reactions for a set of message IDs in a conversation.
 * Returns a map of messageId → MessageReaction[].
 */
export async function fetchReactionsForConversation(
  conversationId: string
): Promise<Map<string, MessageReaction[]>> {
  const { data, error } = await supabase
    .from('message_reactions')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('[SylvaCrypt] fetchReactions error:', error.message);
    return new Map();
  }

  const map = new Map<string, MessageReaction[]>();
  for (const row of data ?? []) {
    const msgId = row.message_id as string;
    if (!map.has(msgId)) map.set(msgId, []);
    map.get(msgId)!.push({
      id: row.id as string,
      messageId: msgId,
      senderId: row.sender_id as string,
      emoji: row.emoji as string,
      createdAt: new Date(row.created_at as string).getTime(),
    });
  }
  return map;
}

/**
 * Subscribe to reaction events for a conversation.
 *
 * Delivery uses TWO parallel paths so neither alone is a single point of failure:
 *
 * 1. Supabase Broadcast — primary path.
 *    The reactor explicitly broadcasts after every DB write, so the recipient
 *    receives the event instantly on the shared channel without any server-side
 *    RLS evaluation (broadcast is auth-free within a channel).
 *
 * 2. postgres_changes — fallback / persistence path.
 *    Catches events that arrive while the broadcast channel is still connecting,
 *    and also delivers reactions to clients that were offline and re-subscribed
 *    after a reconnect.  Requires REPLICA IDENTITY FULL on message_reactions
 *    (migration 00028) so that DELETE payloads include message_id.
 *
 * IMPORTANT: this function registers listeners on a SINGLE shared channel per
 * conversation. addReaction/removeReaction reuse the same channel to broadcast.
 */
export function subscribeToReactions(
  conversationId: string,
  onAdd: (reaction: MessageReaction) => void,
  onRemove: (reactionId: string | undefined, messageId: string, senderId: string, emoji: string) => void
): () => void {
  const entry = getReactionChannel(conversationId);
  const listener: ReactionListener = { onAdd, onRemove };
  entry.listeners.add(listener);

  return () => {
    entry.listeners.delete(listener);
    // Intentional: Do not remove the shared channel when listeners === 0.
    // It is kept alive so that subsequent conversation views or senders
    // do not pay the WebSocket handshake penalty (~100-200ms).
  };
}

// Look up a user's public key by user ID
export async function getUserPublicKey(userId: string): Promise<string | null> {
  const { data } = await supabase
    .from('public_profiles')
    .select('public_key')
    .eq('id', userId)
    .maybeSingle();
  return data?.public_key ?? null;
}

// Look up a user's profile by username
export async function findUserByUsername(username: string) {
  const { data } = await supabase
    .from('public_profiles')
    .select('id, username, public_key')
    .ilike('username', username)
    .eq('discoverable', true)
    .maybeSingle();
  return data;
}

/** Record a contact's key change in the key history table. */
export async function recordContactKeyChange(
  ownerId: string,
  contactId: string,
  oldKey: string,
  newKey: string,
  oldFp: string,
  newFp: string,
): Promise<void> {
  await supabase.from('contact_key_history').insert({
    owner_id: ownerId,
    contact_id: contactId,
    old_key: oldKey,
    new_key: newKey,
    old_fp: oldFp,
    new_fp: newFp,
  });
}

/** Fetch the full key-change history for a specific contact. */
export async function fetchContactKeyHistory(
  ownerId: string,
  contactId: string,
): Promise<{ id: string; old_fp: string; new_fp: string; changed_at: string }[]> {
  const { data } = await supabase
    .from('contact_key_history')
    .select('id, old_fp, new_fp, changed_at')
    .eq('owner_id', ownerId)
    .eq('contact_id', contactId)
    .order('changed_at', { ascending: false });
  return data ?? [];
}

// ========================
// CONTACT REQUESTS
// ========================


/** Send a contact request from sender to receiver (username-search path, no QR token). */
export async function sendContactRequest(
  senderId: string,
  receiverId: string,
  senderPublicKey?: string | null,
): Promise<{ error: string | null }> {
  // If a previous request exists (could be rejected), delete it first so a
  // fresh INSERT is always allowed. A rejected request should not block re-sends.
  await supabase
    .from('contact_requests')
    .delete()
    .eq('sender_id', senderId)
    .eq('receiver_id', receiverId)
    .eq('status', 'rejected');

  const { error } = await supabase
    .from('contact_requests')
    .insert({ sender_id: senderId, receiver_id: receiverId, sender_public_key: senderPublicKey ?? null });
  if (error) {
    if (error.code === '23505') return { error: 'You have already sent a request to this user.' };
    return { error: error.message };
  }
  return { error: null };
}

/**
 * Send a contact request through the QR code path.
 * The qr_token is validated server-side against profiles.qr_token before
 * the contact_requests row is inserted. Stale / rotated tokens are rejected.
 */
export async function sendContactRequestViaQR(
  receiverId: string,
  qrToken: string,
  senderPublicKey?: string | null,
): Promise<{ error: string | null }> {
  const { error } = await supabase.rpc('send_contact_request_via_qr', {
    p_receiver_id: receiverId,
    p_qr_token: qrToken,
    p_sender_public_key: senderPublicKey ?? null,
  });
  if (error) {
    const hint = (error as { hint?: string }).hint ?? error.message;
    if (hint.includes('invalid_qr_token') || error.message.includes('invalid_qr_token')) {
      return { error: 'Invalid QR code. Ask your contact to show their current QR code.' };
    }
    if (hint.includes('qr_token_expired') || error.message.includes('qr_token_expired')) {
      return { error: 'This QR code has expired. Ask your contact to regenerate it.' };
    }
    if (hint.includes('already_requested') || error.message.includes('already_requested') || error.code === '23505') {
      return { error: 'You have already sent a request to this user.' };
    }
    return { error: error.message };
  }
  return { error: null };
}

/**
 * Add a contact in both directions without approval when a valid QR token is scanned.
 * Returns the newly-created contact row for the current user (sender -> receiver).
 */
export async function addContactViaQR(
  receiverId: string,
  qrToken: string,
): Promise<{ error: string | null; contact?: Contact }> {
  const { data, error } = await supabase.rpc('add_contact_via_qr', {
    p_receiver_id: receiverId,
    p_qr_token: qrToken,
  });
  if (error) {
    const hint = (error as { hint?: string }).hint ?? error.message;
    if (hint.includes('invalid_qr_token') || error.message.includes('invalid_qr_token')) {
      return { error: 'Invalid QR code. Ask your contact to show their current QR code.' };
    }
    if (hint.includes('qr_token_expired') || error.message.includes('qr_token_expired')) {
      return { error: 'This QR code has expired. Ask your contact to regenerate it.' };
    }
    if (hint.includes('receiver_key_missing') || error.message.includes('receiver_key_missing')) {
      return { error: "The scanned user hasn't finished setting up their vault. Ask them to log in first." };
    }
    return { error: error.message };
  }
  const payload = data as {
    ok: boolean;
    conversation_id: string;
    receiver: { id: string; username: string; public_key: string; fingerprint: string };
  } | null;
  if (!payload?.receiver) return { error: 'Unexpected server response.' };
  return {
    error: null,
    contact: {
      id: payload.receiver.id,
      username: payload.receiver.username,
      publicKey: payload.receiver.public_key,
      fingerprint: payload.receiver.fingerprint,
      conversationId: payload.conversation_id,
      addedAt: Date.now(),
      verifiedViaQR: true,
      originalFingerprint: payload.receiver.fingerprint,
    },
  };
}

/** Fetch all PENDING incoming requests for a user, enriched with sender profile. */
export async function fetchIncomingRequests(userId: string): Promise<ContactRequest[]> {
  const { data, error } = await supabase
    .from('contact_requests')
    .select('*')
    .eq('receiver_id', userId)
    .eq('status', 'pending')
    .order('created_at', { ascending: true });

  if (error || !data) return [];

  const enriched: ContactRequest[] = await Promise.all(
    data.map(async (req: any) => {
      const { data: profile } = await supabase
        .from('public_profiles')
        .select('username, public_key')
        .eq('id', req.sender_id)
        .maybeSingle();
      return {
        ...req,
        senderUsername: profile?.username ?? 'Unknown',
        // Prefer the key embedded in the request row (written at send-time);
        // fall back to the live profile key in case of old rows.
        senderPublicKey: (req.sender_public_key ?? profile?.public_key) ?? undefined,
      };
    })
  );
  return enriched;
}

/** Fetch PENDING outgoing requests sent by this user. */
export async function fetchOutgoingRequests(userId: string): Promise<ContactRequest[]> {
  const { data, error } = await supabase
    .from('contact_requests')
    .select('*')
    .eq('sender_id', userId)
    .eq('status', 'pending')
    .order('created_at', { ascending: true });
  if (error || !data) return [];

  // Enrich with receiver username + public key (needed to save contact when accepted)
  const enriched: ContactRequest[] = await Promise.all(
    data.map(async (req: any) => {
      const { data: profile } = await supabase
        .from('public_profiles')
        .select('username, public_key')
        .eq('id', req.receiver_id)
        .maybeSingle();
      return {
        ...req,
        receiverUsername: profile?.username ?? 'Unknown',
        receiverPublicKey: profile?.public_key ?? undefined,
      };
    })
  );
  return enriched;
}

/** Accept a contact request — updates status to 'accepted'. */
export async function acceptContactRequest(requestId: string): Promise<{ error: string | null }> {
  const { error } = await supabase
    .from('contact_requests')
    .update({ status: 'accepted' })
    .eq('id', requestId);
  if (error) return { error: error.message };
  return { error: null };
}

/** Reject a contact request — updates status to 'rejected'. */
export async function rejectContactRequest(requestId: string): Promise<{ error: string | null }> {
  const { error } = await supabase
    .from('contact_requests')
    .update({ status: 'rejected' })
    .eq('id', requestId);
  if (error) return { error: error.message };
  return { error: null };
}

/** Check pending/accepted status from sender to receiver. */
export async function getRequestStatus(
  senderId: string,
  receiverId: string
): Promise<'pending' | 'accepted' | 'rejected' | null> {
  const { data } = await supabase
    .from('contact_requests')
    .select('status')
    .eq('sender_id', senderId)
    .eq('receiver_id', receiverId)
    .maybeSingle();
  return (data?.status as ContactRequest['status']) ?? null;
}

/** Subscribe to incoming contact requests via Supabase Realtime. */
export function subscribeToContactRequests(
  userId: string,
  onNew: (req: ContactRequest) => void,
  onReconnect?: () => void
) {
  const channel = supabase
    .channel(`contact-requests-${userId}`)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'contact_requests',
        filter: `receiver_id=eq.${userId}`,
      },
      async (payload: any) => {
        const req = payload.new as ContactRequest & { sender_public_key?: string | null };
        const { data: profile } = await supabase
          .from('public_profiles')
          .select('username, public_key')
          .eq('id', req.sender_id)
          .maybeSingle();
        onNew({
          ...req,
          senderUsername: profile?.username ?? 'Unknown',
          // Prefer the key embedded in the row; fall back to live profile key.
          senderPublicKey: (req.sender_public_key ?? profile?.public_key) ?? undefined,
        });
      }
    )
    .subscribe((status: any) => {
      if (status === 'SUBSCRIBED' && onReconnect) onReconnect();
    });

  return () => { supabase.removeChannel(channel); };
}

/**
 * Subscribe to UPDATE events on outgoing contact requests.
 * When the receiver accepts or rejects, the status changes — this fires onStatusChange.
 * Used to automatically remove accepted/rejected requests from the sender's outgoing list.
 */
export function subscribeToOutgoingRequestUpdates(
  userId: string,
  onStatusChange: (requestId: string, status: 'accepted' | 'rejected') => void,
  onReconnect?: () => void
) {
  const channel = supabase
    .channel(`outgoing-requests-${userId}`)
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'contact_requests',
        filter: `sender_id=eq.${userId}`,
      },
      (payload: any) => {
        const updated = payload.new as ContactRequest;
        if (updated.status === 'accepted' || updated.status === 'rejected') {
          onStatusChange(updated.id, updated.status);
        }
      }
    )
    .subscribe((status: any) => {
      if (status === 'SUBSCRIBED' && onReconnect) onReconnect();
    });

  return () => { supabase.removeChannel(channel); };
}

/** Cancel an outgoing contact request (sender deletes their own request). */
export async function cancelContactRequest(requestId: string): Promise<{ error: string | null }> {
  const { error } = await supabase
    .from('contact_requests')
    .delete()
    .eq('id', requestId);
  if (error) return { error: error.message };
  return { error: null };
}

/** Delete any contact_request record between two users (either direction).
 *  Called on contact removal so the pair can re-add each other cleanly. */
export async function deleteContactRequestBetween(
  userId: string,
  otherId: string
): Promise<void> {
  // Delete A→B
  await supabase
    .from('contact_requests')
    .delete()
    .eq('sender_id', userId)
    .eq('receiver_id', otherId);
  // Delete B→A
  await supabase
    .from('contact_requests')
    .delete()
    .eq('sender_id', otherId)
    .eq('receiver_id', userId);
}

/**
 * Delete all relay messages in both directions between two users.
 * Uses the server-side SECURITY DEFINER function so that each side's
 * relay messages can be cleared regardless of who initiates the deletion.
 */
export async function deleteRelayMessagesBetween(
  userIdA: string,
  userIdB: string
): Promise<void> {
  const { error } = await supabase.rpc('delete_relay_messages_between', {
    p_user_a: userIdA,
    p_user_b: userIdB,
  });
  if (error) {
    console.error('[SylvaCrypt] deleteRelayMessagesBetween error:', error.message);
  }
}

// ========================
// BLOCK / UNBLOCK
// ========================

/** Block a user. Returns error string or null on success. */
export async function blockUser(blockedId: string): Promise<{ error: string | null }> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Not authenticated' };
  const { error } = await supabase
    .from('blocked_users')
    .insert({ blocker_id: user.id, blocked_id: blockedId });
  if (error) return { error: error.message };
  return { error: null };
}

/** Unblock a user. */
export async function unblockUser(blockedId: string): Promise<{ error: string | null }> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Not authenticated' };
  const { error } = await supabase
    .from('blocked_users')
    .delete()
    .eq('blocker_id', user.id)
    .eq('blocked_id', blockedId);
  if (error) return { error: error.message };
  return { error: null };
}

/** Fetch list of user IDs blocked by current user. */
export async function fetchBlockedUserIds(): Promise<string[]> {
  const { data } = await supabase
    .from('blocked_users')
    .select('blocked_id');
  return (data ?? []).map((r: any) => r.blocked_id as string);
}

/** Check if a specific user is blocked by the current user. */
export async function isUserBlocked(targetId: string): Promise<boolean> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return false;
  const { data } = await supabase
    .from('blocked_users')
    .select('id')
    .eq('blocker_id', user.id)
    .eq('blocked_id', targetId)
    .maybeSingle();
  return !!data;
}

// ========================
// TYPING INDICATORS
// ========================

// ── Typing Indicator ──────────────────────────────────────────────────────────
// We keep ONE persistent channel per conversation for both broadcasting and
// receiving typing events. Re-using the same channel object avoids the race
// where broadcastTyping() called removeChannel() on the very channel that
// subscribeToTyping() was listening on (because supabase.channel(name) returns
// the cached instance when the name already exists in the registry).

const typingChannels = new Map<string, ReturnType<typeof supabase.channel>>();

function getOrCreateTypingChannel(conversationId: string) {
  const key = `typing:${conversationId}`;
  if (!typingChannels.has(key)) {
    const ch = supabase.channel(key, { config: { broadcast: { self: false } } });
    typingChannels.set(key, ch);
  }
  return typingChannels.get(key)!;
}

/** Broadcast a typing event. Reuses the persistent typing channel. */
export function broadcastTyping(
  conversationId: string,
  senderId: string,
  senderUsername: string
) {
  const channel = getOrCreateTypingChannel(conversationId);
  const doSend = () => {
    return channel.send({
      type: 'broadcast',
      event: 'typing',
      payload: { senderId, senderUsername, conversationId },
    });
  };

  const attemptSend = (retries = 20) => {
    doSend().catch(() => {
      if (retries > 0) {
        setTimeout(() => attemptSend(retries - 1), 100);
      }
    });
  };

  const state = (channel as unknown as { state: string }).state;
  if (state !== 'joined' && state !== 'joining') {
    channel.subscribe();
  }
  
  attemptSend();
}

/** Subscribe to typing events in a conversation. Returns unsubscribe fn. */
export function subscribeToTyping(
  conversationId: string,
  myUserId: string,
  onTyping: (senderId: string) => void
): () => void {
  const channel = getOrCreateTypingChannel(conversationId);

  // Validate conversationId in payload to prevent stale listeners accumulated
  // across conversation switches from firing for the wrong chat.
  const handler = (payload: { payload: { senderId: string; conversationId?: string } }) => {
    const { senderId, conversationId: evtConvId } = payload.payload;
    if (senderId === myUserId) return;
    // If the event carries a conversationId, make sure it matches this channel.
    if (evtConvId && evtConvId !== conversationId) return;
    onTyping(senderId);
  };

  channel.on('broadcast', { event: 'typing' }, handler);

  if ((channel as unknown as { state: string }).state !== 'joined') {
    channel.subscribe();
  }

  // Return a no-op teardown — the channel stays alive for the session.
  // The ChatArea useEffect dependency on conversation.id means this is
  // called each time the conversation changes; we intentionally keep the
  // channel registered so broadcastTyping() can reuse it immediately.
  return () => { /* channel kept alive intentionally */ };
}

/** Fetch blocked user profiles for display in the blocklist. */
export async function fetchBlockedUsers(): Promise<{ id: string; username: string }[]> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];
  const { data: blocked } = await supabase
    .from('blocked_users')
    .select('blocked_id')
    .eq('blocker_id', user.id);
  if (!blocked || blocked.length === 0) return [];
  const ids = blocked.map((r: any) => r.blocked_id as string);
  const { data: profiles } = await supabase
    .from('public_profiles')
    .select('id, username')
    .in('id', ids);
  return (profiles ?? []).map((p: any) => ({ id: p.id as string, username: p.username as string }));
}

// ========================
// MUTUAL CONTACT REMOVAL
// ========================

/**
 * Notify the other party that they have been removed from this user's contacts.
 * Upserts a contact_removals row (UNIQUE constraint on remover_id, removed_id
 * prevents duplicate rows when the same pair removes each other multiple times).
 */
export async function notifyContactRemoval(removedId: string, isBlock: boolean = false): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;
  // First delete any stale row to ensure a new INSERT event is fired by Realtime
  await supabase
    .from('contact_removals')
    .delete()
    .eq('remover_id', user.id)
    .eq('removed_id', removedId);
    
  await supabase
    .from('contact_removals')
    .insert({ remover_id: user.id, removed_id: removedId, is_block: isBlock });
}

/**
 * Clear all contact_removals rows between two users (both directions).
 * Must be called when two users re-add each other so that stale removal
 * notifications from a previous removal cycle never trigger a spurious
 * re-removal on the next login drain (fetchPendingRemovals).
 *
 * Uses the SECURITY DEFINER RPC so a single client call clears both the
 * A→B and B→A rows regardless of which party initiates it.
 */
export async function clearContactRemovalsBetween(
  userIdA: string,
  userIdB: string
): Promise<void> {
  const { error } = await supabase.rpc('clear_contact_removals_between', {
    p_user_id_a: userIdA,
    p_user_id_b: userIdB,
  });
  if (error) console.warn('[SylvaCrypt] clearContactRemovalsBetween failed (non-fatal):', error.message);
}

/**
 * Fetch any pending contact removal notifications that arrived while the user
 * was offline (Realtime only delivers live inserts, not existing rows).
 * Returns an array of remover_ids.
 */
export async function fetchPendingRemovals(userId: string): Promise<{removerId: string, isBlock: boolean}[]> {
  const { data, error } = await supabase
    .from('contact_removals')
    .select('remover_id, is_block, id')
    .eq('removed_id', userId);
  if (error || !data || data.length === 0) return [];

  // Delete processed rows before returning so that a subsequent login won't
  // re-process the same notifications even if the caller crashes mid-flight.
  const ids = data.map((r: any) => r.id as string);
  await supabase.from('contact_removals').delete().in('id', ids);

  return data.map((r: any) => ({ removerId: r.remover_id as string, isBlock: r.is_block as boolean }));
}

/**
 * Subscribe to contact_removals for the current user.
 * When another user removes us from their contacts, we mirror that locally.
 */
export function subscribeToContactRemovals(
  userId: string,
  onRemoved: (payload: {removerId: string, isBlock: boolean}) => void
): () => void {
  const channel = supabase
    .channel(`contact-removals-${userId}`)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'contact_removals',
        filter: `removed_id=eq.${userId}`,
      },
      async (payload: any) => {
        const row = payload.new as { remover_id: string; id: string; is_block: boolean };
        onRemoved({ removerId: row.remover_id, isBlock: row.is_block });
        // Delete the row immediately so it isn't replayed by fetchPendingRemovals
        // on the next login.  Must be awaited — a fire-and-forget here is the
        // root cause of ghost-removal: if the delete is skipped by the event loop
        // the stale row survives and triggers a spurious re-removal on next login.
        const { error } = await supabase
          .from('contact_removals')
          .delete()
          .eq('id', row.id);
        if (error) {
          console.warn('[SylvaCrypt] contact_removals cleanup failed — retrying:', error.message);
          // One retry with a short delay to handle transient network errors.
          // refreshSession() was removed to avoid concurrent-refresh races
          // that cause random message drops on the main relay channel.
          setTimeout(async () => {
            await supabase.from('contact_removals').delete().eq('id', row.id).then(null, () => {});
          }, 2000);
        }
      }
    )
    .subscribe();

  return () => { supabase.removeChannel(channel); };
}

// ========================
// MULTI-DEVICE CONTACT SYNC
// ========================

/**
 * Re-derive the contact list from accepted contact_requests on this Supabase account.
 * Returns an array of { userId, username, publicKey } that the caller can use to
 * re-populate the local encrypted store on a fresh device.
 */
export async function fetchAcceptedContacts(
  myUserId: string
): Promise<{ userId: string; username: string; publicKey: string }[]> {
  const { data: sent } = await supabase
    .from('contact_requests')
    .select('receiver_id')
    .eq('sender_id', myUserId)
    .eq('status', 'accepted');

  const { data: received } = await supabase
    .from('contact_requests')
    .select('sender_id, sender_public_key')
    .eq('receiver_id', myUserId)
    .eq('status', 'accepted');

  const peerIds = [
    ...((sent ?? []).map((r: any) => r.receiver_id as string)),
    ...((received ?? []).map((r: any) => r.sender_id as string)),
  ];
  if (peerIds.length === 0) return [];

  const { data: profiles } = await supabase
    .from('public_profiles')
    .select('id, username, public_key')
    .in('id', peerIds);

  const profileMap = new Map<string, any>(
    (profiles ?? []).map((p: any) => [p.id as string, p])
  );

  return peerIds.map(peerId => {
    const profile = profileMap.get(peerId);
    // For requests the current user received, the original request carried
    // the sender's public key. Use that as a fallback when the profile row
    // hasn't been populated yet, which commonly happens for users who
    // haven't re-synced their keys to public_profiles.
    const requestKey = (received ?? []).find((r: any) => r.sender_id === peerId)?.sender_public_key as string | undefined;
    const publicKey = profile?.public_key ?? requestKey ?? null;
    if (!publicKey) return null;
    return {
      userId: peerId,
      username: (profile?.username as string) ?? peerId,
      publicKey,
    };
  }).filter((p): p is { userId: string; username: string; publicKey: string } => p !== null);
}

// ========================
// PUSH NOTIFICATIONS
// ========================

export interface PushPayload {
  targetUserId: string;
  title: string;
  message: string;
  tag?: string;
  url?: string;
  /** End-to-end encrypted payload fields — when present, title/message are ciphertext. */
  encrypted?: {
    ephPub: string;
    iv: string;
    ciphertext: string;
  };
}

/**
 * Send a push notification to another user's subscribed devices.
 * The actual delivery is handled by the `push-notify` Edge Function using
 * the server-side VAPID private key.
 */
export async function sendPushNotification(payload: PushPayload): Promise<void> {
  const body: Record<string, unknown> = {
    target_user_id: payload.targetUserId,
    tag: payload.tag,
    url: payload.url,
  };
  if (payload.encrypted) {
    body.encrypted = payload.encrypted;
    body.title = payload.title;      // public fallback shown if decryption fails
    body.message = payload.message;
  } else {
    body.title = payload.title;
    body.message = payload.message;
  }
  const { error } = await supabase.functions.invoke('push-notify', { body });
  if (error) {
    console.warn('[SylvaCrypt] push notification failed:', error.message);
  }
}

/**
 * Notify a contact that they missed a call from the current user.
 * The caller identity is end-to-end encrypted with the recipient's public key.
 */
export async function notifyMissedCall(targetUserId: string, callerUsername: string): Promise<void> {
  const publicKey = await getUserPublicKey(targetUserId).catch(() => null);
  if (!publicKey) {
    await sendPushNotification({
      targetUserId,
      title: 'SylvaCrypt',
      message: 'You have a missed call',
      tag: `missed-call-${targetUserId}`,
      url: '/chat',
    });
    return;
  }
  const encrypted = await encryptPushPayload(publicKey, { callerUsername });
  await sendPushNotification({
    targetUserId,
    title: 'SylvaCrypt',
    message: 'You have a missed call',
    tag: `missed-call-${targetUserId}`,
    url: '/chat',
    encrypted,
  });
}

/**
 * Notify a contact that a new encrypted message is waiting in their vault.
 * The sender identity is end-to-end encrypted with the recipient's public key.
 */
export async function notifyNewMessage(targetUserId: string, senderUsername: string): Promise<void> {
  const publicKey = await getUserPublicKey(targetUserId).catch(() => null);
  if (!publicKey) {
    await sendPushNotification({
      targetUserId,
      title: 'SylvaCrypt',
      message: 'New activity in your vault',
      tag: `new-message-${targetUserId}`,
      url: '/chat',
    });
    return;
  }
  const encrypted = await encryptPushPayload(publicKey, { senderUsername });
  await sendPushNotification({
    targetUserId,
    title: 'SylvaCrypt',
    message: 'New activity in your vault',
    tag: `new-message-${targetUserId}`,
    url: '/chat',
    encrypted,
  });
}

/**
 * Batch-refresh public keys for all contacts by comparing their stored key
 * against their current profiles.public_key.
 *
 * v2 behaviour: returns KeyChangeAlert entries for contacts whose key has
 * changed AND whose fingerprint was previously QR-verified (the only meaningful
 * trust anchor).  Non-verified contacts silently get their key updated — they
 * never established a trust baseline so there is nothing to warn about.
 * Blocking a non-verified contact on key change was producing false positives
 * (e.g. when our key-sync backfill first wrote a valid key for a new account).
 *
 * Returns a tuple:
 *   [0] Map<contactId, freshPublicKey>  — every contact whose key was stale
 *   [1] KeyChangeAlert[]               — subset that was QR-verified and changed
 */
export async function refreshContactPublicKeys(
  ownerId: string,
  contacts: Array<{ id: string; username: string; publicKey: string; fingerprint: string; verifiedViaQR?: boolean }>,
): Promise<[Map<string, string>, KeyChangeAlert[]]> {
  const updated = new Map<string, string>();
  const alerts: KeyChangeAlert[] = [];
  if (contacts.length === 0) return [updated, alerts];

  const contactIds = contacts.map(c => c.id);
  const { data: profiles } = await supabase
    .from('public_profiles')
    .select('id, public_key')
    .in('id', contactIds);

  if (!profiles) return [updated, alerts];

  const storedMap = new Map(contacts.map(c => [c.id, c]));

  await Promise.all(profiles.map(async (profile: any) => {
    const freshKey = profile.public_key as string | null;
    if (!freshKey) return;
    const stored = storedMap.get(profile.id as string);
    if (!stored || stored.publicKey === freshKey) return;

    // Key has changed — compute both fingerprints
    const [oldFP, newFP] = await Promise.all([
      computeFingerprint(stored.publicKey),
      computeFingerprint(freshKey),
    ]);

    // Update DB so the app remains functional (relay encrypts to new key)
    await updateContactPublicKey(ownerId, profile.id as string, freshKey);
    updated.set(profile.id as string, freshKey);

    // Only surface a BLOCKING alert if this contact was previously QR-verified.
    // Non-verified contacts have no established trust baseline, so silently
    // updating their key avoids false-positive blocks (e.g. key-sync backfill).
    if (stored.verifiedViaQR) {
      alerts.push({
        contactId: profile.id as string,
        username: stored.username,
        oldFingerprint: oldFP,
        newFingerprint: newFP,
        newPublicKey: freshKey,
      });
    }
  }));

  return [updated, alerts];
}
