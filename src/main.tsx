import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { AppWrapper } from "./components/common/PageMeta.tsx";

// Service worker lifecycle management
// Step 1: Unregister any stale/third-party SWs (e.g. previously installed
//         Progressier SW) before registering our own.  This runs on every
//         page load so migrating users get cleaned up automatically.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    // Purge every SW whose script URL is not our own /sw.js
    const registrations = await navigator.serviceWorker.getRegistrations();
    for (const reg of registrations) {
      const scriptURL = reg.active?.scriptURL ?? reg.installing?.scriptURL ?? reg.waiting?.scriptURL ?? '';
      if (!scriptURL.endsWith('/sw.js')) {
        await reg.unregister();
        console.info('[SW] Unregistered stale service worker:', scriptURL);
      }
    }

    // Step 2: Register our own minimal, no-cache SW
    navigator.serviceWorker
      .register('/sw.js')
      .catch((err) => console.warn('[SW] Registration failed:', err));
  });
}

createRoot(document.getElementById("root")!).render(
  <AppWrapper>
    <App />
  </AppWrapper>
);
