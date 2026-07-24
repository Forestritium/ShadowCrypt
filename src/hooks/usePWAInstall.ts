/**
 * usePWAInstall — captures the browser's beforeinstallprompt event so the app
 * can show a custom "Install SylvaCrypt" banner instead of the default mini-
 * infobar.  Works on Chromium-based browsers; silently no-ops on others.
 */

import { useEffect, useState } from 'react';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function usePWAInstall() {
  const [promptEvent, setPromptEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = useState(false);
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem('sc_pwa_dismissed') === '1',
  );

  useEffect(() => {
    // Already running as a standalone PWA
    if (window.matchMedia('(display-mode: standalone)').matches) {
      setIsInstalled(true);
      return;
    }

    const handler = (e: Event) => {
      // Only capture the event (and suppress the browser's default mini-infobar)
      // when we actually intend to show our custom banner.  If the user already
      // dismissed the banner we skip preventDefault so the browser can fall back
      // to showing its own install prompt — otherwise it fires the warning
      // "beforeinstallprompt event.preventDefault() called. The page must call
      // beforeinstallprompt event.prompt() to show the banner."
      const alreadyDismissed = localStorage.getItem('sc_pwa_dismissed') === '1';
      if (!alreadyDismissed) {
        e.preventDefault();
      }
      setPromptEvent(e as BeforeInstallPromptEvent);
    };

    window.addEventListener('beforeinstallprompt', handler);
    window.addEventListener('appinstalled', () => setIsInstalled(true));

    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  const install = async () => {
    if (!promptEvent) return;
    await promptEvent.prompt();
    const { outcome } = await promptEvent.userChoice;
    if (outcome === 'accepted') setIsInstalled(true);
    setPromptEvent(null);
  };

  const dismiss = () => {
    localStorage.setItem('sc_pwa_dismissed', '1');
    setDismissed(true);
  };

  const showBanner = !!promptEvent && !isInstalled && !dismissed;

  return { showBanner, install, dismiss, isInstalled };
}
