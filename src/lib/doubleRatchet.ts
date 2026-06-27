/**
 * Signal Protocol Double Ratchet.
 * X25519 + HKDF-SHA256 + AES-256-GCM.
 *
 * Each message gets a unique derived key → full forward secrecy.
 * Ratchet sessions are stored encrypted in the local vault.
 *
 * Header encryption (v2.4.0+): envelope header fields (senderPublicKey,
 * messageNumber, prevChainLength) are AES-256-GCM encrypted with a shared
 * header key HK = HKDF(sharedSecret, zeros, "ShadowCrypt-HK", 32) derived
 * independently by both parties from the initial X25519 exchange.  The relay
 * operator sees only an opaque encryptedHeader blob.
 * Sessions without HK (created before v2.4.0) fall back to cleartext headers.
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

const ZEROS32 = new Uint8Array(32);
const MAX_SKIP = 1000;

// ─── KDF helpers ─────────────────────────────────────────────────────────────

/** DH ratchet KDF: (RK, dhOut) → (newRK, chainKey) */
async function kdfRK(rk: Uint8Array, dhOut: Uint8Array): Promise<[Uint8Array, Uint8Array]> {
  const out = await hkdf(dhOut, rk, 'ShadowCrypt-RK', 64);
  return [out.slice(0, 32), out.slice(32, 64)];
}

/** Symmetric chain KDF: chainKey → (newChainKey, messageKey) */
async function kdfCK(ck: Uint8Array): Promise<[Uint8Array, Uint8Array]> {
  const mk  = await hmacSha256(ck, new Uint8Array([1]));
  const nck = await hmacSha256(ck, new Uint8Array([2]));
  return [nck, mk];
}

// ─── Session initialisation ───────────────────────────────────────────────────

/** Alice initiates: she has Bob's identity public key. */
export async function initSessionSender(
  conversationId: string,
  ourPrivB64: string,
  theirPubB64: string,
): Promise<RatchetSession> {
  const shared = x25519DH(ourPrivB64, theirPubB64);
  const [rk, hkBytes] = await Promise.all([
    hkdf(shared, ZEROS32, 'ShadowCrypt-Init', 32),
    hkdf(shared, ZEROS32, 'ShadowCrypt-HK', 32),
  ]);

  const eph = generateX25519KeyPair();
  const dhOut = x25519DH(eph.privateKeyBase64, theirPubB64);
  const [newRK, cks] = await kdfRK(rk, dhOut);

  return {
    conversationId,
    DHs: `${eph.privateKeyBase64}|${eph.publicKeyBase64}`,
    DHr: theirPubB64,
    RK: toBase64(newRK),
    CKs: toBase64(cks),
    CKr: null,
    Ns: 0, Nr: 0, PN: 0,
    MKSKIPPED: {},
    HK: toBase64(hkBytes),
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
  const [rk, hkBytes] = await Promise.all([
    hkdf(shared, ZEROS32, 'ShadowCrypt-Init', 32),
    hkdf(shared, ZEROS32, 'ShadowCrypt-HK', 32),
  ]);

  return {
    conversationId,
    DHs: `${ourPrivB64}|${ourPubB64}`,
    DHr: theirPubB64,
    RK: toBase64(rk),
    CKs: null,
    CKr: null,
    Ns: 0, Nr: 0, PN: 0,
    MKSKIPPED: {},
    HK: toBase64(hkBytes),
  };
}

// ─── Header encryption helpers ────────────────────────────────────────────────

interface PlaintextHeader {
  spk: string;  // senderPublicKey
  mn: number;   // messageNumber
  pcl: number;  // prevChainLength
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

/** Decrypt base64(12-byte IV ‖ AES-256-GCM ciphertext) → header fields. */
async function decryptHeader(hkB64: string, blob: string): Promise<PlaintextHeader> {
  const key = await importAESKey(fromBase64(hkB64));
  const combined = fromBase64(blob);
  const plain = await aesDecrypt(key, combined.slice(12), combined.slice(0, 12));
  return JSON.parse(new TextDecoder().decode(plain)) as PlaintextHeader;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function dhsPriv(s: RatchetSession): string {
  return s.DHs.includes('|') ? s.DHs.split('|')[0] : s.DHs;
}
function dhsPub(s: RatchetSession): string {
  return s.DHs.includes('|') ? s.DHs.split('|')[1] : '';
}

async function dhRatchetStep(session: RatchetSession, theirNewPubB64: string): Promise<RatchetSession> {
  const rk = fromBase64(session.RK);

  const [rk2, ckr] = await kdfRK(rk, x25519DH(dhsPriv(session), theirNewPubB64));

  const newKP = generateX25519KeyPair();
  const [rk3, cks] = await kdfRK(rk2, x25519DH(newKP.privateKeyBase64, theirNewPubB64));

  return {
    ...session,
    PN: session.Ns,
    Ns: 0, Nr: 0,
    DHs: `${newKP.privateKeyBase64}|${newKP.publicKeyBase64}`,
    DHr: theirNewPubB64,
    RK: toBase64(rk3),
    CKs: toBase64(cks),
    CKr: toBase64(ckr),
  };
}

async function skipKeys(s: RatchetSession, until: number): Promise<RatchetSession> {
  if (s.Nr + MAX_SKIP < until) throw new Error('Too many skipped messages');
  let cur = { ...s, MKSKIPPED: { ...s.MKSKIPPED } };
  while (cur.Nr < until && cur.CKr) {
    const [nck, mk] = await kdfCK(fromBase64(cur.CKr));
    cur = {
      ...cur,
      MKSKIPPED: { ...cur.MKSKIPPED, [`${cur.DHr}:${cur.Nr}`]: toBase64(mk) },
      CKr: toBase64(nck),
      Nr: cur.Nr + 1,
    };
  }
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

  // Encrypt header when HK is available (v2.4.0+); fall back to cleartext for
  // legacy stored sessions that pre-date header encryption.
  const envelope: EncryptedEnvelope = s.HK
    ? { encryptedHeader: await encryptHeader(s.HK, headerFields), ciphertext, iv }
    : { header: { senderPublicKey: headerFields.spk, messageNumber: headerFields.mn, prevChainLength: headerFields.pcl }, ciphertext, iv };

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

  // Resolve header — decrypt if encrypted, fall back to cleartext for legacy envelopes
  let senderPublicKey: string;
  let messageNumber: number;
  let prevChainLength: number;

  if (envelope.encryptedHeader && s.HK) {
    const h = await decryptHeader(s.HK, envelope.encryptedHeader);
    senderPublicKey = h.spk;
    messageNumber = h.mn;
    prevChainLength = h.pcl;
  } else if (envelope.header) {
    // Backward-compatible path for pre-v2.4.0 envelopes
    ({ senderPublicKey, messageNumber, prevChainLength } = envelope.header);
  } else {
    throw new Error('Envelope missing both encryptedHeader and header — cannot decrypt.');
  }

  // Check for a previously skipped message key
  const skKey = `${senderPublicKey}:${messageNumber}`;
  if (s.MKSKIPPED[skKey]) {
    const mk = fromBase64(s.MKSKIPPED[skKey]);
    const { [skKey]: _, ...rest } = s.MKSKIPPED;
    s = { ...s, MKSKIPPED: rest };
    return { plaintext: await decryptWithMK(mk, ciphertext, iv), updatedSession: s };
  }

  // DH ratchet step when the sender has advanced their ratchet key
  if (senderPublicKey !== s.DHr) {
    if (s.CKr) s = await skipKeys(s, prevChainLength);
    s = await dhRatchetStep(s, senderPublicKey);
  }

  s = await skipKeys(s, messageNumber);

  if (!s.CKr) throw new Error('No receiving chain key');
  const [newCKr, mk] = await kdfCK(fromBase64(s.CKr));

  return {
    plaintext: await decryptWithMK(mk, ciphertext, iv),
    updatedSession: { ...s, CKr: toBase64(newCKr), Nr: s.Nr + 1 },
  };
}
