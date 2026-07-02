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
    // Vault not unlocked — should not happen in normal flow, but fail safe
    console.warn('[dbStore] vault key unavailable, storing content unencrypted');
    return `__plain__:${plaintext}`;
  }
  return encryptObject<string>(key, plaintext);
}

/**
 * Decrypt a stored content blob back to plaintext.
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
  } catch {
    // Could be a pre-encryption legacy plaintext row — return as-is
    return stored;
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
      },
      { onConflict: 'owner_id,contact_id' }
    );

  if (error) console.error('[dbStore] saveContact error:', error.message);
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

export async function getMessagesFromDB(
  ownerId: string,
  conversationId: string
): Promise<LocalMessage[]> {
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('owner_id', ownerId)
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .limit(500);

  if (error) {
    console.error('[dbStore] getMessages error:', error.message);
    return [];
  }

  // Decrypt each message's content, image key, and voice key with the vault key before returning
  const decrypted = await Promise.all(
    (data ?? []).map(async row => ({
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
    }))
  );
  return decrypted;
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
        created_at: new Date(message.timestamp).toISOString(),
        voice_storage_path: message.voiceStoragePath ?? null,
        voice_key_b64: encryptedVoiceKey,
        voice_duration_seconds: message.voiceDuration ?? null,
        file_storage_path: message.fileStoragePath ?? null,
        file_key_b64: encryptedFileKey,
        file_name: message.fileName ?? null,
        file_size: message.fileSize ?? null,
        file_mime_type: message.fileMimeType ?? null,
      },
      { onConflict: 'id' }
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
): Promise<void> {
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
        created_at: new Date(message.timestamp).toISOString(),
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
      },
      { onConflict: 'id' }
    );

  if (error) console.error('[dbStore] saveMessageFull error:', error.message);
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
  const { error } = await supabase
    .from('contacts')
    .update({ public_key: newPublicKey, fingerprint: newFingerprint })
    .eq('owner_id', ownerId)
    .eq('contact_id', contactId);
  if (error) console.error('[dbStore] updateContactPublicKey error:', error.message);
}

/** Subscribe to new messages for a specific conversation via Realtime. */
export function subscribeToMessages(
  ownerId: string,
  conversationId: string,
  onMessage: (msg: LocalMessage) => void
): () => void {
  const channel = supabase
    .channel(`messages:${ownerId}:${conversationId}`)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'messages',
        filter: `owner_id=eq.${ownerId}`,
      },
      async (payload) => {
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
        });
      }
    )
    .subscribe();

  return () => { supabase.removeChannel(channel); };
}
