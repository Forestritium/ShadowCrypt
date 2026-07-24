/**
 * ReactionBar — renders aggregated emoji reactions below a message bubble.
 * Shows counts per emoji; clicking a reaction you own toggles it off,
 * clicking one you don't own adds it.
 */

import type { MessageReaction } from '@/types/types';
import { REACTION_EMOJIS } from './EmojiReactionPicker';

interface ReactionBarProps {
  reactions: MessageReaction[];
  currentUserId: string;
  onToggle: (emoji: string, alreadyReacted: boolean) => void;
}

export function ReactionBar({ reactions, currentUserId, onToggle }: ReactionBarProps) {
  if (reactions.length === 0) return null;

  // Aggregate: emoji → { count, isMine }
  const agg = new Map<string, { count: number; isMine: boolean }>();
  for (const r of reactions) {
    const prev = agg.get(r.emoji) ?? { count: 0, isMine: false };
    agg.set(r.emoji, {
      count: prev.count + 1,
      isMine: prev.isMine || r.senderId === currentUserId,
    });
  }

  // Preserve stable order: known emojis first, then any others alphabetically
  const ordered = REACTION_EMOJIS.filter(e => agg.has(e))
    .concat([...agg.keys()].filter(e => !REACTION_EMOJIS.includes(e)).sort());

  return (
    <div className="flex flex-wrap gap-1 mt-1">
      {ordered.map(emoji => {
        const { count, isMine } = agg.get(emoji)!;
        return (
          <button
            key={emoji}
            type="button"
            onClick={() => onToggle(emoji, isMine)}
            className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-xs border transition-colors select-none ${
              isMine
                ? 'bg-primary/15 border-primary/40 text-foreground'
                : 'bg-muted/70 border-border text-foreground hover:bg-muted'
            }`}
            aria-label={`${emoji} ${count}${isMine ? ' (click to remove)' : ' (click to react)'}`}
            title={`${emoji} · ${count}${isMine ? ' · Click to remove' : ''}`}
          >
            <span>{emoji}</span>
            <span className="font-medium tabular-nums">{count}</span>
          </button>
        );
      })}
    </div>
  );
}


