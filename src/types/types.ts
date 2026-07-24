// Core types for SylvaCrypt

export type UserRole = 'user' | 'admin';

export interface Profile {
  id: string;
  username: string;
  email: string | null;
  role: UserRole;
  public_key: string | null; // base64-encoded X25519 public key (32 bytes raw)
  bio: string | null;
  bio_private: boolean;                 // when true, hide bio from other users
  created_at: string;
  username_last_changed: string | null; // ISO timestamp of last username change
  avatar_url: string | null;            // public Storage URL for profile picture
  avatar_private: boolean;              // when true, hide avatar from other users
  mnemonic_hash: string | null;           // Argon2id hash of recovery phrase ($argon2id$<hex>) or legacy PBKDF2 hex (for forgot-password)
  mnemonic_salt: string | null;           // base64 random 16-byte salt for mnemonic_hash; NULL = legacy unsalted format
  password_version: number;             // 0 = legacy PIN, 1 = new complexity password
  vault_salt: string | null;            // base64 PBKDF2 salt — backed up so key can be re-derived on any device
  encrypted_private_key: string | null; // AES-GCM encrypted identity key pair blob (cloud backup)
  encrypted_mnemonic: string | null;    // AES-GCM encrypted BIP-39 mnemonic blob (cloud backup, same format as encrypted_private_key)
  kdf_version: number;                 // 0 = PBKDF2, 1 = Argon2id (memory-hard key derivation)
  discoverable: boolean;               // false = opt out of username search (QR-only contact sharing)
}

// Local encrypted storage types
export interface Contact {
  id: string; // contact's user ID
  username: string;
  publicKey: string; // base64 ECDH public key
  fingerprint: string; // SHA-256 fingerprint of their public key (current)
  addedAt: number; // timestamp
  conversationId: string; // deterministic from sorted IDs
  /**
   * True when Alice scanned Bob's QR code in person and the fingerprint
   * embedded in the QR matched the server's public key at scan time.
   * False = TOFU (username search only).
   */
  verifiedViaQR?: boolean;
  /**
   * Hex SHA-256 fingerprint of Bob's public key at the moment Alice first
   * added him.  Never overwritten by key refreshes — serves as the trusted
   * baseline.  A key-change alert fires when the live key's fingerprint no
   * longer matches this value.
   */
  originalFingerprint?: string | null;
  notificationsEnabled?: boolean;
}

/**
 * Emitted by refreshContactPublicKeys when a contact's public key has changed
 * since it was stored.  The caller surfaces an alert and decides whether to
 * trust the new key.
 */
export interface KeyChangeAlert {
  contactId: string;
  username: string;
  oldFingerprint: string;  // fingerprint of the previously trusted key
  newFingerprint: string;  // fingerprint of the freshly fetched key
  newPublicKey: string;    // the new key itself (used to update storage on accept)
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
  status: 'sent' | 'delivered' | 'failed' | 'queued';
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
  /** True when the sender has edited this message after sending. */
  isEdited?: boolean;
  /** Timestamp (ms) of the last edit. */
  editedAt?: number | null;
  /** True when the sender has deleted this message for all parties. */
  isDeletedForEveryone?: boolean;
  /** True when this user deleted this message only for themselves. */
  isDeletedForMe?: boolean;
  /** True when the message is a view-once message that should disappear after being seen. */
  isViewOnce?: boolean;
  /** True once a view-once message has been viewed and should no longer display content. */
  viewOnceConsumed?: boolean;
  /** Disappearing-message TTL in seconds; null or 0 means the message is permanent. */
  ttlSeconds?: number | null;
  /** Server-side deletion timestamp (ms since epoch); null means no expiry. */
  expiresAt?: number | null;
  /**
   * Internal transport-only flag set by receiveAndDecryptMessage.
   * 'edit'   → payload is a v5 edit notification; update the existing message.
   * 'delete' → payload is a v6 delete notification; mark the message deleted.
   * Never persisted to the DB.
   */
  _mutationType?: 'edit' | 'delete';
}

/** A message pinned in a conversation. */
export interface ConversationPin {
  id: string;
  conversationId: string;
  messageId: string;
  pinnedBy: string;
  createdAt: number;
}

/** A message pinned locally for the current user only ("Pin for me"). */
export interface PersonalPin {
  id: string;
  conversationId: string;
  messageId: string;
  createdAt: number;
}

// Double Ratchet session state (persisted locally)
export interface RatchetSession {
  conversationId: string;
  // Diffie-Hellman ratchet
  DHs: string; // our current DH sending key pair (private, base64)
  DHr: string | null; // their current DH ratchet public key (base64)
  // ML-KEM-768 Ratchet
  KEMs?: string; // our current ML-KEM-768 sending key pair (secret key || public key, base64)
  prevKEMs?: string; // our PREVIOUS ML-KEM-768 sending key pair, kept for out-of-order/delayed decapsulations
  KEMr?: string; // their current ML-KEM-768 ratchet public key (base64)
  KEM_ct?: string; // ciphertext for them (base64)
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
   * Header encryption key (base64, 32 bytes) — current SENDING header key.
   * Derived per DH ratchet step. Replaces the legacy shared HK field for
   * sessions created by v2.5.0+. Falls back to HK for old sessions.
   */
  HKs?: string;
  /**
   * Header encryption key (base64, 32 bytes) — current RECEIVING header key.
   * Derived per DH ratchet step alongside HKs.
   */
  HKr?: string;
  /**
   * Next sending header key (base64, 32 bytes).
   * Promoted to HKs on the next DH ratchet step.
   */
  NHKs?: string;
  /**
   * Next receiving header key (base64, 32 bytes).
   * Promoted to HKr on the next DH ratchet step.
   */
  NHKr?: string;
  /**
   * Legacy shared header key (base64, 32 bytes) — present only in sessions
   * created before v2.5.0. Both parties used the same key for all headers.
   * @deprecated Use HKs / HKr instead.
   */
  HK?: string;
  /**
   * Session creation timestamp.
   * Sessions older than 90 days are considered expired and force a new X3DH handshake.
   */
  createdAt?: number;
}

// Relay message (transient, never stored server-side long-term)
export interface RelayMessage {
  id: string;
  recipient_id: string;
  sender_id: string;
  conversation_id: string;
  encrypted_payload: string; // JSON stringified EncryptedEnvelope
  created_at: string;
  /** Device ID of the sending device (null = legacy single-device message). */
  sender_device_id: string | null;
  /** Device ID this message is encrypted for (null = broadcast to all user devices, legacy). */
  recipient_device_id: string | null;
  /**
   * Sealed-sender certificate (optional).
   * JSON-serialized SealedSenderBox — decryptable only by the recipient's IK private key.
   * When present, the receiver SHOULD verify sender identity via this cert rather than
   * trusting the plaintext sender_id field.
   */
  sender_cert: string | null;
  /** View-once flag stored server-side for relay processing. */
  is_view_once?: boolean | null;
  /** IDs of recipients who have consumed this view-once relay message. */
  view_once_consumed_by?: string[] | null;
  /** Disappearing-message TTL in seconds (server-side); null = permanent. */
  ttl_seconds?: number | null;
  /** Server-side deletion deadline for this relay row. */
  expires_at?: string | null;
}

/**
 * X3DH initialisation metadata attached to the first message of a new session.
 * Included as the `x3dh` field in the outer encrypted_payload JSON.
 * Allows the receiver to reproduce the X3DH shared secret and bootstrap
 * their Double Ratchet session.
 */
export interface X3DHInit {
  /** Sender's ephemeral X25519 public key (base64) */
  eph_pub: string;
  /** One-time prekey ID the sender consumed (undefined = no OPK used) */
  opk_id?: string;
  /** ML-KEM-768 ciphertext (base64) — present only when Bob published a KEM key */
  kem_ct?: string;
  /** Sender's X25519 identity public key at time of X3DH (for receiver key lookup) */
  sender_ik_pub: string;
  /** SPK ID used — lets Bob find the right SPK private key if he has rotated */
  spk_id: string;
}

export interface EncryptedEnvelope {
  /**
   * AES-256-GCM encrypted header (base64 IV‖ciphertext).
   * Present in envelopes created by v2.4.0+.
   * Decrypts to JSON: { spk: string; mn: number; pcl: number; kem_pub?: string; kem_ct?: string }
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
    kem_pub?: string;
    kem_ct?: string;
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

// ─── Multi-device support ────────────────────────────────────────────────────

/**
 * A registered device for a user account.
 * One device = one browser/OS instance with its own X25519 identity key.
 */
export interface UserDevice {
  id: string;              // DB UUID PK
  user_id: string;
  device_id: string;       // stable client-side UUID (localStorage)
  device_name: string;
  public_key: string;      // base64 X25519 public key for this device
  is_primary: boolean;
  approved: boolean;       // false = pending primary-device approval
  approval_signature: string | null;
  added_at: string;
  last_seen_at: string;
}
