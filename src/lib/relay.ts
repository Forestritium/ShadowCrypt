/**
 * Relay messaging service: uses Supabase Realtime as a zero-knowledge relay.
 * Messages are encrypted client-side BEFORE being sent.
 * The server only sees opaque ciphertext and routes it to the recipient.
 * Messages are deleted from the relay table after delivery.
 */

import { supabase } from '@/db/supabase';
import type { EncryptedEnvelope, RelayMessage, ContactRequest } from '@/types/types';
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
} from './localStore';
import { saveMessageToDBFull, updateContactPublicKey } from './dbStore';
import type { LocalMessage } from '@/types/types';

const IMAGE_DAILY_LIMIT = 10;

/** Returns today's image send count for the user. */
export async function getTodayImageCount(userId: string): Promise<number> {
  const { data, error } = await supabase.rpc('get_image_send_count', { p_user_id: userId });
  if (error) return 0;
  return (data as number) ?? 0;
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

  const keyBase64 = btoa(String.fromCharCode(...rawKey));
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
 * The plaintext bytes never leave the browser.
 * Returns the storage path and the base64-encoded decryption key.
 * The key MUST be transmitted inside the Double Ratchet ciphertext — never in cleartext.
 * Throws ImageLimitError if the user has hit their daily 10-image cap.
 */
export async function uploadChatImage(
  userId: string,
  file: File
): Promise<{ storagePath: string; imageKeyBase64: string }> {
  // Rate-limit check (read-only, before upload)
  const count = await getTodayImageCount(userId);
  if (count >= IMAGE_DAILY_LIMIT) {
    const reset = new Date();
    reset.setUTCHours(24, 0, 0, 0);
    throw new ImageLimitError(reset);
  }

  const { blob: ciphertextBlob, keyBase64 } = await encryptFileAESGCM(file);

  // Store as opaque encrypted blob; extension .enc signals no public content type
  const storagePath = `${userId}/${crypto.randomUUID()}.enc`;
  const { error: uploadErr } = await supabase.storage
    .from('chat-images')
    .upload(storagePath, ciphertextBlob, { contentType: 'application/octet-stream', upsert: false });
  if (uploadErr) throw new Error(`Image upload failed: ${uploadErr.message}`);

  // Atomically increment counter after successful upload
  await supabase.rpc('increment_image_send_count', { p_user_id: userId });

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
    .createSignedUrl(storagePath, 3600);
  if (signErr || !signedData?.signedUrl) throw new Error('Failed to create signed URL');

  const response = await fetch(signedData.signedUrl);
  if (!response.ok) throw new Error(`Failed to fetch encrypted image: ${response.status}`);
  const ciphertextBlob = await response.blob();

  const plainbuf = await decryptBlobAESGCM(ciphertextBlob, imageKeyBase64);
  return URL.createObjectURL(new Blob([plainbuf]));
}

// Send an encrypted message to a recipient
export async function sendEncryptedMessage(
  senderId: string,
  senderUsername: string,
  recipientId: string,
  conversationId: string,
  plaintext: string,
  recipientPublicKey: string,
  messageId?: string,  // caller can pass a stable ID so DB row matches optimistic UI entry
  imageAttachment?: { storagePath: string; imageKeyBase64: string }, // encrypted image metadata
  replyTo?: import('@/types/types').ReplyTo | null // optional reply context
): Promise<LocalMessage> {
  // Get or initialize ratchet session
  let session = await getRatchetSession(conversationId);
  const myKP = await getIdentityKeyPair();
  if (!myKP) throw new Error('Identity key pair not found. Please re-login.');

  // Resolve the effective recipient public key, auto-healing stale/legacy keys.
  let effectivePubKey = recipientPublicKey;

  const tryInitSession = async () => {
    if (!session) {
      try {
        session = await initSessionSender(
          conversationId,
          myKP.privateKeyBase64,
          effectivePubKey
        );
      } catch (err) {
        if ((err as Error).message?.startsWith('LEGACY_KEY_FORMAT')) {
          // The stored key is a legacy P-256 key — fetch the latest key from the profile.
          const freshKey = await getUserPublicKey(recipientId);
          if (!freshKey || freshKey === effectivePubKey) {
            // Contact has not yet re-logged-in with an X25519 key.
            throw new Error(
              'LEGACY_KEY_FORMAT: This contact needs to re-login to update their encryption key before you can message them.'
            );
          }
          // Fresh key available — update stored contact and retry once.
          await updateContactPublicKey(senderId, recipientId, freshKey);
          effectivePubKey = freshKey;
          session = await initSessionSender(
            conversationId,
            myKP.privateKeyBase64,
            effectivePubKey
          );
        } else {
          throw err;
        }
      }
    }
  };

  await tryInitSession();

  // TypeScript cannot narrow through the async closure — session is guaranteed
  // non-null here because tryInitSession throws on every failure path.
  if (!session) throw new Error('Failed to initialize ratchet session.');

  // If there is an image attachment, embed the storage path and AES key INSIDE the
  // ratchet plaintext so they travel encrypted end-to-end and are never visible to
  // the relay operator.  Plain text-only messages stay as a bare string (backward compat).
  let ratchetPlaintext = plaintext;
  if (imageAttachment) {
    ratchetPlaintext = JSON.stringify({
      v: 2,
      t: plaintext,
      isp: imageAttachment.storagePath,
      ik: imageAttachment.imageKeyBase64,
    });
  }

  // Encrypt with Double Ratchet
  const { envelope, updatedSession } = await ratchetEncrypt(session, ratchetPlaintext);
  await saveRatchetSession(updatedSession);

  // replyTo is non-secret metadata (snippet + sender info already known to both parties)
  // and is included outside the ratchet ciphertext for relay routing.
  const extras: Record<string, unknown> = {};
  if (replyTo) extras.replyTo = replyTo;
  const payload = JSON.stringify(Object.keys(extras).length ? { ...envelope, ...extras } : envelope);

  // Insert into relay (server never stores plaintext)
  const { error } = await supabase
    .from('relay_messages')
    .insert({
      recipient_id: recipientId,
      sender_id: senderId,
      conversation_id: conversationId,
      encrypted_payload: payload,
    });

  if (error) throw new Error(`Relay failed: ${error.message}`);

  const localMsg: LocalMessage = {
    id: messageId ?? crypto.randomUUID(),
    conversationId,
    senderId,
    senderUsername,
    content: plaintext,
    timestamp: Date.now(),
    status: 'sent',
    isOwn: true,
    imageUrl: null,
    imageStoragePath: imageAttachment?.storagePath ?? null,
    imageKeyBase64: imageAttachment?.imageKeyBase64 ?? null,
    replyTo: replyTo ?? null,
  };

  // Save sender's copy to DB (persists across logout/login)
  await saveMessageToDBFull(senderId, recipientId, localMsg);
  return localMsg;
}

// Receive and decrypt a relay message
export async function receiveAndDecryptMessage(
  relayMessage: RelayMessage,
  myUserId: string,
  myUsername: string,
  senderUsername: string,
  senderPublicKey: string
): Promise<LocalMessage | null> {
  const conversationId = relayMessage.conversation_id;
  try {
    const envelope: EncryptedEnvelope = JSON.parse(relayMessage.encrypted_payload);

    // Get or initialize receiving session
    let session = await getRatchetSession(conversationId);
    const myKP = await getIdentityKeyPair();
    if (!myKP) return null;

    if (!session) {
      session = await initSessionReceiver(
        conversationId,
        myKP.privateKeyBase64,
        myKP.publicKeyBase64,
        senderPublicKey
      );
    }

    // Detect stale session: envelope uses encrypted headers (v2.4.0+) but the
    // stored session predates header encryption and lacks the HK field.
    // Clear the stale session so the next attempt re-initializes it with HK.
    if (envelope.encryptedHeader && !session.HK) {
      console.warn('[ShadowCrypt] Stale session missing HK — clearing for re-init on next attempt');
      await deleteRatchetSession(conversationId);
      // Re-initialize immediately so this message can still be decrypted
      session = await initSessionReceiver(
        conversationId,
        myKP.privateKeyBase64,
        myKP.publicKeyBase64,
        senderPublicKey
      );
    }

    // Decrypt with Double Ratchet
    const { plaintext: decrypted, updatedSession } = await ratchetDecrypt(session, envelope);
    await saveRatchetSession(updatedSession);

    // If the decrypted payload is a v2 structured message, extract text and image metadata.
    // Image storage path and AES key travelled securely inside the ratchet ciphertext.
    let content = decrypted;
    let imageStoragePath: string | null = null;
    let imageKeyBase64: string | null = null;
    try {
      const parsed: { v?: number; t?: string; isp?: string; ik?: string } = JSON.parse(decrypted);
      if (parsed.v === 2) {
        content = parsed.t ?? '';
        imageStoragePath = parsed.isp ?? null;
        imageKeyBase64 = parsed.ik ?? null;
      }
    } catch { /* plain-text message — leave content unchanged */ }

    type PayloadExtras = { replyTo?: import('@/types/types').ReplyTo };
    const extras = envelope as EncryptedEnvelope & PayloadExtras;

    const localMsg: LocalMessage = {
      id: relayMessage.id,
      conversationId,
      senderId: relayMessage.sender_id,
      senderUsername,
      content,
      timestamp: new Date(relayMessage.created_at).getTime(),
      status: 'delivered',
      isOwn: relayMessage.sender_id === myUserId,
      imageUrl: null,
      imageStoragePath,
      imageKeyBase64,
      replyTo: extras.replyTo ?? null,
    };

    // Save receiver's copy to DB — owner_id = myUserId (the recipient saving their copy),
    // recipient_id = myUserId (the actual recipient of this message, not the sender).
    await saveMessageToDBFull(myUserId, myUserId, localMsg);

    // Delete from relay after successful decryption (zero-knowledge relay)
    await supabase
      .from('relay_messages')
      .delete()
      .eq('id', relayMessage.id)
      .eq('recipient_id', myUserId);

    void myUsername; // suppress unused warning
    return localMsg;
  } catch (err) {
    console.error('[ShadowCrypt] Failed to decrypt relay message:', err);
    // If decryption failed (possibly due to a session state mismatch), clear the
    // ratchet session so the next fetch attempt re-initializes it from scratch.
    // The relay message is NOT deleted here so it can be retried.
    await deleteRatchetSession(conversationId).catch(() => {/* ignore cleanup errors */});
    return null;
  }
}

// Fetch any pending relay messages (for when user was offline)
export async function fetchPendingRelayMessages(userId: string): Promise<RelayMessage[]> {
  const { data, error } = await supabase
    .from('relay_messages')
    .select('*')
    .eq('recipient_id', userId)
    .order('created_at', { ascending: true })
    .limit(200);

  if (error) {
    console.error('[ShadowCrypt] Failed to fetch pending messages:', error);
    return [];
  }
  return (data ?? []) as RelayMessage[];
}

// Subscribe to incoming relay messages via Supabase Realtime
export function subscribeToRelay(
  userId: string,
  onMessage: (msg: RelayMessage) => void
) {
  const channel = supabase
    .channel(`relay-${userId}`)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'relay_messages',
        filter: `recipient_id=eq.${userId}`,
      },
      payload => onMessage(payload.new as RelayMessage)
    )
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}

// Look up a user's public key by user ID
export async function getUserPublicKey(userId: string): Promise<string | null> {
  const { data } = await supabase
    .from('profiles')
    .select('public_key')
    .eq('id', userId)
    .maybeSingle();
  return data?.public_key ?? null;
}

// Look up a user's profile by username
export async function findUserByUsername(username: string) {
  const { data } = await supabase
    .from('profiles')
    .select('id, username, public_key')
    .ilike('username', username)
    .maybeSingle();
  return data;
}

// ========================
// CONTACT REQUESTS
// ========================


/** Send a contact request from sender to receiver. */
export async function sendContactRequest(
  senderId: string,
  receiverId: string
): Promise<{ error: string | null }> {
  const { error } = await supabase
    .from('contact_requests')
    .insert({ sender_id: senderId, receiver_id: receiverId });
  if (error) {
    if (error.code === '23505') return { error: 'You have already sent a request to this user.' };
    return { error: error.message };
  }
  return { error: null };
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
    data.map(async (req) => {
      const { data: profile } = await supabase
        .from('profiles')
        .select('username, public_key')
        .eq('id', req.sender_id)
        .maybeSingle();
      return {
        ...req,
        senderUsername: profile?.username ?? 'Unknown',
        senderPublicKey: profile?.public_key ?? undefined,
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
    data.map(async (req) => {
      const { data: profile } = await supabase
        .from('profiles')
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
  onNew: (req: ContactRequest) => void
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
      async (payload) => {
        const req = payload.new as ContactRequest;
        const { data: profile } = await supabase
          .from('profiles')
          .select('username, public_key')
          .eq('id', req.sender_id)
          .maybeSingle();
        onNew({
          ...req,
          senderUsername: profile?.username ?? 'Unknown',
          senderPublicKey: profile?.public_key ?? undefined,
        });
      }
    )
    .subscribe();

  return () => { supabase.removeChannel(channel); };
}

/**
 * Subscribe to UPDATE events on outgoing contact requests.
 * When the receiver accepts or rejects, the status changes — this fires onStatusChange.
 * Used to automatically remove accepted/rejected requests from the sender's outgoing list.
 */
export function subscribeToOutgoingRequestUpdates(
  userId: string,
  onStatusChange: (requestId: string, status: 'accepted' | 'rejected') => void
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
      (payload) => {
        const updated = payload.new as ContactRequest;
        if (updated.status === 'accepted' || updated.status === 'rejected') {
          onStatusChange(updated.id, updated.status);
        }
      }
    )
    .subscribe();

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
    console.error('[ShadowCrypt] deleteRelayMessagesBetween error:', error.message);
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
  return (data ?? []).map(r => r.blocked_id as string);
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
  // If already subscribed, send immediately; otherwise wait for SUBSCRIBED.
  const doSend = () => {
    channel.send({
      type: 'broadcast',
      event: 'typing',
      payload: { senderId, senderUsername, conversationId },
    }).catch(() => {/* fire-and-forget */});
  };

  if ((channel as unknown as { state: string }).state === 'joined') {
    doSend();
  } else {
    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') doSend();
    });
  }
}

/** Subscribe to typing events in a conversation. Returns unsubscribe fn. */
export function subscribeToTyping(
  conversationId: string,
  myUserId: string,
  onTyping: (senderId: string) => void
): () => void {
  const channel = getOrCreateTypingChannel(conversationId);

  channel.on('broadcast', { event: 'typing' }, (payload) => {
    const { senderId } = payload.payload as { senderId: string };
    if (senderId !== myUserId) onTyping(senderId);
  });

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
  const ids = blocked.map(r => r.blocked_id as string);
  const { data: profiles } = await supabase
    .from('profiles')
    .select('id, username')
    .in('id', ids);
  return (profiles ?? []).map(p => ({ id: p.id as string, username: p.username as string }));
}

// ========================
// MUTUAL CONTACT REMOVAL
// ========================

/**
 * Notify the other party that they have been removed from this user's contacts.
 * Inserts a contact_removals row so the other device picks it up via Realtime.
 */
export async function notifyContactRemoval(removedId: string): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;
  await supabase
    .from('contact_removals')
    .insert({ remover_id: user.id, removed_id: removedId });
}

/**
 * Fetch any pending contact removal notifications that arrived while the user
 * was offline (Realtime only delivers live inserts, not existing rows).
 * Returns an array of remover_ids.
 */
export async function fetchPendingRemovals(userId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('contact_removals')
    .select('remover_id, id')
    .eq('removed_id', userId);
  if (error || !data || data.length === 0) return [];

  // Clean up processed rows
  const ids = data.map(r => r.id as string);
  await supabase.from('contact_removals').delete().in('id', ids);

  return data.map(r => r.remover_id as string);
}

/**
 * Subscribe to contact_removals for the current user.
 * When another user removes us from their contacts, we mirror that locally.
 */
export function subscribeToContactRemovals(
  userId: string,
  onRemoved: (removerId: string) => void
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
      (payload) => {
        const row = payload.new as { remover_id: string };
        onRemoved(row.remover_id);
        // Clean up the row after processing
        supabase
          .from('contact_removals')
          .delete()
          .eq('remover_id', row.remover_id)
          .eq('removed_id', userId);
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
    .select('sender_id')
    .eq('receiver_id', myUserId)
    .eq('status', 'accepted');

  const peerIds = [
    ...((sent ?? []).map(r => r.receiver_id as string)),
    ...((received ?? []).map(r => r.sender_id as string)),
  ];
  if (peerIds.length === 0) return [];

  const { data: profiles } = await supabase
    .from('profiles')
    .select('id, username, public_key')
    .in('id', peerIds);

  return (profiles ?? [])
    .filter(p => p.public_key)
    .map(p => ({
      userId: p.id as string,
      username: p.username as string,
      publicKey: p.public_key as string,
    }));
}

/**
 * Batch-refresh public keys for all contacts by comparing their stored key
 * against their current profiles.public_key.  Any contact whose key has
 * changed gets updated in the local DB immediately.
 *
 * Returns a map of contactId → freshPublicKey for every contact whose key
 * was stale, so the caller can merge the changes into React state without a
 * full DB reload.
 */
export async function refreshContactPublicKeys(
  ownerId: string,
  contactIds: string[],
): Promise<Map<string, string>> {
  const updated = new Map<string, string>();
  if (contactIds.length === 0) return updated;

  const { data: profiles } = await supabase
    .from('profiles')
    .select('id, public_key')
    .in('id', contactIds);

  if (!profiles) return updated;

  // Fetch current stored keys in one go so we can diff them
  const { data: storedRows } = await supabase
    .from('contacts')
    .select('contact_id, public_key')
    .eq('owner_id', ownerId)
    .in('contact_id', contactIds);

  const storedMap = new Map<string, string>(
    (storedRows ?? []).map(r => [r.contact_id as string, r.public_key as string])
  );

  for (const profile of profiles) {
    const freshKey = profile.public_key as string | null;
    if (!freshKey) continue;
    const storedKey = storedMap.get(profile.id as string);
    if (storedKey === freshKey) continue; // already up to date
    await updateContactPublicKey(ownerId, profile.id as string, freshKey);
    updated.set(profile.id as string, freshKey);
  }

  return updated;
}
