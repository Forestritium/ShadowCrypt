import type { ReplyTo } from '@/types/types';

interface QuotedMessageProps {
  replyTo: ReplyTo;
  onScrollTo?: (id: string) => void;
}

export function QuotedMessage({ replyTo, onScrollTo }: QuotedMessageProps) {
  const snippet = replyTo.snippet?.trim() || (replyTo.imageUrl ? '📷 Image' : '');

  const handleClick = () => {
    if (onScrollTo) onScrollTo(replyTo.id);
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      className="w-full text-left mb-1.5 border-l-2 border-primary/60 pl-2 pr-1 py-0.5 rounded-sm bg-black/10 dark:bg-white/10 hover:bg-black/15 dark:hover:bg-white/15 transition-colors"
      aria-label="Scroll to original message"
    >
      <p className="text-[11px] font-semibold text-primary/90 truncate leading-tight">
        @{replyTo.senderUsername}
      </p>
      <div className="flex items-center gap-1.5 mt-0.5">
        {replyTo.imageUrl && (
          <img
            src={replyTo.imageUrl}
            alt="quoted image"
            className="w-6 h-6 rounded object-cover shrink-0"
          />
        )}
        {snippet && (
          <p className="text-[11px] text-foreground/60 truncate leading-tight">{snippet}</p>
        )}
      </div>
    </button>
  );
}
