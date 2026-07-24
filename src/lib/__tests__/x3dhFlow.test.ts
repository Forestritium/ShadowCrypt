import { generateUUID } from "@/lib/uuid";
/**
 * X3DH + Double Ratchet end-to-end flow test.
 * Simulates Alice sending her first X3DH-encrypted message to Bob,
 * Bob decrypting it, Bob replying, and Alice decrypting the reply.
 */

import { describe, it, expect } from 'vitest';
import {
  generateX25519KeyPair,
  generateEd25519KeyPair,
  toBase64,
  fromBase64,
  ed25519Sign,
} from '../crypto';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import { x3dhSenderSetup, x3dhReceiverSetupFull } from '../x3dh';
import { initSessionSenderFromSecret, initSessionReceiverFromSecret, ratchetEncrypt, ratchetDecrypt } from '../doubleRatchet';

// Re-export from x3dh for use in test
type SignedPrekeyBundle = import('../x3dh').SignedPrekeyBundle;

async function createBobBundle(bobIK: { publicKeyBase64: string }, useKEM = true): Promise<{ bundle: SignedPrekeyBundle; spkPriv: string; kemSec: string; opkPriv?: string }> {
  const ed = generateEd25519KeyPair();
  const spk = generateX25519KeyPair();
  const kem = useKEM ? ml_kem768.keygen() : null;
  const opk = generateX25519KeyPair();

  const sig = ed25519Sign(fromBase64(spk.publicKeyBase64), fromBase64(ed.privateKeyBase64));

  return {
    bundle: {
      ik_pub: bobIK.publicKeyBase64,
      spk_id: generateUUID(),
      spk_pub: spk.publicKeyBase64,
      spk_sig: toBase64(sig),
      ed25519_pub: ed.publicKeyBase64,
      kem_pub: kem ? toBase64(kem.publicKey) : undefined,
      opk_id: opk.publicKeyBase64 ? generateUUID() : undefined,
      opk_pub: opk.publicKeyBase64,
    },
    spkPriv: spk.privateKeyBase64,
    kemSec: kem ? toBase64(kem.secretKey) : '',
    opkPriv: opk.privateKeyBase64,
  };
}

describe('X3DH + Double Ratchet full flow', () => {
  it('classical X3DH secrets match (no KEM)', async () => {
    const aliceIK = generateX25519KeyPair();
    const bobIK = generateX25519KeyPair();
    const { bundle: bobBundle, spkPriv, opkPriv } = await createBobBundle(bobIK, false);

    const x3dhResult = await x3dhSenderSetup(aliceIK.privateKeyBase64, bobBundle);
    const sessionSecretBob = await x3dhReceiverSetupFull(
      bobIK.privateKeyBase64,
      aliceIK.publicKeyBase64,
      { ephemeralPub: x3dhResult.ephemeralPub, spkPriv, opkPriv },
      '',
    );
    expect(x3dhResult.sessionSecret).toBe(sessionSecretBob);
  });

  it('Alice → Bob first message, then Bob → Alice reply', async () => {
    // Alice keys
    const aliceIK = generateX25519KeyPair();
    const aliceEd = generateEd25519KeyPair();

    // Bob keys + bundle
    const bobIK = generateX25519KeyPair();
    const { bundle: bobBundle, spkPriv, kemSec, opkPriv } = await createBobBundle(bobIK);

    const conversationId = 'conv-x3dh-1';

    // ---- Alice side: compose first message ----
    const x3dhResult = await x3dhSenderSetup(aliceIK.privateKeyBase64, bobBundle);
    const aliceSession0 = await initSessionSenderFromSecret(
      conversationId,
      x3dhResult.sessionSecret,
      aliceIK.privateKeyBase64,
      bobBundle.ik_pub,
    );
    const { envelope, updatedSession: aliceSession1 } = await ratchetEncrypt(aliceSession0, 'hi');

    // Simulate payload wrapping as done in relay.ts
    const payload = {
      ...envelope,
      sik: aliceIK.publicKeyBase64,
      mid: generateUUID(),
      x3dh: {
        eph_pub: x3dhResult.ephemeralPub,
        spk_id: bobBundle.spk_id,
        kem_ct: x3dhResult.kemCiphertext,
        sender_ik_pub: aliceIK.publicKeyBase64,
      },
    };

    // ---- Bob side: decrypt first message ----
    const sessionSecretBob = await x3dhReceiverSetupFull(
      bobIK.privateKeyBase64,
      aliceIK.publicKeyBase64,
      {
        ephemeralPub: x3dhResult.ephemeralPub,
        spkPriv: spkPriv,
        opkPriv,
        kemCiphertext: x3dhResult.kemCiphertext,
      },
      kemSec,
    );
    const bobSession0 = await initSessionReceiverFromSecret(
      conversationId,
      sessionSecretBob,
      bobIK.privateKeyBase64,
      bobIK.publicKeyBase64,
      aliceIK.publicKeyBase64,
    );
    expect(x3dhResult.sessionSecret).toBe(sessionSecretBob);
    expect(aliceSession0.HKs).toBe(bobSession0.HKr);
    const { plaintext: p1, updatedSession: bobSession1 } = await ratchetDecrypt(bobSession0, envelope);
    expect(p1).toBe('hi');

    // ---- Bob side: send reply ----
    const { envelope: replyEnvelope, updatedSession: bobSession2 } = await ratchetEncrypt(bobSession1, 'hi back');

    // ---- Alice side: decrypt reply ----
    expect(aliceSession1.NHKr).toBe(bobSession2.HKs);
    const { plaintext: p2, updatedSession: aliceSession2 } = await ratchetDecrypt(aliceSession1, replyEnvelope);
    expect(p2).toBe('hi back');
  });
});
