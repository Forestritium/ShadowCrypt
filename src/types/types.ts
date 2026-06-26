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

export interface LocalMessage {
  id: string;
  conversationId: string;
  senderId: string;
  senderUsername: string;
  content: string; // decrypted plaintext (stored encrypted in IndexedDB)
  timestamp: number;
  status: 'sent' | 'delivered' | 'failed';
  isOwn: boolean;
  imageUrl?: string | null; // public Supabase Storage URL for image messages
  replyTo?: ReplyTo | null; // quoted reply context
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
  header: {
    senderPublicKey: string; // ephemeral DH public key
    messageNumber: number;
    prevChainLength: number;
  };
  ciphertext: string; // base64 AES-256-GCM ciphertext
  iv: string; // base64 IV
  authTag?: string; // optional, included in ciphertext for WebCrypto
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
