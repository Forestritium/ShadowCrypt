/**
 * Crypto Worker proxy.
 *
 * Provides a simple promise-based API over the crypto Web Worker so that
 * CPU/memory-intensive operations can run off the main thread. The worker is
 * created lazily and falls back to main-thread execution if the worker fails to
 * instantiate (e.g. in tests or very old browsers).
 */

import { deriveVaultKey, fromBase64, toBase64 } from './crypto';

let worker: Worker | null = null;
let messageId = 0;
const pending = new Map<string, { resolve: (value: unknown) => void; reject: (reason: Error) => void }>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('../workers/crypto.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<{ id: string; result?: unknown; error?: string }>) => {
      const { id, result, error } = event.data;
      const handler = pending.get(id);
      if (!handler) return;
      pending.delete(id);
      if (error) {
        handler.reject(new Error(error));
      } else {
        handler.resolve(result);
      }
    };
    worker.onerror = (err) => {
      console.error('[CryptoWorker] Worker error:', err);
    };
  }
  return worker;
}

function post<T>(type: string, payload: Record<string, unknown>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = `${++messageId}`;
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    try {
      getWorker().postMessage({ id, type, ...payload });
    } catch (err) {
      pending.delete(id);
      reject(err as Error);
    }
  });
}

async function importRawKey(rawBase64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    fromBase64(rawBase64).buffer as ArrayBuffer,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/** Derive the vault AES key in the worker and return an AES-GCM CryptoKey. */
export async function deriveVaultKeyInWorker(
  password: string,
  salt: Uint8Array,
  kdfVersion: number
): Promise<CryptoKey> {
  try {
    const { rawBase64 } = (await post('deriveKey', {
      password,
      saltBase64: toBase64(salt),
      kdfVersion,
    })) as { rawBase64: string };
    return importRawKey(rawBase64);
  } catch {
    // Fallback to main thread if worker is unavailable.
    return deriveVaultKey(password, salt, kdfVersion);
  }
}

/** Generate a fresh Argon2id mnemonic hash + random salt in the worker. */
export async function generateMnemonicHashInWorker(mnemonic: string): Promise<{ hash: string; saltBase64: string }> {
  return post('generateMnemonicHash', { mnemonic }) as Promise<{ hash: string; saltBase64: string }>;
}

/** Verify a legacy PBKDF2 mnemonic hash in the worker. */
export async function verifyLegacyMnemonicInWorker(
  mnemonic: string,
  saltBase64: string,
  legacyHash: string
): Promise<boolean> {
  const { matches } = (await post('verifyLegacyMnemonic', {
    mnemonic,
    saltBase64,
    legacyHash,
  })) as { matches: boolean };
  return matches;
}
