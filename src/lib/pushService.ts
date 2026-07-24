import { getIdentityKeyPair } from './localStore';

/**
 * Sync the current identity private key to the Service Worker so it can decrypt
 * end-to-end encrypted push payloads when the app is not running.
 */
export async function syncPushIdentityKey(userId: string): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  const kp = await getIdentityKeyPair();
  if (!kp) return;
  const reg = await navigator.serviceWorker.ready;
  if (!reg.active) return;
  reg.active.postMessage({
    type: 'PUSH_IDENTITY_KEY',
    userId,
    privateKeyBase64: kp.privateKeyBase64,
  });
}
