/**
 * Supabase-backed store for contacts and messages.
 * Replaces IndexedDB localStore for these two entities.
 * Ratchet sessions, identity keys, and vault keys remain in IndexedDB.
 *
 * Message content is encrypted with the user's vault key (AES-256-GCM) before
 * being written to the database.  The server therefore only ever stores opaque
 * ciphertext — plaintext is never transmitted to or stored on any server.
 */

import { supabase } from '@/db/supabase';
import { encryptObject, decryptObject, computeFingerprint } from '@/lib/crypto';
import { getEncryptionKey, deleteRatchetSession } from '@/lib/localStore';
import type { Contact, LocalMessage } from '@/types/types';

// ── CONTENT ENCRYPTION HELPERS ───────────────────────────────────────────────

/**
 * Encrypt a message's plaintext content with the vault key.
 * Returns a base64(IV + AES-256-GCM ciphertext) string safe for DB storage.
 * Falls back to the plaintext (prefixed "__plain__:") if the vault is locked,
 * so callers can detect the situation gracefully.
 */
async function encryptContent(plaintext: string): Promise<string> {
  const key = getEncryptionKey();
  if (!key) {
    throw new Error('[SylvaCrypt] Cannot write message: vault key not loaded. Aborting to prevent plaintext storage.');
  }
  return encryptObject<string>(key, plaintext);
}

/**
 * Decrypt a stored content blob back to plaintext.
export async function getLastMessageTimes(ownerId: string): Promise<Record<string, number>> {
  const { data, error } = await supabase
    .from('messages')
    .select('conversation_id, created_at')
    .eq('owner_id', ownerId)
    .order('created_at', { ascending: false });
  if (error || !data) return {};
  const times: Record<string, number> = {};
  for (const row of data) {
    if (!times[row.conversation_id]) {
      times[row.conversation_id] = new Date(row.created_at).getTime();
    }
  }
  return times;
}

 * Handles legacy plaintext rows (those that start with "__plain__:" or were
 * stored before encryption was introduced) gracefully.
 */
async function decryptContent(stored: string): Promise<string> {
  // Legacy plaintext fallback (stored without encryption)
  if (stored.startsWith('__plain__:')) return stored.slice(10);
  const key = getEncryptionKey();
  if (!key) return '[locked — re-open vault to view]';
  try {
    return await decryptObject<string>(key, stored);
  } catch (err) {
    console.error('[dbStore] Decryption failed:', err);
    return '[decryption failed]';
  }
}

// ── CONTACTS ──────────────────────────────────────────────────────────────────

export async function getContactsFromDB(ownerId: string): Promise<Contact[]> {
  const { data, error } = await supabase
    .from('contacts')
    .select('*')
    .eq('owner_id', ownerId)
    .order('added_at', { ascending: true });

  if (error) {
    console.error('[dbStore] getContacts error:', error.message);
    return [];
  }

  // Always recompute fingerprint from the stored public_key so that it stays
  // consistent with the contact's own sidebar fingerprint even after key rotation
  // (the DB trigger keeps public_key current; fingerprint is derived here).
  return Promise.all(
    (data ?? []).map(async row => ({
      id: row.contact_id as string,
      username: row.username as string,
      publicKey: row.public_key as string,
      fingerprint: row.public_key
        ? await computeFingerprint(row.public_key as string)
        : (row.fingerprint as string),
      conversationId: row.conversation_id as string,
      addedAt: new Date(row.added_at as string).getTime(),
      verifiedViaQR: (row.verified_via_qr as boolean) ?? false,
      originalFingerprint: (row.original_fingerprint as string | null) ?? null,
    }))
  );
}

export async function saveContactToDB(ownerId: string, contact: Contact): Promise<void> {
  const { error } = await supabase
    .from('contacts')
    .upsert(
      {
        owner_id: ownerId,
        contact_id: contact.id,
        username: contact.username,
        public_key: contact.publicKey,
        fingerprint: contact.fingerprint,
        conversation_id: contact.conversationId,
        added_at: new Date(contact.addedAt).toISOString(),
        verified_via_qr: contact.verifiedViaQR ?? false,
        // Only set original_fingerprint on first insert; preserve existing value
        // by using a coalesce on the DB side via upsert ignoreDuplicates: false.
        // We achieve "write-once" by only including the field when it is provided.
        ...(contact.originalFingerprint != null
          ? { original_fingerprint: contact.originalFingerprint }
          : {}),
      },
      { onConflict: 'owner_id,contact_id' }
    );

  // Throw instead of silently logging — callers (handleAcceptRequest,
  // subscribeToOutgoingRequestUpdates) must know when the save failed so they
  // can surface an actionable error instead of showing a false success toast.
  if (error) throw new Error(`Failed to save contact: ${error.message}`);
}

export async function deleteContactFromDB(ownerId: string, contactId: string): Promise<void> {
  const { error } = await supabase
    .from('contacts')
    .delete()
    .eq('owner_id', ownerId)
    .eq('contact_id', contactId);

  if (error) console.error('[dbStore] deleteContact error:', error.message);
}

export async function removeContactAndMessagesFromDB(
  ownerId: string,
  contactId: string,
  conversationId: string
): Promise<void> {
  await Promise.all([
    deleteContactFromDB(ownerId, contactId),
    deleteConversationMessagesFromDB(ownerId, conversationId),
    // Clear the ratchet session so that if the contact is re-added later,
    // the Double Ratchet starts fresh with a clean, synchronized state.
    deleteRatchetSession(conversationId),
  ]);
}

// ── MESSAGES ──────────────────────────────────────────────────────────────────

export const MESSAGE_HISTORY_LIMIT = 500;

export async function getMessagesFromDB(
  ownerId: string,
  conversationId: string
): Promise<{ messages: LocalMessage[]; truncated: boolean }> {
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('owner_id', ownerId)
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .limit(MESSAGE_HISTORY_LIMIT);

  if (error) {
    console.error('[dbStore] getMessages error:', error.message);
    return { messages: [], truncated: false };
  }

  // Flag when exactly the limit is returned — there may be older messages not shown
  const truncated = (data?.length ?? 0) >= MESSAGE_HISTORY_LIMIT;

  // Decrypt each message's content, image key, and voice key with the vault key before returning
  // Filter out messages the user deleted for themselves or that have already expired locally.
  const nowMs = Date.now();
  const visibleRows = (data ?? []).filter(row => {
    if (row.is_deleted_for_me as boolean) return false;
    const expiresAt = row.expires_at ? new Date(row.expires_at as string).getTime() : null;
    if (expiresAt && expiresAt <= nowMs) return false;
    return true;
  });
  const decrypted = await Promise.all(
    visibleRows.map(async row => ({
      id: row.id as string,
      conversationId: row.conversation_id as string,
      senderId: row.sender_id as string,
      senderUsername: row.sender_username as string,
      content: await decryptContent(row.content as string),
      timestamp: new Date(row.created_at as string).getTime(),
      status: 'delivered' as const,
      isOwn: row.is_own as boolean,
      imageUrl: (row.image_url as string | null) ?? null,
      imageStoragePath: (row.image_storage_path as string | null) ?? null,
      // Decrypt the vault-encrypted AES image key before returning to the UI
      imageKeyBase64: row.image_key_b64
        ? await decryptContent(row.image_key_b64 as string)
        : null,
      replyTo: row.reply_to_id
        ? {
            id: row.reply_to_id as string,
            senderId: row.reply_to_sender as string,
            senderUsername: row.reply_to_sender as string,
            snippet: row.reply_to_snippet as string,
            imageUrl: (row.reply_to_image_url as string | null) ?? null,
          }
        : null,
      voiceStoragePath: (row.voice_storage_path as string | null) ?? null,
      // Decrypt the vault-encrypted AES voice key before returning to the UI
      voiceKeyBase64: row.voice_key_b64
        ? await decryptContent(row.voice_key_b64 as string)
        : null,
      voiceDuration: (row.voice_duration_seconds as number | null) ?? null,
      fileStoragePath: (row.file_storage_path as string | null) ?? null,
      // Decrypt the vault-encrypted AES file key before returning to the UI
      fileKeyBase64: row.file_key_b64
        ? await decryptContent(row.file_key_b64 as string)
        : null,
      fileName: (row.file_name as string | null) ?? null,
      fileSize: (row.file_size as number | null) ?? null,
      fileMimeType: (row.file_mime_type as string | null) ?? null,
      isEdited: (row.is_edited as boolean) ?? false,
      editedAt: row.edited_at ? new Date(row.edited_at as string).getTime() : null,
      isDeletedForEveryone: (row.is_deleted_for_everyone as boolean) ?? false,
      isDeletedForMe: (row.is_deleted_for_me as boolean) ?? false,
      isViewOnce: (row.is_view_once as boolean) ?? false,
      viewOnceConsumed: (row.view_once_consumed as boolean) ?? false,
      ttlSeconds: (row.ttl_seconds as number | null) ?? null,
      expiresAt: row.expires_at ? new Date(row.expires_at as string).getTime() : null,
    }))
  );
  return { messages: decrypted, truncated };
}

export async function saveMessageToDB(ownerId: string, message: LocalMessage): Promise<void> {
  const [encryptedContent, encryptedImageKey, encryptedVoiceKey, encryptedFileKey] = await Promise.all([
    encryptContent(message.content),
    message.imageKeyBase64 ? encryptContent(message.imageKeyBase64) : Promise.resolve(null),
    message.voiceKeyBase64 ? encryptContent(message.voiceKeyBase64) : Promise.resolve(null),
    message.fileKeyBase64 ? encryptContent(message.fileKeyBase64) : Promise.resolve(null),
  ]);
  const { error } = await supabase
    .from('messages')
    .upsert(
      {
        id: message.id,
        owner_id: ownerId,
        conversation_id: message.conversationId,
        sender_id: message.senderId,
        recipient_id: message.isOwn
          ? message.conversationId
          : message.senderId,
        created_at: new Date(message.timestamp).toISOString(),
        content: encryptedContent,
        sender_username: message.senderUsername,
        is_own: message.isOwn,
        image_url: message.imageUrl ?? null,
        image_storage_path: message.imageStoragePath ?? null,
        image_key_b64: encryptedImageKey,
        reply_to_id: message.replyTo?.id ?? null,
        reply_to_sender: message.replyTo?.senderUsername ?? null,
        reply_to_snippet: message.replyTo?.snippet ?? null,
        reply_to_image_url: message.replyTo?.imageUrl ?? null,
        voice_storage_path: message.voiceStoragePath ?? null,
        voice_key_b64: encryptedVoiceKey,
        voice_duration_seconds: message.voiceDuration ?? null,
        file_storage_path: message.fileStoragePath ?? null,
        file_key_b64: encryptedFileKey,
        file_name: message.fileName ?? null,
        file_size: message.fileSize ?? null,
        file_mime_type: message.fileMimeType ?? null,
        is_view_once: message.isViewOnce ?? false,
        view_once_consumed: message.viewOnceConsumed ?? false,
        ttl_seconds: message.ttlSeconds ?? null,
        expires_at: message.expiresAt ? new Date(message.expiresAt).toISOString() : null,
      },
      { onConflict: 'id,owner_id' }
    );

  if (error) console.error('[dbStore] saveMessage error:', error.message);
}

/**
 * Save a message with explicit recipient_id (required for RLS-correct inserts).
 * Content is encrypted with the vault key before being written to the database.
 */
export async function saveMessageToDBFull(
  ownerId: string,
  recipientId: string,
  message: LocalMessage
): Promise<boolean> {
  const [encryptedContent, encryptedImageKey, encryptedVoiceKey, encryptedFileKey] = await Promise.all([
    encryptContent(message.content),
    message.imageKeyBase64 ? encryptContent(message.imageKeyBase64) : Promise.resolve(null),
    message.voiceKeyBase64 ? encryptContent(message.voiceKeyBase64) : Promise.resolve(null),
    message.fileKeyBase64 ? encryptContent(message.fileKeyBase64) : Promise.resolve(null),
  ]);
  const { error } = await supabase
    .from('messages')
    .upsert(
      {
        id: message.id,
        owner_id: ownerId,
        conversation_id: message.conversationId,
        sender_id: message.senderId,
        recipient_id: recipientId,
        // Use the message's logical timestamp as created_at so the sender's
        // copy and every receiver's copy share the same chronological order.
        // Without this, received messages get the DB default `now()` (receive
        // time) and all cluster before any replies the recipient sends later.
        created_at: new Date(message.timestamp).toISOString(),
        content: encryptedContent,
        sender_username: message.senderUsername,
        is_own: message.isOwn,
        image_url: message.imageUrl ?? null,
        image_storage_path: message.imageStoragePath ?? null,
        // AES image key encrypted with vault key — never stored in plaintext
        image_key_b64: encryptedImageKey,
        reply_to_id: message.replyTo?.id ?? null,
        reply_to_sender: message.replyTo?.senderUsername ?? null,
        reply_to_snippet: message.replyTo?.snippet ?? null,
        reply_to_image_url: message.replyTo?.imageUrl ?? null,
        voice_storage_path: message.voiceStoragePath ?? null,
        // AES voice key encrypted with vault key — never stored in plaintext
        voice_key_b64: encryptedVoiceKey,
        voice_duration_seconds: message.voiceDuration ?? null,
        file_storage_path: message.fileStoragePath ?? null,
        // AES file key encrypted with vault key — never stored in plaintext
        file_key_b64: encryptedFileKey,
        file_name: message.fileName ?? null,
        file_size: message.fileSize ?? null,
        file_mime_type: message.fileMimeType ?? null,
        is_view_once: message.isViewOnce ?? false,
        view_once_consumed: message.viewOnceConsumed ?? false,
        ttl_seconds: message.ttlSeconds ?? null,
        expires_at: message.expiresAt ? new Date(message.expiresAt).toISOString() : null,
      },
      { onConflict: 'id,owner_id' }
    );

  // Treat a unique-constraint violation (PostgreSQL error 23505) as success:
  // a concurrent save (Realtime handler + drain loop race) already wrote this
  // row, so the message is safely stored.  Any other error is a real failure.
  if (error && error.code !== '23505') console.error('[dbStore] saveMessageFull error:', error.message);
  return !error || error.code === '23505';
}

export async function deleteConversationMessagesFromDB(
  ownerId: string,
  conversationId: string
): Promise<void> {
  const { error } = await supabase
    .from('messages')
    .delete()
    .eq('owner_id', ownerId)
    .eq('conversation_id', conversationId);

  if (error) console.error('[dbStore] deleteMessages error:', error.message);

  // Clear personal pins
  await supabase
    .from('personal_pins')
    .delete()
    .eq('owner_id', ownerId)
    .eq('conversation_id', conversationId);

  // We do not delete conversation_pins here as it's shared, 
  // deleteConversationMessagesForBoth RPC handles full deletion.
}

/**
 * Delete all messages for a conversation from BOTH users' message tables.
 * Uses the SECURITY DEFINER server function so the caller can remove rows
 * whose owner_id is the other user (normally blocked by RLS).
 */
export async function deleteConversationMessagesForBoth(
  userIdA: string,
  userIdB: string,
  conversationId: string
): Promise<void> {
  const { error } = await supabase.rpc('delete_conversation_messages_for_both', {
    p_user_a: userIdA,
    p_user_b: userIdB,
    p_conversation_id: conversationId,
  });
  if (error) console.error('[dbStore] deleteConversationMessagesForBoth error:', error.message);
}

/**
 * Update the stored public key AND recomputed fingerprint for a contact.
 * Keeping both columns consistent prevents a stale fingerprint from being
 * served via the fallback path in getContactsFromDB (when public_key is null).
 */
export async function updateContactPublicKey(
  ownerId: string,
  contactId: string,
  newPublicKey: string
): Promise<void> {
  const newFingerprint = await computeFingerprint(newPublicKey);
  // Refresh session so the JWT is valid for the RLS UPDATE check
  // (auth.uid() = owner_id).  Ignore refresh errors — the UPDATE may still
  // succeed if the token hasn't fully expired yet.
  await supabase.auth.refreshSession().catch(() => {});
  const { error } = await supabase
    .from('contacts')
    .update({ 
      public_key: newPublicKey, 
      fingerprint: newFingerprint,
      verified_via_qr: false 
    })
    .eq('owner_id', ownerId)
    .eq('contact_id', contactId);
  if (error) console.error('[dbStore] updateContactPublicKey error:', error.message);
}

let sharedMessagesChannel: ReturnType<typeof supabase.channel> | null = null;
const messageListeners = new Set<(payload: any) => void>();

export function clearMessagesChannel(): void {
  if (sharedMessagesChannel) {
    supabase.removeChannel(sharedMessagesChannel);
    sharedMessagesChannel = null;
  }
  messageListeners.clear();
}

/** Subscribe to new messages for a specific conversation via Realtime. */
export function subscribeToMessages(
  ownerId: string,
  conversationId: string,
  onMessage: (msg: LocalMessage) => void,
  onReconnect?: () => void
): () => void {
  const listener = async (payload: any) => {
    const row = payload.new as Record<string, unknown>;
    if (row.conversation_id !== conversationId) return;
    // Decrypt vault-encrypted content, AES image key, and AES voice key before surfacing to UI
    const [content, imageKeyBase64, voiceKeyBase64, fileKeyBase64] = await Promise.all([
      decryptContent(row.content as string),
      row.image_key_b64 ? decryptContent(row.image_key_b64 as string) : Promise.resolve(null),
      row.voice_key_b64 ? decryptContent(row.voice_key_b64 as string) : Promise.resolve(null),
      row.file_key_b64 ? decryptContent(row.file_key_b64 as string) : Promise.resolve(null),
    ]);
    onMessage({
      id: row.id as string,
      conversationId: row.conversation_id as string,
      senderId: row.sender_id as string,
      senderUsername: row.sender_username as string,
      content,
      timestamp: new Date(row.created_at as string).getTime(),
      status: 'delivered',
      isOwn: row.is_own as boolean,
      imageUrl: (row.image_url as string | null) ?? null,
      imageStoragePath: (row.image_storage_path as string | null) ?? null,
      imageKeyBase64,
      replyTo: row.reply_to_id
        ? {
            id: row.reply_to_id as string,
            senderId: row.reply_to_sender as string,
            senderUsername: row.reply_to_sender as string,
            snippet: row.reply_to_snippet as string,
            imageUrl: (row.reply_to_image_url as string | null) ?? null,
          }
        : null,
      voiceStoragePath: (row.voice_storage_path as string | null) ?? null,
      voiceKeyBase64,
      voiceDuration: (row.voice_duration_seconds as number | null) ?? null,
      fileStoragePath: (row.file_storage_path as string | null) ?? null,
      fileKeyBase64,
      fileName: (row.file_name as string | null) ?? null,
      fileSize: (row.file_size as number | null) ?? null,
      fileMimeType: (row.file_mime_type as string | null) ?? null,
      isEdited: (row.is_edited as boolean) ?? false,
      editedAt: row.edited_at ? new Date(row.edited_at as string).getTime() : null,
      isDeletedForEveryone: (row.is_deleted_for_everyone as boolean) ?? false,
      isDeletedForMe: (row.is_deleted_for_me as boolean) ?? false,
      isViewOnce: (row.is_view_once as boolean) ?? false,
      viewOnceConsumed: (row.view_once_consumed as boolean) ?? false,
      ttlSeconds: (row.ttl_seconds as number | null) ?? null,
      expiresAt: row.expires_at ? new Date(row.expires_at as string).getTime() : null,
    });
  };

  messageListeners.add(listener);

  if (!sharedMessagesChannel) {
    sharedMessagesChannel = supabase
      .channel(`messages:${ownerId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: `owner_id=eq.${ownerId}`,
        },
        (payload) => {
          messageListeners.forEach((cb) => cb(payload));
        }
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED' && onReconnect) {
          onReconnect();
        }
      });
  } else {
    // If already joined, we might need to trigger onReconnect manually
    if ((sharedMessagesChannel as unknown as { state: string }).state === 'joined' && onReconnect) {
      onReconnect();
    }
  }

  return () => {
    messageListeners.delete(listener);
    // Intentionally keep the channel alive for reuse.
  };
}

/**
 * Update the stored content of a message after the sender edits it.
 * The new plaintext is vault-encrypted before writing.
 */
export async function updateMessageContentInDB(
  ownerId: string,
  messageId: string,
  newContent: string,
  editedAt: number
): Promise<void> {
  const encryptedContent = await encryptContent(newContent);
  const { error } = await supabase
    .from('messages')
    .update({
      content: encryptedContent,
      is_edited: true,
      edited_at: new Date(editedAt).toISOString(),
    })
    .eq('id', messageId)
    .eq('owner_id', ownerId);
  if (error) console.error('[dbStore] updateMessageContent error:', error.message);
}

/**
 * Mark a message as deleted for everyone.
 * Content is replaced with a tombstone so no plaintext persists.
 */
export async function markMessageDeletedForEveryoneInDB(
  ownerId: string,
  messageId: string
): Promise<void> {
  const tombstone = await encryptContent('');
  const { error } = await supabase
    .from('messages')
    .update({
      content: tombstone,
      is_deleted_for_everyone: true,
      image_storage_path: null,
      image_key_b64: null,
      voice_storage_path: null,
      voice_key_b64: null,
      file_storage_path: null,
      file_key_b64: null,
    })
    .eq('id', messageId)
    .eq('owner_id', ownerId);
  if (error) console.error('[dbStore] markMessageDeleted error:', error.message);
}

/**
 * Mark a view-once message as consumed and overwrite its media/content locally.
 * The content is replaced with a tombstone and media keys/paths are cleared.
 */
export async function consumeViewOnceMessageInDB(
  ownerId: string,
  messageId: string
): Promise<void> {
  const tombstone = await encryptContent('');
  const { error } = await supabase
    .from('messages')
    .update({
      content: tombstone,
      view_once_consumed: true,
      image_storage_path: null,
      image_key_b64: null,
      voice_storage_path: null,
      voice_key_b64: null,
      file_storage_path: null,
      file_key_b64: null,
    })
    .eq('id', messageId)
    .eq('owner_id', ownerId);
  if (error) console.error('[dbStore] consumeViewOnceMessage error:', error.message);
}

/**
 * Delete a single message only for the current user (soft-delete).
 * Sets is_deleted_for_me = true so the bubble is hidden locally but the other
 * party's copy is untouched.
 */
export async function deleteMessageForMeInDB(
  ownerId: string,
  messageId: string
): Promise<void> {
  const { error } = await supabase
    .from('messages')
    .update({ is_deleted_for_me: true })
    .eq('id', messageId)
    .eq('owner_id', ownerId);
  if (error) console.error('[dbStore] deleteMessageForMe error:', error.message);
}

/**
 * Clear all messages in a conversation for the current user only.
 * Physically deletes their rows from the messages table (owner_id = ownerId).
 * The other party's messages are unaffected.
 */
export async function clearConversationForMeInDB(
  ownerId: string,
  conversationId: string
): Promise<void> {
  return deleteConversationMessagesFromDB(ownerId, conversationId);
}


// ── PINS ─────────────────────────────────────────────────────────────────────

export async function pinMessageForMe(
  ownerId: string,
  conversationId: string,
  messageId: string
): Promise<void> {
  const { error } = await supabase
    .from('personal_pins')
    .insert({ owner_id: ownerId, conversation_id: conversationId, message_id: messageId })
    .select();
  if (error && error.code !== '23505') console.error('[dbStore] pinForMe error:', error.message);
}

export async function unpinMessageForMe(
  ownerId: string,
  conversationId: string,
  messageId: string
): Promise<void> {
  const { error } = await supabase
    .from('personal_pins')
    .delete()
    .eq('owner_id', ownerId)
    .eq('conversation_id', conversationId)
    .eq('message_id', messageId);
  if (error) console.error('[dbStore] unpinForMe error:', error.message);
}

export async function getPersonalPins(
  ownerId: string,
  conversationId: string
): Promise<import('@/types/types').PersonalPin[]> {
  const { data, error } = await supabase
    .from('personal_pins')
    .select('*')
    .eq('owner_id', ownerId)
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true });
  if (error) {
    console.error('[dbStore] getPersonalPins error:', error.message);
    return [];
  }
  return (data ?? []).map(row => ({
    id: row.id as string,
    conversationId: row.conversation_id as string,
    messageId: row.message_id as string,
    createdAt: new Date(row.created_at as string).getTime(),
  }));
}

export async function pinMessageForEveryone(
  conversationId: string,
  messageId: string,
  pinnedBy: string
): Promise<void> {
  const { error } = await supabase
    .from('conversation_pins')
    .insert({ conversation_id: conversationId, message_id: messageId, pinned_by: pinnedBy })
    .select();
  if (error && error.code !== '23505') console.error('[dbStore] pinForEveryone error:', error.message);
}

export async function unpinMessageForEveryone(
  conversationId: string,
  messageId: string
): Promise<void> {
  const { error } = await supabase
    .from('conversation_pins')
    .delete()
    .eq('conversation_id', conversationId)
    .eq('message_id', messageId);
  if (error) console.error('[dbStore] unpinForEveryone error:', error.message);
}

export async function getConversationPins(
  conversationId: string
): Promise<import('@/types/types').ConversationPin[]> {
  const { data, error } = await supabase
    .from('conversation_pins')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true });
  if (error) {
    console.error('[dbStore] getConversationPins error:', error.message);
    return [];
  }
  return (data ?? []).map(row => ({
    id: row.id as string,
    conversationId: row.conversation_id as string,
    messageId: row.message_id as string,
    pinnedBy: row.pinned_by as string,
    createdAt: new Date(row.created_at as string).getTime(),
  }));
}
