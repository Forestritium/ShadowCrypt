// Core types for ShadowCrypt

export type UserRole = 'user' | 'admin';

export interface Profile {
  id: string;
  username: string;
  email: string | null;
  role: UserRole;
  public_key: string | null; // base64-encoded X25519 public key (32 bytes raw)
  bio: string | null;
  created_at: string;
  username_last_changed: string | null; // ISO timestamp of last username change
  avatar_url: string | null;            // public Storage URL for profile picture
  avatar_private: boolean;              // when true, hide avatar from other users
  mnemonic_hash: string | null;           // PBKDF2-SHA256 hash of recovery phrase (for forgot-password)
  mnemonic_salt: string | null;           // base64 random 16-byte salt for mnemonic_hash; NULL = legacy unsalted format
  password_version: number;             // 0 = legacy PIN, 1 = new complexity password
  vault_salt: string | null;            // base64 PBKDF2 salt — backed up so key can be re-derived on any device
  encrypted_private_key: string | null; // AES-GCM encrypted identity key pair blob (cloud backup)
  kdf_version: number;                 // 0 = PBKDF2, 1 = Argon2id (memory-hard key derivation)
}

// Local encrypted storage types
export interface Contact {
  id: string; // contact's user ID
  username: string;
  publicKey: string; // base64 ECDH public key
  fingerprint: string; // SHA-256 fingerprint of their public key
  addedAt: number; // timestamp
  conversationId: string; // deterministic from sorted IDs
}

export interface GroupMember {
  userId: string;
  username: string;
}

export interface Group {
  id: string;
  name: string;
  creatorId: string; // user ID of group creator (admin)
  members: GroupMember[];
  createdAt: number;
  conversationId: string; // same as id for groups
}

export interface ReplyTo {
  id: string;           // ID of the original message being replied to
  senderId: string;     // user ID of the original sender
  senderUsername: string; // display name (without @)
  snippet: string;      // short text preview of the original message
  imageUrl?: string | null; // thumbnail if the original was an image message
}

/** A single emoji reaction on a message. */
export interface MessageReaction {
  id: string;
  messageId: string;
  senderId: string;
  senderUsername?: string;
  emoji: string;
  createdAt: number;
}

export interface LocalMessage {
  id: string;
  conversationId: string;
  senderId: string;
  senderUsername: string;
  content: string; // decrypted plaintext (stored encrypted in IndexedDB)
  timestamp: number;
  status: 'sent' | 'delivered' | 'failed';
  isOwn: boolean;
  /** @deprecated Legacy unencrypted public URL — kept for backward compat only. New messages use imageStoragePath + imageKeyBase64. */
  imageUrl?: string | null;
  /** Supabase Storage path of the AES-GCM ciphertext blob (chat-images bucket). */
  imageStoragePath?: string | null;
  /** Base64-encoded 256-bit AES-GCM key for the encrypted image blob. Travels inside Double Ratchet ciphertext. */
  imageKeyBase64?: string | null;
  replyTo?: ReplyTo | null; // quoted reply context
  /** Supabase Storage path of the AES-GCM encrypted voice blob (chat-voices bucket). */
  voiceStoragePath?: string | null;
  /** Base64-encoded 256-bit AES-GCM key for the encrypted voice blob. Travels inside Double Ratchet ciphertext. */
  voiceKeyBase64?: string | null;
  /** Duration of the voice message in seconds, stored alongside ciphertext for UI display. */
  voiceDuration?: number | null;
  /** Supabase Storage path of the AES-GCM encrypted file blob (chat-files bucket). */
  fileStoragePath?: string | null;
  /** Base64-encoded 256-bit AES-GCM key for the encrypted file blob. Travels inside Double Ratchet ciphertext. */
  fileKeyBase64?: string | null;
  /** Original filename shown in the UI (e.g. "report.pdf"). */
  fileName?: string | null;
  /** File size in bytes, for display purposes. */
  fileSize?: number | null;
  /** MIME type (e.g. "application/pdf") for icon selection and download hint. */
  fileMimeType?: string | null;
  /** Live emoji reactions on this message — populated from message_reactions table. */
  reactions?: MessageReaction[];
}

// Double Ratchet session state (persisted locally)
export interface RatchetSession {
  conversationId: string;
  // Diffie-Hellman ratchet
  DHs: string; // our current DH sending key pair (private, base64)
  DHr: string | null; // their current DH ratchet public key (base64)
  // Chain keys
  RK: string; // Root key (base64)
  CKs: string | null; // sending chain key (base64)
  CKr: string | null; // receiving chain key (base64)
  // Message counters
  Ns: number; // sending message number
  Nr: number; // receiving message number
  PN: number; // previous chain sending messages count
  // Skipped message keys for out-of-order delivery
  MKSKIPPED: Record<string, string>; // key: "pubkey:n" → base64 message key
  /**
   * Header encryption key (base64, 32 bytes).
   * Derived from the initial X25519 shared secret via HKDF("ShadowCrypt-HK").
   * Both parties derive the same key independently.  Used to encrypt the
   * envelope header so that senderPublicKey / messageNumber / prevChainLength
   * are opaque to the relay operator.
   * Optional for backward compatibility with sessions created before v2.4.0.
   */
  HK?: string;
}

// Relay message (transient, never stored server-side long-term)
export interface RelayMessage {
  id: string;
  recipient_id: string;
  sender_id: string;
  conversation_id: string;
  encrypted_payload: string; // JSON stringified EncryptedEnvelope
  created_at: string;
}

export interface EncryptedEnvelope {
  /**
   * AES-256-GCM encrypted header (base64 IV‖ciphertext).
   * Present in envelopes created by v2.4.0+.
   * Decrypts to JSON: { spk: string; mn: number; pcl: number }
   *   spk = senderPublicKey, mn = messageNumber, pcl = prevChainLength
   */
  encryptedHeader?: string;
  /**
   * Cleartext header — present only in envelopes from sessions before v2.4.0.
   * Retained for backward compatibility with in-flight messages.
   * @deprecated Use encryptedHeader for all new sessions.
   */
  header?: {
    senderPublicKey: string;
    messageNumber: number;
    prevChainLength: number;
  };
  ciphertext: string; // base64 AES-256-GCM ciphertext
  iv: string;         // base64 IV
  authTag?: string;   // optional, included in ciphertext for WebCrypto
}

export interface ConversationPreview {
  id: string;
  type: 'direct' | 'group';
  name: string;
  lastMessage?: string;
  lastMessageTime?: number;
  unreadCount: number;
  contact?: Contact;
  group?: Group;
}

// Contact request (server-side, not encrypted)
export interface ContactRequest {
  id: string;
  sender_id: string;
  receiver_id: string;
  status: 'pending' | 'accepted' | 'rejected';
  created_at: string;
  // Joined fields populated client-side
  senderUsername?: string;
  senderPublicKey?: string;
  receiverUsername?: string;
  receiverPublicKey?: string;
}
