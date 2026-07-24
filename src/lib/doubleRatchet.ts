/**
 * Double Ratchet — v2.5.0 with NHK header-key rotation.
 * X25519 + HKDF-SHA256 + AES-256-GCM.
 *
 * Each message gets a unique derived key → full forward secrecy.
 * Ratchet sessions are stored encrypted in the local vault.
 *
 * Header encryption (v2.5.0+): NHK (Next Header Key) rotation is now applied
 * on every DH ratchet step so that each epoch uses a fresh header key.
 * Compromise of one epoch's header key does not expose headers from other epochs.
 *
 *   Session init derives 160 bytes from the shared secret:
 *     [RK(32) | HKs(32) | HKr(32) | NHKs(32) | NHKr(32)]
 *   kdfRK now outputs 96 bytes: [newRK(32) | newCK(32) | newNHK(32)]
 *   On each DH ratchet step:
 *     HKr ← NHKr ; [RK, CKr, NHKr] = kdfRK(RK, DH(oldDHs, theirNewPub))
 *     HKs ← NHKs ; [RK, CKs, NHKs] = kdfRK(RK, DH(newDHs, theirNewPub))
 *   Skipped message entries store { mk, hk } so the correct header key is
 *   available when an out-of-order message is eventually decrypted.
 *
 * Backward compat: sessions with only the legacy HK field (pre-v2.5.0) fall
 * back to treating HK as both HKs and HKr (no rotation).
 * Sessions with no header key at all (pre-v2.4.0) use cleartext headers.
 */

import type { RatchetSession, EncryptedEnvelope } from '@/types/types';
import {
  generateX25519KeyPair,
  x25519DH,
  hkdf,
  hmacSha256,
  importAESKey,
  aesEncrypt,
  aesDecrypt,
  toBase64,
  fromBase64,
} from './crypto';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';

const ZEROS32 = new Uint8Array(32);
const MAX_SKIP = 1000;
const MAX_MKSKIPPED_ENTRIES = 200;
const MAX_MKSKIPPED_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

// ─── KDF helpers ─────────────────────────────────────────────────────────────

/**
 * DH ratchet KDF (v2.5.0+): (RK, dhOut) → (newRK, chainKey, nextHeaderKey)
 * 96-byte HKDF output: first 32 = new root key, next 32 = chain key,
 * last 32 = next header key for this ratchet direction.
 */
async function kdfRK(rk: Uint8Array, dhOut: Uint8Array): Promise<[Uint8Array, Uint8Array, Uint8Array]> {
  const out = await hkdf(dhOut, rk, 'SylvaCrypt-RK', 96);
  return [out.slice(0, 32), out.slice(32, 64), out.slice(64, 96)];
}

/** Symmetric chain KDF: chainKey → (newChainKey, messageKey) */
async function kdfCK(ck: Uint8Array): Promise<[Uint8Array, Uint8Array]> {
  const mk  = await hmacSha256(ck, new Uint8Array([1]));
  const nck = await hmacSha256(ck, new Uint8Array([2]));
  return [nck, mk];
}

// ─── Session initialisation ───────────────────────────────────────────────────

/**
 * Alice initiates: she has Bob's identity public key.
 * Derives asymmetric HKs/HKr/NHKs/NHKr from the initial shared secret so
 * that the first message is already header-encrypted with a fresh key pair.
 */
export async function initSessionSender(
  conversationId: string,
  ourPrivB64: string,
  theirPubB64: string,
): Promise<RatchetSession> {
  const shared = x25519DH(ourPrivB64, theirPubB64);

  // 160 bytes: RK | HKs | HKr | NHKs_init | NHKr_init
  // Alice: HKs = bytes[32..64], HKr = bytes[64..96]
  // Bob:   HKs = bytes[64..96], HKr = bytes[32..64]  (mirror)
  const initBytes = await hkdf(shared, ZEROS32, 'SylvaCrypt-InitV2', 160);
  const rk0       = initBytes.slice(0, 32);
  const hks0      = initBytes.slice(32, 64);
  const hkr0      = initBytes.slice(64, 96);
  const nhks0     = initBytes.slice(96, 128);
  const nhkr0     = initBytes.slice(128, 160);

  // First DH ratchet step for sending (Alice generates ephemeral key pair)
  const eph = generateX25519KeyPair();
  const dhOut = x25519DH(eph.privateKeyBase64, theirPubB64);
  // HKs advances: NHKs_init → current HKs; derive new NHKs
  const [newRK, cks, newNHKs] = await kdfRK(rk0, dhOut);

  const kemKP = ml_kem768.keygen();

  return {
    conversationId,
    DHs: `${eph.privateKeyBase64}|${eph.publicKeyBase64}`,
    DHr: theirPubB64,
    KEMs: `${toBase64(kemKP.secretKey)}|${toBase64(kemKP.publicKey)}`,
    RK: toBase64(newRK),
    CKs: toBase64(cks),
    CKr: null,
    Ns: 0, Nr: 0, PN: 0,
    MKSKIPPED: {},
    // Sending header key is advanced from NHKs_init on the first DH step
    HKs: toBase64(nhks0),
    HKr: toBase64(hkr0),
    NHKs: toBase64(newNHKs),
    NHKr: toBase64(nhkr0),
    // Keep HKs_init in HK for the legacy fallback path — will not be used by
    // any v2.5.0 decoder but keeps old sessions interoperable.
    HK: toBase64(hks0),
    createdAt: Date.now(),
  };
}

/**
 * Bob receives first message: initialise from shared secret.
 * DHs MUST be Bob's identity key pair so that the first DH ratchet step
 * is symmetric with Alice's ephemeral→identity DH.
 */
export async function initSessionReceiver(
  conversationId: string,
  ourPrivB64: string,
  ourPubB64: string,
  theirPubB64: string,
): Promise<RatchetSession> {
  const shared = x25519DH(ourPrivB64, theirPubB64);

  // Mirror of Alice: Bob's HKs = Alice's HKr (bytes[64..96])
  //                  Bob's HKr = Alice's HKs = NHKs_init (bytes[96..128])
  //                  Bob's NHKr = Alice's hks0 (bytes[32..64])
  // The swap of hkr0 ↔ nhkr0 (vs the pre-fix code) aligns Bob's header
  // decrypt key with Alice's post-step header encrypt key (nhks0).
  const initBytes = await hkdf(shared, ZEROS32, 'SylvaCrypt-InitV2', 160);
  const rk0   = initBytes.slice(0, 32);
  const hks0  = initBytes.slice(64, 96);   // Bob's HKs = Alice's HKr
  const hkr0  = initBytes.slice(96, 128);  // Bob's HKr = Alice's post-step HKs (nhks0)
  const nhks0 = initBytes.slice(128, 160); // Bob's NHKs = Alice's NHKr
  const nhkr0 = initBytes.slice(32, 64);   // Bob's NHKr = Alice's initial hks0

  const kemKP = ml_kem768.keygen();

  return {
    conversationId,
    DHs: `${ourPrivB64}|${ourPubB64}`,
    DHr: theirPubB64,
    KEMs: `${toBase64(kemKP.secretKey)}|${toBase64(kemKP.publicKey)}`,
    RK: toBase64(rk0),
    CKs: null,
    CKr: null,
    Ns: 0, Nr: 0, PN: 0,
    MKSKIPPED: {},
    HKs: toBase64(hks0),
    HKr: toBase64(hkr0),
    NHKs: toBase64(nhks0),
    NHKr: toBase64(nhkr0),
    HK: toBase64(hkr0), // legacy fallback
    createdAt: Date.now(),
  };
}

// ─── X3DH-bootstrapped session init ──────────────────────────────────────────
//
// These variants accept a pre-computed 32-byte X3DH shared secret (base64)
// instead of deriving it internally from a single DH step.  The rest of the
// ratchet setup is identical to the standard paths.

/**
 * Sender-side ratchet init using an X3DH-derived root secret.
 * `sessionSecretB64` is the 32-byte SK output from x3dhSenderSetup().
 */
export async function initSessionSenderFromSecret(
  conversationId: string,
  sessionSecretB64: string,
  _ourPrivB64: string,
  theirPubB64: string,
): Promise<RatchetSession> {
  const shared = fromBase64(sessionSecretB64);

  const initBytes = await hkdf(shared, ZEROS32, 'SylvaCrypt-InitV2', 160);
  const rk0   = initBytes.slice(0, 32);
  const hks0  = initBytes.slice(32, 64);
  const hkr0  = initBytes.slice(64, 96);
  const nhks0 = initBytes.slice(96, 128);
  const nhkr0 = initBytes.slice(128, 160);

  const eph   = generateX25519KeyPair();
  const dhOut = x25519DH(eph.privateKeyBase64, theirPubB64);
  const [newRK, cks, newNHKs] = await kdfRK(rk0, dhOut);

  const kemKP = ml_kem768.keygen();

  return {
    conversationId,
    DHs: `${eph.privateKeyBase64}|${eph.publicKeyBase64}`,
    DHr: theirPubB64,
    KEMs: `${toBase64(kemKP.secretKey)}|${toBase64(kemKP.publicKey)}`,
    RK: toBase64(newRK),
    CKs: toBase64(cks),
    CKr: null,
    Ns: 0, Nr: 0, PN: 0,
    MKSKIPPED: {},
    HKs: toBase64(nhks0),
    HKr: toBase64(hkr0),
    NHKs: toBase64(newNHKs),
    NHKr: toBase64(nhkr0),
    HK: toBase64(hks0),
    createdAt: Date.now(),
  };
}

/**
 * Receiver-side ratchet init using an X3DH-derived root secret.
 * `sessionSecretB64` is the 32-byte SK reproduced via x3dhReceiverSetupFull().
 */
export async function initSessionReceiverFromSecret(
  conversationId: string,
  sessionSecretB64: string,
  ourPrivB64: string,
  ourPubB64: string,
  theirPubB64: string,
): Promise<RatchetSession> {
  const shared = fromBase64(sessionSecretB64);

  const initBytes = await hkdf(shared, ZEROS32, 'SylvaCrypt-InitV2', 160);
  const rk0   = initBytes.slice(0, 32);
  const hks0  = initBytes.slice(64, 96);
  const hkr0  = initBytes.slice(96, 128);
  const nhks0 = initBytes.slice(128, 160);
  const nhkr0 = initBytes.slice(32, 64);

  const kemKP = ml_kem768.keygen();

  return {
    conversationId,
    DHs: `${ourPrivB64}|${ourPubB64}`,
    DHr: theirPubB64,
    KEMs: `${toBase64(kemKP.secretKey)}|${toBase64(kemKP.publicKey)}`,
    RK: toBase64(rk0),
    CKs: null,
    CKr: null,
    Ns: 0, Nr: 0, PN: 0,
    MKSKIPPED: {},
    HKs: toBase64(hks0),
    HKr: toBase64(hkr0),
    NHKs: toBase64(nhks0),
    NHKr: toBase64(nhkr0),
    HK: toBase64(hkr0),
    createdAt: Date.now(),
  };
}

// ─── Header encryption helpers ────────────────────────────────────────────────

interface PlaintextHeader {
  spk: string;  // senderPublicKey
  mn: number;   // messageNumber
  pcl: number;  // prevChainLength
  kem_pub?: string;
  kem_ct?: string;
}

/** Encrypt header fields → base64(12-byte IV ‖ AES-256-GCM ciphertext). */
async function encryptHeader(hkB64: string, h: PlaintextHeader): Promise<string> {
  const key = await importAESKey(fromBase64(hkB64));
  const { ciphertext, iv } = await aesEncrypt(key, new TextEncoder().encode(JSON.stringify(h)));
  const combined = new Uint8Array(12 + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(ciphertext, 12);
  return toBase64(combined);
}

/**
 * Try to decrypt an encrypted header blob with the given key.
 * Returns null on any failure (wrong key, corrupted blob) instead of throwing.
 */
async function tryDecryptHeader(hkB64: string, blob: string): Promise<PlaintextHeader | null> {
  try {
    const key = await importAESKey(fromBase64(hkB64));
    const combined = fromBase64(blob);
    const plain = await aesDecrypt(key, combined.slice(12), combined.slice(0, 12));
    return JSON.parse(new TextDecoder().decode(plain)) as PlaintextHeader;
  } catch {
    return null;
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function dhsPriv(s: RatchetSession): string {
  return s.DHs.includes('|') ? s.DHs.split('|')[0] : s.DHs;
}
function dhsPub(s: RatchetSession): string {
  return s.DHs.includes('|') ? s.DHs.split('|')[1] : '';
}

/**
 * Perform a full DH ratchet step (receiver side → new recv + new send chain).
 * Promotes NHKr→HKr and NHKs→HKs, then derives fresh NHKr and NHKs from
 * the two successive kdfRK calls so every epoch has a distinct header key.
 */
async function dhRatchetStep(
  session: RatchetSession,
  theirNewPubB64: string,
  theirKEMPubB64?: string,
  kemCiphertextB64?: string,
): Promise<RatchetSession> {
  const rk = fromBase64(session.RK);

  // Step 1: receiving ratchet
  // If they provided a KEM ciphertext, decapsulate using our KEM secret key
  let kemDecapsulated = new Uint8Array(0);
  if (kemCiphertextB64 && session.KEMs && session.KEMs.includes('|')) {
    const secKeyBase64 = session.KEMs.split('|')[0];
    try {
      kemDecapsulated = ml_kem768.decapsulate(fromBase64(kemCiphertextB64), fromBase64(secKeyBase64));
    } catch (e) {
      if (session.prevKEMs && session.prevKEMs.includes('|')) {
        try {
          const prevSecKeyBase64 = session.prevKEMs.split('|')[0];
          kemDecapsulated = ml_kem768.decapsulate(fromBase64(kemCiphertextB64), fromBase64(prevSecKeyBase64));
        } catch (e2) {
          console.error('🚨 [SECURITY WARNING] Post-Quantum KEM decapsulation failed for both current and prev keys!', e2);
          try { localStorage.setItem('sc_kem_failure_metric', String(Number(localStorage.getItem('sc_kem_failure_metric') || 0) + 1)); } catch {}
          throw new Error('KEM decapsulation failed for both current and prev keys. Hard failure triggered to prevent downgrade attack.');
        }
      } else {
        console.error('🚨 [SECURITY WARNING] Post-Quantum KEM decapsulation failed!', e);
        try { localStorage.setItem('sc_kem_failure_metric', String(Number(localStorage.getItem('sc_kem_failure_metric') || 0) + 1)); } catch {}
        throw new Error('KEM decapsulation failed. Hard failure triggered to prevent downgrade attack.');
      }
    }
  }

  // We mix DH shared secret and KEM shared secret
  const dhRecv = x25519DH(dhsPriv(session), theirNewPubB64);
  const mixedRecv = new Uint8Array(dhRecv.length + kemDecapsulated.length);
  mixedRecv.set(dhRecv);
  if (kemDecapsulated.length > 0) mixedRecv.set(kemDecapsulated, dhRecv.length);

  const [rk2, ckr, newNHKr] = await kdfRK(rk, mixedRecv);

  // Step 2: sending ratchet
  const newKP = generateX25519KeyPair();
  const newDHOut = x25519DH(newKP.privateKeyBase64, theirNewPubB64);
  
  let kemEncapsulated = new Uint8Array(0);
  let newKEMct: string | undefined;
  let newKEMs = session.KEMs;

  const theirKEMPub = theirKEMPubB64 ?? session.KEMr;
  if (theirKEMPub) {
    try {
      const { cipherText, sharedSecret } = ml_kem768.encapsulate(fromBase64(theirKEMPub));
      kemEncapsulated = sharedSecret;
      newKEMct = toBase64(cipherText);
    } catch (e) {
      console.error('🚨 [SECURITY WARNING] KEM encapsulation failed!', e);
      throw new Error('KEM encapsulation failed. Hard failure triggered.');
    }
  }

  // Generate new KEM sending key pair for our NEXT epoch
  try {
    const kemKP = ml_kem768.keygen();
    newKEMs = `${toBase64(kemKP.secretKey)}|${toBase64(kemKP.publicKey)}`;
  } catch (e) {
    console.error('🚨 [SECURITY WARNING] KEM keygen failed!', e);
    throw new Error('KEM keygen failed. Hard failure triggered.');
  }

  const mixedSend = new Uint8Array(newDHOut.length + kemEncapsulated.length);
  mixedSend.set(newDHOut);
  if (kemEncapsulated.length > 0) mixedSend.set(kemEncapsulated, newDHOut.length);

  const [rk3, cks, newNHKs] = await kdfRK(rk2, mixedSend);

  return {
    ...session,
    PN: session.Ns,
    Ns: 0, Nr: 0,
    DHs: `${newKP.privateKeyBase64}|${newKP.publicKeyBase64}`,
    DHr: theirNewPubB64,
    KEMr: theirKEMPub,
    KEMs: newKEMs,
    prevKEMs: session.KEMs,
    KEM_ct: newKEMct,
    RK: toBase64(rk3),
    CKs: toBase64(cks),
    CKr: toBase64(ckr),
    // Promote next-header-keys → current, store freshly derived ones as next
    HKr: session.NHKr,
    HKs: session.NHKs,
    NHKr: toBase64(newNHKr),
    NHKs: toBase64(newNHKs),
  };
}

/**
 * Advance the receiving chain, storing skipped message keys.
 * Each skipped entry records { mk, hk } so the correct header key is used
 * when the out-of-order message is eventually received.
 */
function pruneSkippedKeys(mks: Record<string, string>): Record<string, string> {
  const entries = Object.entries(mks);
  if (entries.length === 0) return mks;

  const now = Date.now();
  const parsed = entries.map(([key, val]) => {
    let ts = 0;
    try {
      const p = JSON.parse(val);
      if (p.ts) ts = p.ts;
    } catch {
      // plain string legacy entry, assume old
    }
    return { key, val, ts };
  });

  // Filter out expired
  let valid = parsed.filter(e => now - e.ts <= MAX_MKSKIPPED_AGE_MS);

  // If still too many, keep the newest ones
  if (valid.length > MAX_MKSKIPPED_ENTRIES) {
    valid.sort((a, b) => b.ts - a.ts); // descending
    valid = valid.slice(0, MAX_MKSKIPPED_ENTRIES);
  }

  const pruned: Record<string, string> = {};
  for (const e of valid) {
    pruned[e.key] = e.val;
  }
  return pruned;
}

async function skipKeys(s: RatchetSession, until: number): Promise<RatchetSession> {
  if (s.Nr + MAX_SKIP < until) throw new Error('Too many skipped messages');
  const activeHKr = s.HKr ?? s.HK ?? null;
  let cur = { ...s, MKSKIPPED: { ...s.MKSKIPPED } };
  while (cur.Nr < until && cur.CKr) {
    const [nck, mk] = await kdfCK(fromBase64(cur.CKr));
    const skEntry = activeHKr
      ? JSON.stringify({ mk: toBase64(mk), hk: activeHKr, ts: Date.now() })
      : JSON.stringify({ mk: toBase64(mk), ts: Date.now() }); // standardize on JSON format even for legacy
    cur = {
      ...cur,
      MKSKIPPED: { ...cur.MKSKIPPED, [`${cur.DHr}:${cur.Nr}`]: skEntry },
      CKr: toBase64(nck),
      Nr: cur.Nr + 1,
    };
  }
  
  cur.MKSKIPPED = pruneSkippedKeys(cur.MKSKIPPED);
  return cur;
}

async function encryptWithMK(mk: Uint8Array, plaintext: string): Promise<{ ciphertext: string; iv: string }> {
  const key = await importAESKey(mk);
  const { ciphertext, iv } = await aesEncrypt(key, new TextEncoder().encode(plaintext));
  return { ciphertext: toBase64(ciphertext), iv: toBase64(iv) };
}

async function decryptWithMK(mk: Uint8Array, ciphertext: string, iv: string): Promise<string> {
  const key = await importAESKey(mk);
  const plain = await aesDecrypt(key, fromBase64(ciphertext), fromBase64(iv));
  return new TextDecoder().decode(plain);
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function ratchetEncrypt(
  session: RatchetSession,
  plaintext: string,
): Promise<{ envelope: EncryptedEnvelope; updatedSession: RatchetSession }> {
  let s = { ...session, MKSKIPPED: { ...session.MKSKIPPED } };

  if (!s.CKs) {
    s = await dhRatchetStep(s, s.DHr!);
  }

  const [newCKs, mk] = await kdfCK(fromBase64(s.CKs!));
  const { ciphertext, iv } = await encryptWithMK(mk, plaintext);

  const headerFields: PlaintextHeader = { spk: dhsPub(s), mn: s.Ns, pcl: s.PN };
  
  if (s.KEMs && s.KEMs.includes('|')) {
    headerFields.kem_pub = s.KEMs.split('|')[1];
  }
  if (s.KEM_ct) {
    headerFields.kem_ct = s.KEM_ct;
  }

  // v2.5.0+: use per-epoch HKs; v2.4.0: use legacy shared HK; pre-v2.4.0: cleartext
  const activeHK = s.HKs ?? s.HK ?? null;
  const envelope: EncryptedEnvelope = activeHK
    ? { encryptedHeader: await encryptHeader(activeHK, headerFields), ciphertext, iv }
    : { header: { senderPublicKey: headerFields.spk, messageNumber: headerFields.mn, prevChainLength: headerFields.pcl, kem_pub: headerFields.kem_pub, kem_ct: headerFields.kem_ct }, ciphertext, iv };

  return {
    envelope,
    updatedSession: { ...s, CKs: toBase64(newCKs), Ns: s.Ns + 1 },
  };
}

export async function ratchetDecrypt(
  session: RatchetSession,
  envelope: EncryptedEnvelope,
): Promise<{ plaintext: string; updatedSession: RatchetSession }> {
  let s = { ...session, MKSKIPPED: { ...session.MKSKIPPED } };
  const { ciphertext, iv } = envelope;

  // ── Resolve header ────────────────────────────────────────────────────────
  let senderPublicKey: string;
  let messageNumber: number;
  let prevChainLength: number;
  let kemPub: string | undefined;
  let kemCt: string | undefined;

  if (envelope.encryptedHeader) {
    // v2.5.0+: try HKr first (current epoch), then NHKr (new DH step from sender),
    // then legacy shared HK for sessions upgraded from v2.4.0.
    const keysToTry = [
      s.HKr,
      s.NHKr,
      s.HK,
    ].filter((k): k is string => !!k);

    // Also try the header keys stored alongside any skipped-message entries
    // (covers out-of-order messages from a previous epoch).
    const skippedHKs = new Set<string>();
    for (const val of Object.values(s.MKSKIPPED)) {
      try {
        const parsed = JSON.parse(val as string);
        if (parsed?.hk) skippedHKs.add(parsed.hk);
      } catch { /* plain-string legacy entry — no HK */ }
    }
    skippedHKs.forEach(hk => { if (!keysToTry.includes(hk)) keysToTry.push(hk); });

    let resolved: PlaintextHeader | null = null;
    let resolvedHK: string | null = null;
    for (const hk of keysToTry) {
      resolved = await tryDecryptHeader(hk, envelope.encryptedHeader);
      if (resolved) { resolvedHK = hk; break; }
    }
    if (!resolved) throw new Error('Could not decrypt envelope header — no matching header key.');
    void resolvedHK; // used implicitly to select the right decryption path above
    senderPublicKey = resolved.spk;
    messageNumber = resolved.mn;
    prevChainLength = resolved.pcl;
    kemPub = resolved.kem_pub;
    kemCt = resolved.kem_ct;
  } else if (envelope.header) {
    // Pre-v2.4.0 cleartext header — backward compat
    senderPublicKey = envelope.header.senderPublicKey;
    messageNumber = envelope.header.messageNumber;
    prevChainLength = envelope.header.prevChainLength;
    kemPub = envelope.header.kem_pub;
    kemCt = envelope.header.kem_ct;
  } else {
    throw new Error('Envelope missing both encryptedHeader and header — cannot decrypt.');
  }

  // ── Check skipped message keys ────────────────────────────────────────────
  const skKey = `${senderPublicKey}:${messageNumber}`;
  if (s.MKSKIPPED[skKey] !== undefined) {
    const val = s.MKSKIPPED[skKey] as string;
    let mkB64: string;
    try {
      const parsed = JSON.parse(val);
      mkB64 = parsed.mk;
    } catch {
      mkB64 = val; // legacy plain-string entry
    }
    const mk = fromBase64(mkB64);
    const { [skKey]: _, ...rest } = s.MKSKIPPED;
    s = { ...s, MKSKIPPED: rest };
    return { plaintext: await decryptWithMK(mk, ciphertext, iv), updatedSession: s };
  }

  // ── DH ratchet step when the sender has advanced their ratchet key ────────
  if (senderPublicKey !== s.DHr) {
    if (s.CKr) s = await skipKeys(s, prevChainLength);
    s = await dhRatchetStep(s, senderPublicKey, kemPub, kemCt);
  }

  s = await skipKeys(s, messageNumber);

  if (!s.CKr) throw new Error('No receiving chain key');
  const [newCKr, mk] = await kdfCK(fromBase64(s.CKr));

  s.MKSKIPPED = pruneSkippedKeys(s.MKSKIPPED);

  return {
    plaintext: await decryptWithMK(mk, ciphertext, iv),
    updatedSession: { ...s, CKr: toBase64(newCKr), Nr: s.Nr + 1 },
  };
}
