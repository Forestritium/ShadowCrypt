/**
 * TypingIndicator — animated "X is typing…" bubble shown at the bottom of the
 * chat pane while a remote contact is composing a message.
 */
import { useEffect, useState } from 'react';

interface TypingIndicatorProps {
  name: string;
  visible: boolean;
}

export function TypingIndicator({ name, visible }: TypingIndicatorProps) {
  const [show, setShow] = useState(false);

  // Small delay so rapid appear/disappear doesn't flicker
  useEffect(() => {
    if (visible) {
      setShow(true);
    } else {
      const t = setTimeout(() => setShow(false), 300);
      return () => clearTimeout(t);
    }
  }, [visible]);

  if (!show) return null;

  return (
    <div
      className="flex items-center gap-2 px-4 py-1.5 animate-in fade-in slide-in-from-bottom-1 duration-200"
      aria-live="polite"
      aria-label={`${name} is typing`}
    >
      {/* Bubble */}
      <div className="flex items-center gap-1.5 bg-muted rounded-2xl rounded-bl-sm px-3 py-2 max-w-fit">
        <span className="text-xs text-muted-foreground font-medium truncate max-w-[120px]">
          {name}
        </span>
        <span className="text-xs text-muted-foreground">is typing</span>
        {/* Animated dots */}
        <span className="flex items-center gap-0.5 ml-0.5">
          {[0, 1, 2].map(i => (
            <span
              key={i}
              className="w-1.5 h-1.5 rounded-full bg-muted-foreground/60 inline-block"
              style={{
                animation: 'typing-bounce 1.2s ease-in-out infinite',
                animationDelay: `${i * 0.2}s`,
              }}
            />
          ))}
        </span>
      </div>
    </div>
  );
}
