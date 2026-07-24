/**
 * Crypto Web Worker
 *
 * Offloads CPU-intensive and memory-hard cryptographic operations from the main
 * thread so the UI stays responsive during vault unlock, Argon2id KDF, and
 * recovery-phrase hashing.
 */

import { argon2id } from 'hash-wasm';
import { deriveVaultKey, fromBase64, toBase64 } from '@/lib/crypto';

const MNEMONIC_PBKDF2_ITERATIONS = 100_000;

function normalizeMnemonic(mnemonic: string): string {
  return mnemonic.normalize('NFKD').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Self-contained legacy PBKDF2-SHA256 hash used for transparent recovery-phrase
// migration. Kept here so the worker can verify an old hash before re-hashing.
async function pbkdf2HashMnemonic(mnemonic: string, saltBase64: string): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(normalizeMnemonic(mnemonic)),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: fromBase64(saltBase64).buffer as ArrayBuffer, iterations: MNEMONIC_PBKDF2_ITERATIONS },
    keyMaterial,
    32 * 8
  );
  return Array.from(new Uint8Array(derived)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function argon2idHashMnemonic(mnemonic: string, saltBase64: string): Promise<string> {
  const raw = await argon2id({
    password: normalizeMnemonic(mnemonic),
    salt: fromBase64(saltBase64),
    parallelism: 4,
    iterations: 4,
    memorySize: 262144,
    hashLength: 32,
    outputType: 'binary',
  });
  return Array.from(raw as Uint8Array).map(b => b.toString(16).padStart(2, '0')).join('');
}

interface BaseMessage {
  id: string;
}

interface DeriveKeyMessage extends BaseMessage {
  type: 'deriveKey';
  password: string;
  saltBase64: string;
  kdfVersion: number;
}

interface HashMnemonicMessage extends BaseMessage {
  type: 'hashMnemonic';
  mnemonic: string;
  saltBase64: string;
}

interface GenerateMnemonicHashMessage extends BaseMessage {
  type: 'generateMnemonicHash';
  mnemonic: string;
}

interface VerifyLegacyMnemonicMessage extends BaseMessage {
  type: 'verifyLegacyMnemonic';
  mnemonic: string;
  saltBase64: string;
  legacyHash: string;
}

type InMessage =
  | DeriveKeyMessage
  | HashMnemonicMessage
  | GenerateMnemonicHashMessage
  | VerifyLegacyMnemonicMessage;

function postResult(id: string, result: unknown) {
  self.postMessage({ id, result });
}

function postError(id: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  self.postMessage({ id, error: message });
}

self.onmessage = async (event: MessageEvent<InMessage>) => {
  const msg = event.data;
  const messageId = msg.id;
  try {
    switch (msg.type) {
      case 'deriveKey': {
        const key = await deriveVaultKey(msg.password, fromBase64(msg.saltBase64), msg.kdfVersion);
        const raw = await crypto.subtle.exportKey('raw', key);
        postResult(msg.id, { rawBase64: toBase64(new Uint8Array(raw)) });
        break;
      }
      case 'hashMnemonic': {
        const hash = await argon2idHashMnemonic(msg.mnemonic, msg.saltBase64);
        postResult(msg.id, { hash });
        break;
      }
      case 'generateMnemonicHash': {
        const saltBase64 = toBase64(crypto.getRandomValues(new Uint8Array(16)));
        const hash = await argon2idHashMnemonic(msg.mnemonic, saltBase64);
        postResult(msg.id, { hash, saltBase64 });
        break;
      }
      case 'verifyLegacyMnemonic': {
        const computed = await pbkdf2HashMnemonic(msg.mnemonic, msg.saltBase64);
        postResult(msg.id, { matches: computed === msg.legacyHash.toLowerCase() });
        break;
      }
      default:
        postError(messageId, `Unknown crypto worker message type: ${(msg as { type: string }).type}`);
    }
  } catch (err) {
    postError(messageId, err);
  }
};

export {};
