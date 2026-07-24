/**
 * FileAttachmentBubble — renders a file attachment inside a message bubble.
 * Decrypts the file on demand (click to download) using AES-256-GCM.
 * Shows an appropriate icon for common MIME types.
 */

import { useState } from 'react';
import {
  FileText, FileImage, FileVideo, FileAudio,
  FileArchive, File, Download, Lock, Loader2,
} from 'lucide-react';
import { fetchAndDecryptChatFile } from '@/lib/relay';

interface FileAttachmentBubbleProps {
  storagePath: string;
  fileKey: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  isSelf: boolean;
}

function fileIcon(mime: string) {
  if (mime.startsWith('image/')) return <FileImage className="w-5 h-5 shrink-0" />;
  if (mime.startsWith('video/')) return <FileVideo className="w-5 h-5 shrink-0" />;
  if (mime.startsWith('audio/')) return <FileAudio className="w-5 h-5 shrink-0" />;
  if (mime.includes('pdf') || mime.includes('text') || mime.includes('document'))
    return <FileText className="w-5 h-5 shrink-0" />;
  if (mime.includes('zip') || mime.includes('archive') || mime.includes('compressed'))
    return <FileArchive className="w-5 h-5 shrink-0" />;
  return <File className="w-5 h-5 shrink-0" />;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FileAttachmentBubble({
  storagePath,
  fileKey,
  fileName,
  fileSize,
  mimeType,
  isSelf,
}: FileAttachmentBubbleProps) {
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDownload = async () => {
    if (downloading) return;
    setDownloading(true);
    setError(null);
    try {
      const objectUrl = await fetchAndDecryptChatFile(storagePath, fileKey, mimeType);
      // Create a temporary anchor and trigger download
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Revoke after a short delay to allow the download to start
      setTimeout(() => URL.revokeObjectURL(objectUrl), 3000);
    } catch (err) {
      setError('Download failed. Please try again.');
      console.error('[FileAttachmentBubble] download error:', err);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div
      className={`flex items-center gap-2.5 rounded-xl px-3 py-2.5 mb-1 cursor-pointer select-none transition-colors border ${
        isSelf
          ? 'bg-primary/10 border-primary/20 hover:bg-primary/15'
          : 'bg-muted/60 border-border hover:bg-muted'
      }`}
      onClick={handleDownload}
      role="button"
      aria-label={`Download ${fileName}`}
      tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') handleDownload(); }}
    >
      <div className={`text-primary shrink-0 ${downloading ? 'opacity-50' : ''}`}>
        {downloading ? (
          <Loader2 className="w-5 h-5 animate-spin" />
        ) : (
          fileIcon(mimeType)
        )}
      </div>

      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground truncate leading-tight">
          {fileName}
        </p>
        <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1">
          <Lock className="w-2.5 h-2.5 shrink-0" />
          {formatBytes(fileSize)} · Encrypted
        </p>
        {error && <p className="text-xs text-destructive mt-0.5">{error}</p>}
      </div>

      <div className="shrink-0 text-muted-foreground">
        <Download className="w-4 h-4" />
      </div>
    </div>
  );
}
