/**
 * Signal Protocol Double Ratchet.
 * X25519 + HKDF-SHA256 + AES-256-GCM.
 *
 * Each message gets a unique derived key → full forward secrecy.
 * Ratchet sessions are stored encrypted in the local vault.
 *
 * Deviation from full Signal spec: the envelope header (senderPublicKey,
 * messageNumber, prevChainLength) is sent in cleartext. Signal's "sealed
 * sender" header encryption is deferred to a future release. The metadata
 * exposure is limited to the ephemeral DH public key and per-conversation
 * counters — message content is always fully encrypted.
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
  const rk = await hkdf(shared, ZEROS32, 'ShadowCrypt-Init', 32);

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
  const rk = await hkdf(shared, ZEROS32, 'ShadowCrypt-Init', 32);

  return {
    conversationId,
    DHs: `${ourPrivB64}|${ourPubB64}`,
    DHr: theirPubB64,
    RK: toBase64(rk),
    CKs: null,
    CKr: null,
    Ns: 0, Nr: 0, PN: 0,
    MKSKIPPED: {},
  };
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

  const envelope: EncryptedEnvelope = {
    header: {
      senderPublicKey: dhsPub(s),
      messageNumber: s.Ns,
      prevChainLength: s.PN,
    },
    ciphertext,
    iv,
  };

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
  const { header, ciphertext, iv } = envelope;

  // Check for a previously skipped message key
  const skKey = `${header.senderPublicKey}:${header.messageNumber}`;
  if (s.MKSKIPPED[skKey]) {
    const mk = fromBase64(s.MKSKIPPED[skKey]);
    const { [skKey]: _, ...rest } = s.MKSKIPPED;
    s = { ...s, MKSKIPPED: rest };
    return { plaintext: await decryptWithMK(mk, ciphertext, iv), updatedSession: s };
  }

  // DH ratchet step when the sender has advanced their ratchet key
  if (header.senderPublicKey !== s.DHr) {
    if (s.CKr) s = await skipKeys(s, header.prevChainLength);
    s = await dhRatchetStep(s, header.senderPublicKey);
  }

  s = await skipKeys(s, header.messageNumber);

  if (!s.CKr) throw new Error('No receiving chain key');
  const [newCKr, mk] = await kdfCK(fromBase64(s.CKr));

  return {
    plaintext: await decryptWithMK(mk, ciphertext, iv),
    updatedSession: { ...s, CKr: toBase64(newCKr), Nr: s.Nr + 1 },
  };
}
