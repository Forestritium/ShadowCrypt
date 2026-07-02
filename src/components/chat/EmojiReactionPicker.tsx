/**
 * EmojiReactionPicker — a compact emoji grid shown in a popover when the
 * user clicks the "react" button on a message.
 */

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Smile } from 'lucide-react';
import { REACTION_EMOJIS } from './ReactionBar';

interface EmojiReactionPickerProps {
  onSelect: (emoji: string) => void;
  disabled?: boolean;
}

export function EmojiReactionPicker({ onSelect, disabled }: EmojiReactionPickerProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className="shrink-0 self-center w-7 h-7 flex items-center justify-center rounded-full text-muted-foreground hover:text-primary hover:bg-muted transition-all duration-150 disabled:pointer-events-none disabled:opacity-40"
          aria-label="Add reaction"
        >
          <Smile className="w-3.5 h-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="center"
        className="w-auto p-1.5 flex gap-0.5"
        sideOffset={6}
      >
        {REACTION_EMOJIS.map(emoji => (
          <button
            key={emoji}
            type="button"
            onClick={() => onSelect(emoji)}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-base hover:bg-muted transition-colors"
            aria-label={emoji}
          >
            {emoji}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
