/**
 * FileAttachmentButton — a small icon button that opens a native file picker.
 * Accepts any file type (images handled by the existing image button).
 * Shows a spinner while a file is uploading.
 */

import { useRef } from 'react';
import { Paperclip } from 'lucide-react';
import { toast } from 'sonner';

/**
 * Blocked file extensions — executable and potentially harmful formats.
 * Updated to a comprehensive list covering all major platforms.
 */
const BLOCKED_EXTENSIONS = new Set([
  // Windows executables & scripts
  'exe', 'bat', 'cmd', 'com', 'pif', 'scr', 'vbs', 'vbe', 'wsf', 'wsc', 'wsh',
  'ps1', 'ps2', 'msi', 'msp', 'mst', 'reg', 'hta', 'cpl', 'dll', 'sys', 'drv',
  'lnk', 'inf', 'gadget', 'application', 'xbap', 'xnk',
  // macOS executables
  'dmg', 'pkg', 'app', 'command', 'osx',
  // Linux / Unix executables
  'sh', 'bash', 'run', 'bin', 'deb', 'rpm', 'appimage',
  // Java / cross-platform
  'jar', 'jnlp',
  // Android / iOS
  'apk', 'ipa', 'xapk',
  // Archive-as-dropper formats
  'iso', 'img',
  // Office macros
  'xlsm', 'xlsb', 'xltm', 'docm', 'dotm', 'pptm', 'potm',
]);

interface FileAttachmentButtonProps {
  onFileSelected: (file: File) => void;
  disabled?: boolean;
  uploading?: boolean;
  /** Remaining bytes allowed today */
  remainingBytes: number;
}

export function FileAttachmentButton({
  onFileSelected,
  disabled,
  uploading,
  remainingBytes,
}: FileAttachmentButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    // Block dangerous/executable file extensions
    const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
    if (BLOCKED_EXTENSIONS.has(ext)) {
      toast.error(`File type .${ext} is not allowed for security reasons.`);
      return;
    }

    if (file.size > remainingBytes) {
      const remainingMBStr = (remainingBytes / (1024 * 1024)).toFixed(1);
      const fileMBStr = (file.size / (1024 * 1024)).toFixed(1);
      toast.error(
        `File too large for today's remaining quota. ` +
        `File is ${fileMBStr} MB but only ${remainingMBStr} MB left today.`
      );
      return;
    }
    onFileSelected(file);
  };

  const remainingMB = (remainingBytes / (1024 * 1024)).toFixed(0);

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        className="sr-only"
        onChange={handleChange}
        aria-label="Attach file"
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={disabled || uploading || remainingBytes <= 0}
        className="w-10 h-10 rounded-xl flex items-center justify-center text-muted-foreground hover:text-primary hover:bg-muted transition-colors shrink-0 disabled:opacity-40"
        aria-label="Attach file"
        title={
          remainingBytes <= 0
            ? 'Daily file limit reached (60 MB/day)'
            : `Attach file (${remainingMB} MB remaining today)`
        }
      >
        {uploading ? (
          <span className="w-4 h-4 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
        ) : (
          <Paperclip className="w-5 h-5" />
        )}
      </button>
    </>
  );
}
