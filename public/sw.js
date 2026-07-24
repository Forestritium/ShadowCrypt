// SylvaCrypt Service Worker
// Minimal SW to satisfy PWA installability requirements.
// No caching is intentional — all message data is encrypted and stored in
// IndexedDB by the app; serving stale assets could expose outdated crypto code.

const SW_VERSION = 'v4';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'PUSH_IDENTITY_KEY' && event.data.privateKeyBase64 && event.data.userId) {
    event.waitUntil(
      storePushIdentityKey(event.data.userId, event.data.privateKeyBase64)
    );
  }
});

self.addEventListener('push', (event) => {
  event.waitUntil(handlePush(event.data));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  let urlToOpen = event.notification.data?.url || '/chat';
  
  // Security: only allow relative URLs or exact same origin to prevent open redirect
  try {
    const parsed = new URL(urlToOpen, self.location.origin);
    if (parsed.origin !== self.location.origin) {
      urlToOpen = '/chat';
    } else {
      urlToOpen = parsed.pathname + parsed.search + parsed.hash;
    }
  } catch (e) {
    urlToOpen = '/chat';
  }

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // client.url is typically absolute, so we compare paths
      for (const client of clientList) {
        try {
          const clientPath = new URL(client.url).pathname;
          if (clientPath === urlToOpen && 'focus' in client) return client.focus();
        } catch (e) {}
      }
      if (self.clients.openWindow) return self.clients.openWindow(urlToOpen);
    })
  );
});

async function handlePush(data) {
  let payload = { title: 'SylvaCrypt', body: 'New activity in your vault', tag: 'sylvacrypt-push', data: {} };
  if (data) {
    try {
      const raw = data.json();
      payload = { ...payload, ...raw };
    } catch {
      payload.body = data.text();
    }
  }

  if (payload.encrypted) {
    try {
      const decrypted = await decryptPushPayload(payload.encrypted, payload.data?.userId);
      if (decrypted.senderUsername) {
        payload.title = 'SylvaCrypt';
        payload.body = `New message from @${decrypted.senderUsername}`;
      } else if (decrypted.callerUsername) {
        payload.title = 'SylvaCrypt';
        payload.body = `Missed call from @${decrypted.callerUsername}`;
      }
    } catch (err) {
      console.warn('[SylvaCrypt SW] Failed to decrypt push payload:', err);
      // Keep the anonymous fallback text.
    }
  }

  const options = {
    body: payload.body || 'New activity in your vault',
    icon: '/icon-192x192.png',
    badge: '/icon-192x192.png',
    tag: payload.tag || 'sylvacrypt-push',
    requireInteraction: payload.requireInteraction ?? false,
    data: payload.data || {},
  };
  return self.registration.showNotification(payload.title || 'SylvaCrypt', options);
}

// ── IndexedDB storage for push identity keys ─────────────────────────────────
const DB_NAME = 'SylvaCryptPushKeys';
const DB_VERSION = 1;
const STORE_NAME = 'keys';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
  });
}

async function storePushIdentityKey(userId, privateKeyBase64) {
  const privateKey = base64ToUint8Array(privateKeyBase64);
  const cryptoKey = await crypto.subtle.importKey(
    'raw', 
    privateKey, 
    { name: 'X25519' }, 
    false, 
    ['deriveBits']
  );
  
  const db = await openDb();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  tx.objectStore(STORE_NAME).put(cryptoKey, userId);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getPushIdentityKey(userId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    if (userId) {
      const req = store.get(userId);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    } else {
      const req = store.openCursor();
      let value = null;
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          value = cursor.value;
          cursor.continue();
        } else {
          resolve(value);
        }
      };
      req.onerror = () => reject(req.error);
    }
  });
}

// ── E2EE push payload decryption (X25519 + HKDF + AES-GCM) ─────────────────
async function decryptPushPayload(encrypted, userId) {
  const cryptoKey = await getPushIdentityKey(userId);
  if (!cryptoKey) throw new Error('No push identity key available');

  const shared = await deriveSharedSecret(cryptoKey, encrypted.ephPub);
  const saltBytes = encrypted.salt ? base64ToUint8Array(encrypted.salt) : new Uint8Array(32);
  const keyBytes = await hkdf(shared, saltBytes, 'SylvaCrypt-Push-v1', 32);
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const iv = base64ToUint8Array(encrypted.iv);
  const ciphertext = base64ToUint8Array(encrypted.ciphertext);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  const text = new TextDecoder().decode(plain);
  return JSON.parse(text);
}

async function deriveSharedSecret(privKey, publicKeyBase64) {
  const publicKey = base64ToUint8Array(publicKeyBase64);
  if (!crypto.subtle?.deriveBits) throw new Error('Web Crypto not available in service worker');

  const pubKey = await crypto.subtle.importKey('raw', publicKey, { name: 'X25519' }, false, []);
  const derived = await crypto.subtle.deriveBits(
    { name: 'X25519', public: pubKey },
    privKey,
    256
  );
  return new Uint8Array(derived);
}

async function hkdf(ikm, salt, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const derived = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode(info) },
    key,
    length * 8
  );
  return new Uint8Array(derived);
}

function base64ToUint8Array(input) {
  const binary = atob(input.replace(/\s/g, ''));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
