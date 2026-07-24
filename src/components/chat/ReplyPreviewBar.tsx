import { X, Reply } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ReplyTo } from '@/types/types';

interface ReplyPreviewBarProps {
  replyTo: ReplyTo;
  onCancel: () => void;
}

export function ReplyPreviewBar({ replyTo, onCancel }: ReplyPreviewBarProps) {
  const snippet = replyTo.snippet?.trim() || (replyTo.imageUrl ? '📷 Image' : '');

  return (
    <div className="flex items-center gap-2 px-3 py-2 border-t border-border bg-muted/50 rounded-t-md">
      <Reply className="shrink-0 w-4 h-4 text-primary" />
      <div className="flex-1 min-w-0 border-l-2 border-primary pl-2">
        <p className="text-xs font-semibold text-primary truncate">
          @{replyTo.senderUsername}
        </p>
        <div className="flex items-center gap-1.5 mt-0.5">
          {replyTo.imageUrl && (
            <img
              src={replyTo.imageUrl}
              alt="reply thumbnail"
              className="w-7 h-7 rounded object-cover shrink-0"
            />
          )}
          {snippet && (
            <p className="text-xs text-muted-foreground truncate">{snippet}</p>
          )}
        </div>
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="shrink-0 h-6 w-6 text-muted-foreground hover:text-foreground"
        onClick={onCancel}
        aria-label="Cancel reply"
      >
        <X className="w-3.5 h-3.5" />
      </Button>
    </div>
  );
}
