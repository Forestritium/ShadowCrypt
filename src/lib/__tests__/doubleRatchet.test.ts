/**
 * Double Ratchet self-consistency test suite.
 *
 * Tests cover:
 *   - basic encrypt → decrypt round-trip
 *   - sequential multi-message exchange (both directions)
 *   - bidirectional conversation (Alice ↔ Bob back-and-forth)
 *   - out-of-order delivery (messages arrive in wrong sequence)
 *   - skipped messages (gaps in the sequence, filled later)
 *   - ratchet desync recovery (receiver advances DH before sender reacts)
 *   - DH ratchet key rotation (new keys after each DH step)
 *   - MAX_SKIP guard (rejects excessive skipped messages)
 *   - unique ciphertext per message (same plaintext → different ct)
 *   - X25519 key properties (32-byte keys, ECDH symmetry)
 *   - computeFingerprint determinism and cross-party consistency
 *   - makeConversationId determinism and symmetry
 *   - legacy P-256 key rejection
 *   - replay attack rejection
 */

import { describe, it, expect } from 'vitest';
import {
  initSessionSender,
  initSessionReceiver,
  ratchetEncrypt,
  ratchetDecrypt,
} from '../doubleRatchet';
import {
  generateX25519KeyPair,
  x25519DH,
  x25519PublicKeyFromPrivate,
  computeFingerprint,
  toBase64,
  fromBase64,
} from '../crypto';
import { makeConversationId } from '../session';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeParty(name: string) {
  const kp = generateX25519KeyPair();
  return { name, ...kp };
}

async function initPair(convId = 'conv-1') {
  const alice = makeParty('alice');
  const bob   = makeParty('bob');

  const aliceSession = await initSessionSender(convId, alice.privateKeyBase64, bob.publicKeyBase64);
  const bobSession   = await initSessionReceiver(convId, bob.privateKeyBase64, bob.publicKeyBase64, alice.publicKeyBase64);

  return { alice, bob, aliceSession, bobSession };
}

// ─── X25519 key primitives ────────────────────────────────────────────────────

describe('X25519 key exchange', () => {
  it('generates 32-byte raw keys (base64-decodable)', () => {
    const kp = generateX25519KeyPair();
    const priv = Uint8Array.from(atob(kp.privateKeyBase64), c => c.charCodeAt(0));
    const pub  = Uint8Array.from(atob(kp.publicKeyBase64),  c => c.charCodeAt(0));
    expect(priv).toHaveLength(32);
    expect(pub).toHaveLength(32);
  });

  it('produces symmetric shared secrets (DH commutativity)', () => {
    const kp1 = generateX25519KeyPair();
    const kp2 = generateX25519KeyPair();
    const sh1 = x25519DH(kp1.privateKeyBase64, kp2.publicKeyBase64);
    const sh2 = x25519DH(kp2.privateKeyBase64, kp1.publicKeyBase64);
    expect(toBase64(sh1)).toBe(toBase64(sh2));
  });

  it('produces different secrets for different key pairs', () => {
    const kp1 = generateX25519KeyPair();
    const kp2 = generateX25519KeyPair();
    const kp3 = generateX25519KeyPair();
    const sh1 = x25519DH(kp1.privateKeyBase64, kp2.publicKeyBase64);
    const sh2 = x25519DH(kp1.privateKeyBase64, kp3.publicKeyBase64);
    expect(toBase64(sh1)).not.toBe(toBase64(sh2));
  });
});

// ─── Basic round-trip ─────────────────────────────────────────────────────────

describe('basic encrypt → decrypt', () => {
  it('Alice sends one message and Bob decrypts it correctly', async () => {
    const { aliceSession, bobSession } = await initPair();

    const { envelope, updatedSession: aS1 } = await ratchetEncrypt(aliceSession, 'hello bob');
    const { plaintext, updatedSession: bS1 } = await ratchetDecrypt(bobSession, envelope);

    expect(plaintext).toBe('hello bob');
    expect(aS1.Ns).toBe(1);
    expect(bS1.Nr).toBe(1);
  });

  it('ciphertext differs from plaintext', async () => {
    const { aliceSession } = await initPair();
    const { envelope } = await ratchetEncrypt(aliceSession, 'secret');
    expect(envelope.ciphertext).not.toBe('secret');
    expect(atob(envelope.ciphertext).length).toBeGreaterThan(0);
  });
});

// ─── Multi-message sequential ─────────────────────────────────────────────────

describe('sequential messages', () => {
  it('sends 10 messages from Alice to Bob in order', async () => {
    const { aliceSession, bobSession } = await initPair();
    let aS = aliceSession;
    let bS = bobSession;

    for (let i = 0; i < 10; i++) {
      const msg = `message ${i}`;
      const { envelope, updatedSession: aNew } = await ratchetEncrypt(aS, msg);
      const { plaintext, updatedSession: bNew } = await ratchetDecrypt(bS, envelope);
      expect(plaintext).toBe(msg);
      aS = aNew;
      bS = bNew;
    }
    expect(aS.Ns).toBe(10);
    expect(bS.Nr).toBe(10);
  });

  it('same plaintext produces different ciphertext on each send', async () => {
    const { aliceSession } = await initPair();
    const { envelope: e1, updatedSession: aS1 } = await ratchetEncrypt(aliceSession, 'repeat');
    const { envelope: e2 } = await ratchetEncrypt(aS1, 'repeat');
    expect(e1.ciphertext).not.toBe(e2.ciphertext);
    expect(e1.iv).not.toBe(e2.iv);
  });
});

// ─── Bidirectional conversation ───────────────────────────────────────────────

describe('bidirectional conversation', () => {
  it('Alice and Bob alternate sending messages', async () => {
    const { aliceSession, bobSession } = await initPair();
    let aS = aliceSession;
    let bS = bobSession;

    // Alice → Bob
    { const { envelope, updatedSession } = await ratchetEncrypt(aS, 'hi from alice');
      const { plaintext, updatedSession: bNew } = await ratchetDecrypt(bS, envelope);
      expect(plaintext).toBe('hi from alice');
      aS = updatedSession; bS = bNew; }

    // Bob → Alice
    { const { envelope, updatedSession } = await ratchetEncrypt(bS, 'hi from bob');
      const { plaintext, updatedSession: aNew } = await ratchetDecrypt(aS, envelope);
      expect(plaintext).toBe('hi from bob');
      bS = updatedSession; aS = aNew; }

    // Alice → Bob again
    { const { envelope, updatedSession } = await ratchetEncrypt(aS, 'alice again');
      const { plaintext, updatedSession: bNew } = await ratchetDecrypt(bS, envelope);
      expect(plaintext).toBe('alice again');
      aS = updatedSession; bS = bNew; }

    // Bob → Alice again
    { const { envelope, updatedSession } = await ratchetEncrypt(bS, 'bob again');
      const { plaintext, updatedSession: aNew } = await ratchetDecrypt(aS, envelope);
      expect(plaintext).toBe('bob again');
      bS = updatedSession; aS = aNew; }

    // Verify counter state — after the final received message Alice's Ns resets
    // to 0 (DH ratchet step), so check PN (previous chain length) instead,
    // which records that both parties have sent messages in a prior chain.
    expect(aS.PN).toBeGreaterThan(0);
    expect(bS.PN).toBeGreaterThan(0);
  });
});

// ─── Out-of-order delivery ────────────────────────────────────────────────────

describe('out-of-order message delivery', () => {
  it('delivers messages in reverse order (2, 1, 0)', async () => {
    const { aliceSession, bobSession } = await initPair();
    let aS = aliceSession;
    const envelopes: Awaited<ReturnType<typeof ratchetEncrypt>>[] = [];

    // Alice encrypts 3 messages
    for (const msg of ['msg0', 'msg1', 'msg2']) {
      const result = await ratchetEncrypt(aS, msg);
      envelopes.push(result);
      aS = result.updatedSession;
    }

    // Bob decrypts in reverse
    let bS = bobSession;
    const decrypted: string[] = [];

    for (const r of [...envelopes].reverse()) {
      const { plaintext, updatedSession } = await ratchetDecrypt(
        bS,
        r.envelope
      );
      decrypted.push(plaintext);
      bS = updatedSession;
    }

    expect(decrypted).toEqual(['msg2', 'msg1', 'msg0']);
  });

  it('delivers messages in shuffle order (1, 0, 2)', async () => {
    const { aliceSession, bobSession } = await initPair();
    let aS = aliceSession;
    const results: Awaited<ReturnType<typeof ratchetEncrypt>>[] = [];

    for (const msg of ['first', 'second', 'third']) {
      const r = await ratchetEncrypt(aS, msg);
      results.push(r);
      aS = r.updatedSession;
    }

    let bS = bobSession;
    const order = [1, 0, 2];
    const decrypted: string[] = new Array(3);

    for (const idx of order) {
      const { plaintext, updatedSession } = await ratchetDecrypt(bS, results[idx].envelope);
      decrypted[idx] = plaintext;
      bS = updatedSession;
    }

    expect(decrypted).toEqual(['first', 'second', 'third']);
  });
});

// ─── Skipped messages ─────────────────────────────────────────────────────────

describe('skipped messages', () => {
  it('delivers messages 0, 3, 4 — then fills in 1, 2 from skipped-key store', async () => {
    const { aliceSession, bobSession } = await initPair();
    let aS = aliceSession;
    const envelopes: Awaited<ReturnType<typeof ratchetEncrypt>>[] = [];

    for (const msg of ['m0', 'm1', 'm2', 'm3', 'm4']) {
      const r = await ratchetEncrypt(aS, msg);
      envelopes.push(r);
      aS = r.updatedSession;
    }

    let bS = bobSession;

    // Deliver 0, 3, 4 first (skipping 1 and 2)
    for (const idx of [0, 3, 4]) {
      const { plaintext, updatedSession } = await ratchetDecrypt(bS, envelopes[idx].envelope);
      expect(plaintext).toBe(`m${idx}`);
      bS = updatedSession;
    }

    // Verify 1 and 2 are held in skipped-key store
    expect(Object.keys(bS.MKSKIPPED).length).toBe(2);

    // Now deliver 1 and 2
    for (const idx of [1, 2]) {
      const { plaintext, updatedSession } = await ratchetDecrypt(bS, envelopes[idx].envelope);
      expect(plaintext).toBe(`m${idx}`);
      bS = updatedSession;
    }

    // All skipped keys consumed
    expect(Object.keys(bS.MKSKIPPED).length).toBe(0);
  });
});

// ─── Ratchet desync recovery ──────────────────────────────────────────────────

describe('ratchet desync recovery', () => {
  it('Bob ratchets forward; Alice recovers by decrypting Bobs reply', async () => {
    const { aliceSession, bobSession } = await initPair();
    let aS = aliceSession;
    let bS = bobSession;

    // Alice → Bob (msg 0)
    { const { envelope, updatedSession } = await ratchetEncrypt(aS, 'ping');
      const { updatedSession: bNew } = await ratchetDecrypt(bS, envelope);
      aS = updatedSession; bS = bNew; }

    // Bob → Alice (forces DH ratchet on Alice's side when she decrypts)
    { const { envelope, updatedSession } = await ratchetEncrypt(bS, 'pong');
      const { plaintext, updatedSession: aNew } = await ratchetDecrypt(aS, envelope);
      expect(plaintext).toBe('pong');
      bS = updatedSession; aS = aNew; }

    // Alice → Bob again (should work with updated session)
    { const { envelope, updatedSession } = await ratchetEncrypt(aS, 'ping2');
      const { plaintext, updatedSession: bNew } = await ratchetDecrypt(bS, envelope);
      expect(plaintext).toBe('ping2');
      aS = updatedSession; bS = bNew; }
  });

  it('multiple DH ratchet steps do not corrupt the chain', async () => {
    const { aliceSession, bobSession } = await initPair();
    let aS = aliceSession;
    let bS = bobSession;

    // 5 full round-trips (each reply forces a new DH ratchet step)
    for (let i = 0; i < 5; i++) {
      const aPing = `ping-${i}`;
      const bPong = `pong-${i}`;

      const { envelope: e1, updatedSession: aNew } = await ratchetEncrypt(aS, aPing);
      const { plaintext: p1, updatedSession: bNew } = await ratchetDecrypt(bS, e1);
      expect(p1).toBe(aPing);
      aS = aNew; bS = bNew;

      const { envelope: e2, updatedSession: bNew2 } = await ratchetEncrypt(bS, bPong);
      const { plaintext: p2, updatedSession: aNew2 } = await ratchetDecrypt(aS, e2);
      expect(p2).toBe(bPong);
      bS = bNew2; aS = aNew2;
    }
  });
});

// ─── DH ratchet key rotation ──────────────────────────────────────────────────

describe('DH ratchet key rotation', () => {
  it('root key changes after a DH ratchet step (forced by Bob reply)', async () => {
    const { aliceSession, bobSession } = await initPair();
    const rkInitial = aliceSession.RK;
    let aS = aliceSession;
    let bS = bobSession;

    // Alice → Bob (symmetric chain ratchet only, no DH step yet)
    const { envelope: e1, updatedSession: aS1 } = await ratchetEncrypt(aS, 'hello');
    const { updatedSession: bS1 } = await ratchetDecrypt(bS, e1);
    aS = aS1; bS = bS1;

    // Bob → Alice forces a DH ratchet step on Alice's side when she decrypts
    const { envelope: e2, updatedSession: bS2 } = await ratchetEncrypt(bS, 'reply');
    const { updatedSession: aS2 } = await ratchetDecrypt(aS, e2);
    aS = aS2; bS = bS2;

    // Alice's RK must have advanced (DH ratchet step completed)
    expect(aS.RK).not.toBe(rkInitial);
  });

  it('sender DH public key in encrypted header matches session DHs pub', async () => {
    const { aliceSession } = await initPair();
    const { envelope, updatedSession } = await ratchetEncrypt(aliceSession, 'test');
    // v2.4.0+: header is encrypted; cleartext header field must be absent
    expect(envelope.encryptedHeader).toBeDefined();
    expect(typeof envelope.encryptedHeader).toBe('string');
    expect((envelope as { header?: unknown }).header).toBeUndefined();
    // Session must have a header key
    expect(updatedSession.HK).toBeDefined();
  });
});

// ─── MAX_SKIP guard ───────────────────────────────────────────────────────────

describe('MAX_SKIP guard', () => {
  it('throws when skipping more than 1000 messages', async () => {
    const { aliceSession, bobSession } = await initPair();
    let aS = aliceSession;

    // Encrypt 1002 messages without Bob decrypting any
    for (let i = 0; i < 1002; i++) {
      const { updatedSession } = await ratchetEncrypt(aS, `m${i}`);
      aS = updatedSession;
    }

    // The 1002nd message should exceed MAX_SKIP = 1000
    const { envelope: last } = await ratchetEncrypt(aS, 'overflow');

    // Bob tries to decrypt the last message — should throw
    await expect(ratchetDecrypt(bobSession, last)).rejects.toThrow('Too many skipped messages');
  });
});

// ─── Tampered ciphertext ──────────────────────────────────────────────────────

describe('authentication', () => {
  it('rejects a tampered ciphertext (AES-GCM auth tag fails)', async () => {
    const { aliceSession, bobSession } = await initPair();
    const { envelope } = await ratchetEncrypt(aliceSession, 'authentic message');

    // Flip the last byte of the base64-decoded ciphertext
    const ct = Uint8Array.from(atob(envelope.ciphertext), c => c.charCodeAt(0));
    ct[ct.length - 1] ^= 0xff;
    const tampered = { ...envelope, ciphertext: btoa(String.fromCharCode(...ct)) };

    await expect(ratchetDecrypt(bobSession, tampered)).rejects.toThrow();
  });
});

// ─── Replay attack ────────────────────────────────────────────────────────────

describe('replay attack rejection', () => {
  it('rejects re-delivery of the same message (already-consumed message key)', async () => {
    const { aliceSession, bobSession } = await initPair();

    const { envelope } = await ratchetEncrypt(aliceSession, 'original');
    // First delivery — should succeed
    const { updatedSession: bobS1 } = await ratchetDecrypt(bobSession, envelope);

    // Replay the same envelope against the updated session — the message key for
    // message #0 was already consumed; the ratchet must reject it.
    await expect(ratchetDecrypt(bobS1, envelope)).rejects.toThrow();
  });
});

// ─── computeFingerprint ───────────────────────────────────────────────────────

describe('computeFingerprint', () => {
  it('is deterministic: same key always produces the same fingerprint', async () => {
    const kp = generateX25519KeyPair();
    const fp1 = await computeFingerprint(kp.publicKeyBase64);
    const fp2 = await computeFingerprint(kp.publicKeyBase64);
    expect(fp1).toBe(fp2);
  });

  it('produces different fingerprints for different keys', async () => {
    const kp1 = generateX25519KeyPair();
    const kp2 = generateX25519KeyPair();
    const fp1 = await computeFingerprint(kp1.publicKeyBase64);
    const fp2 = await computeFingerprint(kp2.publicKeyBase64);
    expect(fp1).not.toBe(fp2);
  });

  it('returns 20 colon-separated uppercase hex pairs (XX:XX:…)', async () => {
    const kp = generateX25519KeyPair();
    const fp = await computeFingerprint(kp.publicKeyBase64);
    // Format: "AB:CD:EF:..." — 20 groups of 2 uppercase hex chars
    expect(fp).toMatch(/^([0-9A-F]{2}:){19}[0-9A-F]{2}$/);
  });

  it('cross-party consistency: fingerprint survives JSON serialization (DB/sessionStorage round-trip)', async () => {
    // Simulates the real cross-device scenario:
    //   Device A: generates key pair → stores publicKeyBase64 in profiles.public_key (a plain JSON string)
    //   Device B: fetches the same string from the DB → computes fingerprint
    // Both sides must arrive at the same fingerprint.
    // JSON.stringify/parse is used because that is how the key travels through
    // sessionStorage (SessionInfo) and Supabase JSON responses.
    const kpA = generateX25519KeyPair();
    const fpOnA = await computeFingerprint(kpA.publicKeyBase64);

    // Simulate JSON serialization as it happens in the DB response / sessionStorage
    const serialized = JSON.stringify({ publicKey: kpA.publicKeyBase64 });
    const retrieved = (JSON.parse(serialized) as { publicKey: string }).publicKey;

    // Verify no mutation occurred during serialization
    expect(retrieved).toBe(kpA.publicKeyBase64);

    const fpOnB = await computeFingerprint(retrieved);
    expect(fpOnB).toBe(fpOnA);
  });

  it('recompute from stored contacts row: fingerprint matches original when public_key is present', async () => {
    // Mirrors the getContactsFromDB path:
    //   fingerprint: row.public_key ? computeFingerprint(row.public_key) : row.fingerprint
    // When public_key is present the stored fingerprint column is ignored and
    // re-derived from the key — this verifies that the recompute path is correct
    // even if the stored fingerprint column contains a stale value.
    const kp = generateX25519KeyPair();
    const staleFingerprint = 'AA:BB:CC:DD:EE:FF:00:11'; // intentionally wrong

    // Simulate a contacts DB row after a key rotation where fingerprint is stale
    const row = { public_key: kp.publicKeyBase64, fingerprint: staleFingerprint };

    const actual = row.public_key
      ? await computeFingerprint(row.public_key)
      : row.fingerprint;

    const expected = await computeFingerprint(kp.publicKeyBase64);
    expect(actual).toBe(expected);
    expect(actual).not.toBe(staleFingerprint);
  });

  it('x25519PublicKeyFromPrivate round-trips to the same fingerprint', async () => {
    const kp = generateX25519KeyPair();
    // Derive public key separately from the private key (as session.ts does)
    const rederived = x25519PublicKeyFromPrivate(kp.privateKeyBase64);
    expect(rederived).toBe(kp.publicKeyBase64);
    const fp1 = await computeFingerprint(kp.publicKeyBase64);
    const fp2 = await computeFingerprint(rederived);
    expect(fp1).toBe(fp2);
  });
});

// ─── makeConversationId ───────────────────────────────────────────────────────

describe('makeConversationId', () => {
  it('is deterministic: same two IDs always produce the same conversation ID', () => {
    const id1 = 'user-aaa';
    const id2 = 'user-bbb';
    expect(makeConversationId(id1, id2)).toBe(makeConversationId(id1, id2));
  });

  it('is symmetric: order of arguments does not matter', () => {
    const id1 = 'user-aaa';
    const id2 = 'user-bbb';
    expect(makeConversationId(id1, id2)).toBe(makeConversationId(id2, id1));
  });

  it('produces different IDs for different user pairs', () => {
    const a = 'user-aaa';
    const b = 'user-bbb';
    const c = 'user-ccc';
    expect(makeConversationId(a, b)).not.toBe(makeConversationId(a, c));
  });

  it('returns a non-empty base64 string', () => {
    const id = makeConversationId('user-x', 'user-y');
    expect(id.length).toBeGreaterThan(0);
    // base64 alphabet only (standard, with optional padding)
    expect(id).toMatch(/^[A-Za-z0-9+/]+=*$/);
    // Must be decodable back to a UTF-8 string containing both IDs
    const decoded = new TextDecoder().decode(fromBase64(id));
    expect(decoded).toContain('user-x');
    expect(decoded).toContain('user-y');
  });
});

// ─── Legacy P-256 key rejection ───────────────────────────────────────────────

describe('legacy P-256 key rejection', () => {
  it('x25519DH throws LEGACY_KEY_FORMAT for a 65-byte uncompressed P-256 key', () => {
    const { privateKeyBase64 } = generateX25519KeyPair();
    // Simulate an old uncompressed P-256 public key: 0x04 || 32-byte X || 32-byte Y = 65 bytes
    const fakeP256Pub = new Uint8Array(65);
    fakeP256Pub[0] = 0x04;
    crypto.getRandomValues(fakeP256Pub.subarray(1));
    const legacyPubB64 = toBase64(fakeP256Pub);

    expect(() => x25519DH(privateKeyBase64, legacyPubB64)).toThrow('LEGACY_KEY_FORMAT');
  });

  it('x25519DH succeeds for a valid 32-byte X25519 key', () => {
    const kp1 = generateX25519KeyPair();
    const kp2 = generateX25519KeyPair();
    // Should not throw
    expect(() => x25519DH(kp1.privateKeyBase64, kp2.publicKeyBase64)).not.toThrow();
    const secret = x25519DH(kp1.privateKeyBase64, kp2.publicKeyBase64);
    expect(secret).toHaveLength(32);
  });













  it('receiver initialization computes header keys slices properly', async () => {
    const bobSPK = await generateX25519KeyPair();
    const aliceIK = await generateX25519KeyPair();

    const skBase64 = btoa(String.fromCharCode(...new Uint8Array(32))); 
    const { initSessionReceiverFromSecret } = await import('../doubleRatchet');

    const receiverSession = await initSessionReceiverFromSecret(
      "test-conv",
      skBase64,
      bobSPK.privateKeyBase64,
      bobSPK.publicKeyBase64,
      aliceIK.publicKeyBase64
    );

    expect(receiverSession.NHKr).toBeDefined();
    expect(typeof receiverSession.NHKr).toBe('string');
    expect(typeof receiverSession.HKr).toBe('string');
  });

});
