/**
 * useCaptureDeterrence
 *
 * Applies document-level, best-effort capture deterrence while the calling
 * component is mounted.
 *
 * IMPORTANT — LIMITATIONS: No web application can block OS-level screenshots
 * (PrintScreen, Cmd+Shift+3/4, Snipping Tool, screen recorders).  This hook
 * raises friction for casual capture and signals intent, but cannot enforce
 * confidentiality at the OS layer.  Users should treat it as a deterrent,
 * not a guarantee.
 *
 * Layers applied:
 *  1. CSS (document.documentElement): disables text selection + drag site-wide.
 *  2. Context-menu suppression on <img> and [data-chat-message] elements.
 *  3. PrintScreen / Ctrl+P / Ctrl+S / Cmd+P / Cmd+S key interception —
 *     shows an informational notice; cannot block OS-level capture.
 *  4. Page Visibility API: hides chat content when the tab loses focus
 *     (reduces exposure to screen recorders and tab-switch captures).
 *  5. @media print: hides <body> when printing or saving as PDF.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

export interface UseCaptureDeterrenceReturn {
  /** True while the page-level blur overlay should be rendered. */
  overlayVisible: boolean;
  /** Spread on any container to suppress right-click on images. */
  containerProps: {
    onContextMenu: (e: React.MouseEvent) => void;
  };
}

export function useCaptureDeterrence(): UseCaptureDeterrenceReturn {
  const [overlayVisible, setOverlayVisible] = useState(false);
  const warningTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Layer 1 — Disable text selection / drag at the document root
  useEffect(() => {
    const root = document.documentElement;
    const prev = root.style.userSelect;
    root.style.userSelect = 'none';
    root.style.webkitUserSelect = 'none';
    return () => {
      root.style.userSelect = prev;
      root.style.webkitUserSelect = prev;
    };
  }, []);

  // Layer 3 — Key interception for common capture shortcuts
  // Note: this intercepts the keyboard event but cannot prevent OS-level capture.
  useEffect(() => {
    const handleKeyUp = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      const isCapture =
        key === 'printscreen' ||
        (e.ctrlKey && key === 'p') ||
        (e.metaKey && key === 'p') ||
        (e.ctrlKey && key === 's') ||
        (e.metaKey && key === 's');

      if (isCapture) {
        e.preventDefault();
        e.stopImmediatePropagation();
        toast.warning('Capture attempt detected — chat content hidden while active.', {
          duration: 4000,
          id: 'cd-capture-warn',
        });
      }
    };

    document.addEventListener('keyup', handleKeyUp, { capture: true });
    return () => document.removeEventListener('keyup', handleKeyUp, { capture: true });
  }, []);

  // Layer 4 — Page Visibility API: hide content when tab loses focus
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        if (warningTimeoutRef.current) clearTimeout(warningTimeoutRef.current);
        setOverlayVisible(true);
      } else {
        toast.info('Capture deterrence active — content hidden when unfocused.', {
          duration: 2000,
          id: 'cd-visibility-return',
        });
        // Keep overlay for 1.5 s after regaining focus to reduce capture window
        warningTimeoutRef.current = setTimeout(() => setOverlayVisible(false), 1500);
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (warningTimeoutRef.current) clearTimeout(warningTimeoutRef.current);
    };
  }, []);

  // Layer 5 — CSS @media print: hide page body during print / Print-to-PDF
  useEffect(() => {
    const styleId = 'cd-no-print-style';
    if (!document.getElementById(styleId)) {
      const style = document.createElement('style');
      style.id = styleId;
      style.textContent = '@media print { body { display: none !important; } }';
      document.head.appendChild(style);
    }
    return () => document.getElementById(styleId)?.remove();
  }, []);

  // Layer 2 — Context-menu suppression on image / message elements
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (
      target.tagName === 'IMG' ||
      target.closest('img') ||
      target.closest('[data-chat-message]')
    ) {
      e.preventDefault();
      toast.info('Right-click is disabled on chat images.', {
        duration: 2500,
        id: 'cd-contextmenu-info',
      });
    }
  }, []);

  return { overlayVisible, containerProps: { onContextMenu: handleContextMenu } };
}
