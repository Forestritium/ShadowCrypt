// ShadowCrypt Service Worker
// Minimal SW to satisfy PWA installability requirements.
// No caching is intentional — all message data is encrypted and stored in
// IndexedDB by the app; serving stale assets could expose outdated crypto code.

const SW_VERSION = 'v2'; // bumped to force re-activation after progressier SW removal

self.addEventListener('install', (event) => {
  // Skip waiting so the new SW activates immediately
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Claim all open clients so this SW controls them without a reload
  event.waitUntil(self.clients.claim());
});

// Pass all fetch requests through to the network — no cache interception.
// This ensures users always load the latest version of the app.
self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
