import { generateUUID } from "@/lib/uuid";
/**
 * X3DH + Post-Quantum Hybrid Key Agreement for SylvaCrypt
 * ─────────────────────────────────────────────────────────
 *
 * Protocol: Extended Triple Diffie-Hellman (X3DH) with an optional
 * ML-KEM-768 (CRYSTALS-Kyber, FIPS 203) hybrid layer for post-quantum security.
 *
 * Classical path  (X3DH):
 *   DH1 = X25519(Alice_IK,  Bob_SPK)
 *   DH2 = X25519(Alice_EK,  Bob_IK)
 *   DH3 = X25519(Alice_EK,  Bob_SPK)
 *   DH4 = X25519(Alice_EK,  Bob_OPK)   [if OPK available]
 *   SK_classical = HKDF(DH1‖DH2‖DH3[‖DH4], salt=0, info="SylvaCrypt-X3DH-v1")
 *
 * Post-quantum layer (ML-KEM-768):
 *   (kem_ct, SK_pq) = ML-KEM-768.Encapsulate(Bob_KEM_pub)
 *   Final SK = HKDF(SK_classical‖SK_pq, salt=0, info="SylvaCrypt-X3DH-PQ-v1")
 *   When Bob_KEM_pub is absent (legacy client), SK = SK_classical.
 *
 * SPK authentication:
 *   sig = Ed25519Sign(Alice_Ed25519_priv, spk_pub_bytes)
 *   The receiver verifies: Ed25519Verify(Alice_Ed25519_pub, spk_pub_bytes, sig).
 *   (Legacy clients used HMAC-SHA256, but this was un-verifiable by third parties.)
 *
 * Sealed-sender certificate:
 *   cert = { sender_id, sender_ik_pub, ts }
 *   cert_sig = HMAC-SHA256(sender_IK_priv, JSON(cert))
 *   box = AES-256-GCM( HKDF(DH(sender_EK_priv, recipient_IK_pub), "SylvaCrypt-SealedSender-v1"),
 *                      JSON({ cert, cert_sig }) )
 *   The box is attached as relay_messages.sender_cert so the server never sees
 *   plaintext sender identity — only the recipient can decrypt it.
 */

import { supabase } from '@/db/supabase';
import { getEncrypted, setEncrypted, deleteEncrypted } from './localStore';
import { initSessionSenderFromSecret, initSessionReceiverFromSecret } from './doubleRatchet';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import {
  generateX25519KeyPair,
  x25519DH,
  hkdf,
  hmacSha256,
  toBase64,
  fromBase64,
  aesEncrypt,
  aesDecrypt,
  importAESKey,
  ed25519Sign,
  ed25519Verify,
} from './crypto';

// ─── Supabase client (lazy import — avoids circular dep with relay.ts) ────────
async function getSupabase() {
  
  return supabase;
}

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface SignedPrekeyBundle {
  /** Target user's X25519 identity public key (base64) */
  ik_pub: string;
  /** Signed Prekey ID (opaque string) */
  spk_id: string;
  /** Signed Prekey X25519 public key (base64) */
  spk_pub: string;
  /** Ed25519 signature of the SPK public key */
  spk_sig: string;
  /** Ed25519 public key (base64) */
  ed25519_pub?: string;
  /** ML-KEM-768 public key (base64), undefined on legacy clients */
  kem_pub?: string;
  /** One-time Prekey ID (base64), undefined when pool is exhausted */
  opk_id?: string;
  /** One-time Prekey X25519 public key (base64) */
  opk_pub?: string;
  /** ML-KEM-768 one-time KEM public key (base64) */
  kem_opk_pub?: string;
}

export interface X3DHSenderResult {
  /** Derived session root secret (32 bytes, base64) */
  sessionSecret: string;
  /** Ephemeral public key Alice sends to Bob so he can reproduce the X3DH */
  ephemeralPub: string;
  /** OPK ID consumed (undefined if no OPK was used) */
  opkId?: string;
  /** ML-KEM ciphertext to send to Bob (base64, undefined if no KEM key) */
  kemCiphertext?: string;
}

export interface X3DHReceiverInput {
  /** Sender's ephemeral public key (from the initial message payload) */
  ephemeralPub: string;
  /** OPK private key that was consumed (base64), or undefined */
  opkPriv?: string;
  /** ML-KEM ciphertext from sender (base64), or undefined */
  kemCiphertext?: string;
  /** Receiver's SPK private key */
  spkPriv: string;
}

export interface SealedSenderCert {
  sender_id: string;
  sender_ik_pub: string;
  ts: number;
}

export interface SealedSenderBox {
  /** Ephemeral sender public key used for the ECIES-style KDF */
  eph_pub: string;
  /** AES-256-GCM ciphertext of { cert, cert_sig } as base64(IV[12] + ct) */
  box: string;
}

// ─── Prekey store helpers ──────────────────────────────────────────────────────
// SPK private key is stored encrypted in the vault (IndexedDB)

const SPK_STORE_KEY = 'x3dh_spk';
const OPK_STORE_KEY_PREFIX = 'x3dh_opk_';
const KEM_KEYPAIR_STORE_KEY = 'x3dh_kem_keypair';

async function vaultGetJSON<T>(key: string): Promise<T | null> {
  
  return getEncrypted<T>(key);
}

async function vaultSetJSON<T>(key: string, value: T): Promise<void> {
  
  await setEncrypted(key, value);
}

async function vaultDeleteJSON(key: string): Promise<void> {
  
  await deleteEncrypted(key);
}

// ─── SPK management ────────────────────────────────────────────────────────────

interface StoredSPK {
  id: string;
  privateKeyBase64: string;
  publicKeyBase64: string;
}

async function generateSPK(): Promise<StoredSPK> {
  const kp = generateX25519KeyPair();
  return {
    id: generateUUID(),
    privateKeyBase64: kp.privateKeyBase64,
    publicKeyBase64: kp.publicKeyBase64,
  };
}

async function getOrCreateSPK(): Promise<StoredSPK> {
  const existing = await vaultGetJSON<StoredSPK>(SPK_STORE_KEY);
  if (existing) return existing;
  const spk = await generateSPK();
  await vaultSetJSON(SPK_STORE_KEY, spk);
  return spk;
}

/** Ed25519 signature of the SPK public key */
async function signSPK(ed25519PrivBase64: string, spkPubBase64: string): Promise<string> {
  const sig = ed25519Sign(fromBase64(spkPubBase64), fromBase64(ed25519PrivBase64));
  return toBase64(sig);
}

/** Verify Ed25519 signature of the SPK public key.
 * Exported so it can be called during prekey bundle validation by the receiver. */
export function verifySPK(
  sigBase64: string,
  spkPubBase64: string,
  ed25519PubBase64: string,
): boolean {
  return ed25519Verify(
    fromBase64(sigBase64),
    fromBase64(spkPubBase64),
    fromBase64(ed25519PubBase64)
  );
}

// ─── OPK management ────────────────────────────────────────────────────────────

const OPK_BATCH_SIZE = 20;

interface StoredOPKEntry { privateKeyBase64: string }

async function generateOPKBatch(count = OPK_BATCH_SIZE): Promise<{ id: string; priv: string; pub: string }[]> {
  return Array.from({ length: count }, () => {
    const kp = generateX25519KeyPair();
    return { id: generateUUID(), priv: kp.privateKeyBase64, pub: kp.publicKeyBase64 };
  });
}

async function storeOPKPrivate(opkId: string, priv: string): Promise<void> {
  await vaultSetJSON<StoredOPKEntry>(`${OPK_STORE_KEY_PREFIX}${opkId}`, { privateKeyBase64: priv });
}

export async function consumeOPKPrivate(opkId: string): Promise<string | null> {
  const entry = await vaultGetJSON<StoredOPKEntry>(`${OPK_STORE_KEY_PREFIX}${opkId}`);
  if (!entry) return null;
  // Delete after use (one-time)
  await vaultDeleteJSON(`${OPK_STORE_KEY_PREFIX}${opkId}`);
  return entry.privateKeyBase64;
}

// ─── ML-KEM-768 key management ─────────────────────────────────────────────────

interface StoredKEMKeyPair { publicKeyBase64: string; secretKeyBase64: string }

async function getOrCreateKEMKeyPair(): Promise<StoredKEMKeyPair> {
  const existing = await vaultGetJSON<StoredKEMKeyPair>(KEM_KEYPAIR_STORE_KEY);
  if (existing) return existing;
  const { publicKey, secretKey } = ml_kem768.keygen();
  const kp: StoredKEMKeyPair = {
    publicKeyBase64: toBase64(publicKey),
    secretKeyBase64: toBase64(secretKey),
  };
  await vaultSetJSON(KEM_KEYPAIR_STORE_KEY, kp);
  return kp;
}

// ─── Publish prekeys to server ─────────────────────────────────────────────────

/**
 * Generate a fresh SPK + OPK batch + KEM key pair and publish them to the server.
 * Called at login and periodically (e.g. every 7 days or when OPK pool is low).
 */
export async function publishPrekeys(userId: string, ed25519PrivBase64: string, ikPubBase64: string, ed25519PubBase64: string): Promise<void> {
  const db = await getSupabase();
  const deviceId = localStorage.getItem('sc_device_id');
  if (!deviceId) return;

  const [spk, opks, kemKP] = await Promise.all([
    getOrCreateSPK(),
    generateOPKBatch(),
    getOrCreateKEMKeyPair(),
  ]);
  const spkSig = await signSPK(ed25519PrivBase64, spk.publicKeyBase64);

  // Upsert the signed prekey bundle
  const { error: spkErr } = await db
    .from('user_signed_prekeys')
    .upsert({
      user_id:    userId,
      device_id:  deviceId,
      ik_pub:     ikPubBase64,
      spk_id:     spk.id,
      spk_pub:    spk.publicKeyBase64,
      spk_sig:    spkSig,
      kem_pub:    kemKP.publicKeyBase64,
      ed25519_pub: ed25519PubBase64,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id, device_id' });

  if (spkErr) {
    console.warn('[X3DH] Failed to publish signed prekey:', spkErr.message);
    return;
  }

  // Store OPK private keys in vault, then upload public keys
  await Promise.all(opks.map(o => storeOPKPrivate(o.id, o.priv)));
  const opkRows = opks.map(o => ({
    user_id: userId,
    device_id: deviceId,
    opk_id:  o.id,
    opk_pub: o.pub,
  }));
  const { error: opkErr } = await db.from('user_one_time_prekeys').insert(opkRows);
  if (opkErr) console.warn('[X3DH] Failed to publish OPKs:', opkErr.message);
}

/**
 * Check if the OPK pool has dropped below a threshold and replenish if needed.
 * Call periodically after login (e.g. once per session).
 */
export async function replenishOPKsIfNeeded(userId: string, threshold = 5): Promise<void> {
  const db = await getSupabase();
  const deviceId = localStorage.getItem('sc_device_id');
  if (!deviceId) return;
  const { count } = await db
    .from('user_one_time_prekeys')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('device_id', deviceId);
  if ((count ?? 0) < threshold) {
    const opks = await generateOPKBatch();
    await Promise.all(opks.map(o => storeOPKPrivate(o.id, o.priv)));
    const rows = opks.map(o => ({ user_id: userId, device_id: deviceId, opk_id: o.id, opk_pub: o.pub }));
    await db.from('user_one_time_prekeys').insert(rows).then(() => {}, () => {});
  }
}

// ─── Fetch prekey bundle ────────────────────────────────────────────────────────

/**
 * Fetch a full prekey bundle for a recipient and atomically consume one OPK.
 * Returns null if the recipient has not published prekeys (legacy client).
 */
export async function fetchPrekeyBundle(recipientId: string, deviceId?: string | null): Promise<SignedPrekeyBundle | null> {
  const db = await getSupabase();

  let query = db
    .from('user_signed_prekeys')
    .select('ik_pub, spk_id, spk_pub, spk_sig, kem_pub, ed25519_pub, device_id')
    .eq('user_id', recipientId);
  
  if (deviceId) {
    query = query.eq('device_id', deviceId);
  }

  const { data: spkRows, error } = await query
    .order('updated_at', { ascending: false })
    .limit(1);

  if (error || !spkRows || spkRows.length === 0) return null;
  const spkRow = spkRows[0];
  const targetDeviceId = spkRow.device_id;

  // Attempt to claim one OPK via the SECURITY DEFINER RPC
  const { data: opkRows } = await db
    .rpc('consume_one_time_prekey', { p_user_id: recipientId, p_device_id: targetDeviceId });

  const opk = (opkRows as { opk_id: string; opk_pub: string; kem_opk_pub: string | null }[] | null)?.[0];

  return {
    ik_pub:      spkRow.ik_pub,
    spk_id:      spkRow.spk_id,
    spk_pub:     spkRow.spk_pub,
    spk_sig:     spkRow.spk_sig,
    ed25519_pub: spkRow.ed25519_pub ?? undefined,
    kem_pub:     spkRow.kem_pub ?? undefined,
    opk_id:      opk?.opk_id,
    opk_pub:     opk?.opk_pub,
    kem_opk_pub: opk?.kem_opk_pub ?? undefined,
  };
}

// ─── KDF helpers ───────────────────────────────────────────────────────────────

const ZEROS32 = new Uint8Array(32);
// Protocol spec: pad input with 0xFF bytes before the DH outputs (same length as output)
const F = new Uint8Array(32).fill(0xff);

/** Concatenate multiple Uint8Arrays */
function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) { out.set(a, offset); offset += a.length; }
  return out;
}

// ─── X3DH sender side ─────────────────────────────────────────────────────────

/**
 * Run X3DH from the sender (Alice) side.
 *
 * @param myIKPriv    Alice's identity private key (X25519, base64)
 * @param bundle      Bob's prekey bundle
 * @returns           Session secret + metadata Bob needs to reproduce the agreement
 */
export async function x3dhSenderSetup(
  myIKPriv: string,
  bundle: SignedPrekeyBundle,
): Promise<X3DHSenderResult> {
  // Verify SPK signature
  if (bundle.ed25519_pub) {
    const isValid = ed25519Verify(
      fromBase64(bundle.spk_sig),
      fromBase64(bundle.spk_pub),
      fromBase64(bundle.ed25519_pub)
    );
    if (!isValid) throw new Error('Invalid Ed25519 SPK signature');
  } else {
    // Legacy HMAC validation
    // The old code used HMAC-SHA256(ik_priv, spk_pub) which is un-verifiable
    // by anyone other than the signer. We skip legacy verification and rely
    // on the Ed25519 signature above.
  }

  // Generate Alice's ephemeral key pair (EK)
  const ek = generateX25519KeyPair();

  // ── Classical X3DH ────────────────────────────────────────────────────────
  const dh1 = x25519DH(myIKPriv,          bundle.spk_pub); // DH(IK_A, SPK_B)
  const dh2 = x25519DH(ek.privateKeyBase64, bundle.ik_pub);  // DH(EK_A, IK_B)
  const dh3 = x25519DH(ek.privateKeyBase64, bundle.spk_pub); // DH(EK_A, SPK_B)

  let ikm = concat(F, dh1, dh2, dh3);

  if (bundle.opk_pub) {
    const dh4 = x25519DH(ek.privateKeyBase64, bundle.opk_pub); // DH(EK_A, OPK_B)
    ikm = concat(F, dh1, dh2, dh3, dh4);
  }

  const skClassical = await hkdf(ikm, ZEROS32, 'SylvaCrypt-X3DH-v1', 32);

  // ── Post-quantum layer (ML-KEM-768) ───────────────────────────────────────
  let skFinal = skClassical;
  let kemCiphertext: string | undefined;

  if (bundle.kem_pub) {
    try {
      const kemPubBytes = fromBase64(bundle.kem_pub);
      const { cipherText, sharedSecret } = ml_kem768.encapsulate(kemPubBytes);
      kemCiphertext = toBase64(cipherText);
      skFinal = await hkdf(
        concat(skClassical, sharedSecret),
        ZEROS32,
        'SylvaCrypt-X3DH-PQ-v1',
        32,
      );
    } catch (e) {
      console.error('🚨 [SECURITY WARNING] ML-KEM encapsulation failed!', e);
      throw new Error('ML-KEM encapsulation failed. Hard failure triggered.');
    }
  }

  return {
    sessionSecret: toBase64(skFinal),
    ephemeralPub:  ek.publicKeyBase64,
    opkId:         bundle.opk_id,
    kemCiphertext,
  };
}

// ─── X3DH receiver side ────────────────────────────────────────────────────────

/**
 * Full receiver X3DH setup. Call this when receiving Alice's first X3DH message.
 *
 * @param myIKPriv      Bob's identity private key (base64)
 * @param senderIKPub   Alice's identity public key (base64) — from the message
 * @param input         EK, OPK priv, KEM ciphertext from the message
 * @param myKEMSecKey   Bob's ML-KEM-768 secret key (base64), undefined for legacy
 */
export async function x3dhReceiverSetupFull(
  myIKPriv: string,
  senderIKPub: string,
  input: X3DHReceiverInput,
  myKEMSecKey?: string,
): Promise<string> {
  const ek = input.ephemeralPub;

  const dh1 = x25519DH(input.spkPriv, senderIKPub); // DH(SPK_B, IK_A)
  const dh2 = x25519DH(myIKPriv,      ek);           // DH(IK_B,  EK_A)
  const dh3 = x25519DH(input.spkPriv, ek);           // DH(SPK_B, EK_A)

  let ikm = concat(F, dh1, dh2, dh3);

  if (input.opkPriv) {
    const dh4 = x25519DH(input.opkPriv, ek);          // DH(OPK_B, EK_A)
    ikm = concat(F, dh1, dh2, dh3, dh4);
  }

  const skClassical = await hkdf(ikm, ZEROS32, 'SylvaCrypt-X3DH-v1', 32);

  // ── Post-quantum layer ────────────────────────────────────────────────────
  let skFinal = skClassical;

  if (myKEMSecKey && input.kemCiphertext) {
    try {
      const secKey = fromBase64(myKEMSecKey);
      const cipherText = fromBase64(input.kemCiphertext);
      const sharedSecret = ml_kem768.decapsulate(cipherText, secKey);
      skFinal = await hkdf(
        concat(skClassical, sharedSecret),
        ZEROS32,
        'SylvaCrypt-X3DH-PQ-v1',
        32,
      );
    } catch (e) {
      console.error('🚨 [SECURITY WARNING] ML-KEM decapsulation failed!', e);
      throw new Error('ML-KEM decapsulation failed. Hard failure triggered.');
    }
  }

  return toBase64(skFinal);
}

// ─── Sealed-sender certificate ─────────────────────────────────────────────────

/**
 * Create a sealed-sender box for the recipient.
 *
 * The box is a tiny ECIES-style encrypted structure:
 *   1. Generate ephemeral EK
 *   2. DH(EK_priv, recipient_IK_pub) → HKDF → 32-byte AES key
 *   3. Encrypt { cert: {sender_id, sender_ik_pub, ts}, cert_sig } with AES-256-GCM
 *
 * The server stores this opaque blob in relay_messages.sender_cert.
 * Only the recipient's IK private key can decrypt it.
 */
export async function createSealedSenderBox(
  senderId: string,
  senderIKPriv: string,
  senderIKPub: string,
  recipientIKPub: string,
): Promise<SealedSenderBox> {
  const ek = generateX25519KeyPair();
  const sharedSecret = x25519DH(ek.privateKeyBase64, recipientIKPub);
  const aesKeyBytes = await hkdf(sharedSecret, ZEROS32, 'SylvaCrypt-SealedSender-v1', 32);
  const aesKey = await importAESKey(aesKeyBytes);

  const cert: SealedSenderCert = {
    sender_id:     senderId,
    sender_ik_pub: senderIKPub,
    ts:            Date.now(),
  };
  const certJson = JSON.stringify(cert);
  
  const macSharedSecret = x25519DH(senderIKPriv, recipientIKPub);
  const macKeyBytes = await hkdf(macSharedSecret, ZEROS32, 'SylvaCrypt-SealedSender-MAC-v1', 32);
  const certSig = toBase64(await hmacSha256(macKeyBytes, new TextEncoder().encode(certJson)));

  const plaintext = new TextEncoder().encode(JSON.stringify({ cert, cert_sig: certSig }));
  const { ciphertext, iv } = await aesEncrypt(aesKey, plaintext);

  const combined = new Uint8Array(12 + ciphertext.length);
  combined.set(iv);
  combined.set(ciphertext, 12);

  return { eph_pub: ek.publicKeyBase64, box: toBase64(combined) };
}

/**
 * Decrypt a sealed-sender box with the recipient's IK private key.
 * Returns null if the box is malformed, the MAC doesn't verify, or the cert is stale.
 */
export async function openSealedSenderBox(
  box: SealedSenderBox,
  myIKPriv: string,
  /** Maximum cert age in ms (default 5 minutes) */
  maxAgeMs = 5 * 60 * 1000,
): Promise<SealedSenderCert | null> {
  try {
    const sharedSecret = x25519DH(myIKPriv, box.eph_pub);
    const aesKeyBytes = await hkdf(sharedSecret, ZEROS32, 'SylvaCrypt-SealedSender-v1', 32);
    const aesKey = await importAESKey(aesKeyBytes);

    const combined = fromBase64(box.box);
    const iv = combined.slice(0, 12);
    const ct = combined.slice(12);
    const plainBytes = await aesDecrypt(aesKey, ct, iv);
    const { cert, cert_sig } = JSON.parse(new TextDecoder().decode(plainBytes)) as {
      cert: SealedSenderCert; cert_sig: string;
    };

    // Verify cert freshness
    if (Math.abs(Date.now() - cert.ts) > maxAgeMs) {
      console.warn('[X3DH] Sealed sender cert is stale, rejecting');
      return null;
    }

    const macSharedSecret = x25519DH(myIKPriv, cert.sender_ik_pub);
    const macKeyBytes = await hkdf(macSharedSecret, ZEROS32, 'SylvaCrypt-SealedSender-MAC-v1', 32);
    
    // Verify sender's HMAC-MAC over cert JSON
    const certJson = JSON.stringify(cert);
    const expected = await hmacSha256(
      macKeyBytes,
      new TextEncoder().encode(certJson),
    );
    const actual = fromBase64(cert_sig);
    let diff = 0;
    for (let i = 0; i < Math.min(expected.length, actual.length); i++) diff |= expected[i] ^ actual[i];
    if (diff !== 0 || expected.length !== actual.length) {
      console.warn('[X3DH] Sealed sender cert MAC verification failed');
      return null;
    }

    return cert;
  } catch (e) {
    console.warn('[X3DH] openSealedSenderBox error:', e);
    return null;
  }
}

// ─── Convenience: init ratchet session from X3DH secret ──────────────────────

/**
 * Upgrade a raw X3DH session secret into a full Double Ratchet session.
 * The secret is used as the initial root key fed into initSessionSender/Receiver
 * instead of the plain single-DH shared secret.
 *
 * @param conversationId  ratchet session namespace
 * @param sessionSecretB64 32-byte X3DH SK (base64)
 * @param myPrivB64        our X25519 private key
 * @param theirPubB64      their X25519 public key
 * @param isSender         true = Alice (sender-side init)
 */
/**
 * Upgrade a raw X3DH session secret into a full Double Ratchet session.
 * The secret is used as the initial root key instead of a plain single-DH secret.
 *
 * @param conversationId   ratchet session namespace
 * @param sessionSecretB64 32-byte X3DH SK (base64)
 * @param myPrivB64        our X25519 private key
 * @param myPubB64         our X25519 public key (needed for receiver path)
 * @param theirPubB64      their X25519 public key
 * @param isSender         true = Alice/sender-side init
 */
export async function initRatchetFromX3DH(
  conversationId: string,
  sessionSecretB64: string,
  myPrivB64: string,
  myPubB64: string,
  theirPubB64: string,
  isSender: boolean,
) {
  
  if (isSender) {
    return initSessionSenderFromSecret(conversationId, sessionSecretB64, myPrivB64, theirPubB64);
  } else {
    return initSessionReceiverFromSecret(conversationId, sessionSecretB64, myPrivB64, myPubB64, theirPubB64);
  }
}
