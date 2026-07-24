/**
 * useKeyboardShortcuts — registers global keyboard shortcuts for desktop users.
 *
 * Shortcuts:
 *   Ctrl+K / Cmd+K          → focus the contact/conversation search input
 *   Ctrl+Alt+N / Cmd+Alt+N  → open the Add Contact dialog
 *   Ctrl+Shift+D / Cmd+Shift+D → toggle light/dark theme
 *   Ctrl+Shift+M / Cmd+Shift+M → focus the active chat message input
 *   Ctrl+Comma / Cmd+Comma  → open Settings
 *   Escape                  → close the currently focused dialog/sheet (native browser behaviour
 *                           already handles Radix modals, but we expose a custom callback too)
 */

import { useEffect } from 'react';

export interface KeyboardShortcutHandlers {
  onSearch?: () => void;
  onNewContact?: () => void;
  onToggleTheme?: () => void;
  onFocusMessageInput?: () => void;
  onOpenSettings?: () => void;
  onEscape?: () => void;
}

export function useKeyboardShortcuts(handlers: KeyboardShortcutHandlers): void {
  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;

      if (mod && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
        e.preventDefault();
        handlers.onToggleTheme?.();
        return;
      }
      if (mod && e.shiftKey && (e.key === 'M' || e.key === 'm')) {
        e.preventDefault();
        handlers.onFocusMessageInput?.();
        return;
      }
      if (mod && e.key === ',' && !e.shiftKey) {
        e.preventDefault();
        handlers.onOpenSettings?.();
        return;
      }
      if (mod && e.key === 'k') {
        e.preventDefault();
        handlers.onSearch?.();
        return;
      }
      if (mod && e.altKey && (e.key === 'n' || e.key === 'N')) {
        e.preventDefault();
        handlers.onNewContact?.();
        return;
      }
      if (e.key === 'Escape') {
        handlers.onEscape?.();
      }
    };

    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, [handlers]);
}
