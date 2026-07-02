/**
 * FileAttachmentButton — a small icon button that opens a native file picker.
 * Accepts any file type (images handled by the existing image button).
 * Shows a spinner while a file is uploading.
 */

import { useRef } from 'react';
import { Paperclip } from 'lucide-react';
import { toast } from 'sonner';

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
