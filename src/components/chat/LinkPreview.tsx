/**
 * LinkPreview — opt-in link card.
 *
 * Privacy model: NO network requests are fired automatically.
 * The card is built entirely from the URL structure (hostname + path) —
 * zero outbound traffic until the user explicitly clicks "Show preview",
 * at which point they are opening the link in a new tab, which is no
 * different from clicking the URL itself.
 *
 * This avoids the passive-observer leakage problem where opening a
 * conversation would silently fire N requests to N external domains for
 * every link in the history, revealing which domains appear in messages
 * to anyone watching the network.
 */
import { useState } from 'react';
import { ExternalLink, Globe, Eye } from 'lucide-react';

interface LinkPreviewProps {
  url: string;
}

function parseMeta(url: string): { title: string; description: string; hostname: string } | null {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.replace(/^www\./, '');
    let description = '';
    try {
      description = parsed.pathname.length > 1 ? decodeURIComponent(parsed.pathname) : '';
    } catch { description = parsed.pathname; }
    // Truncate very long paths
    if (description.length > 80) description = description.slice(0, 77) + '…';
    return { title: hostname, description, hostname };
  } catch {
    return null;
  }
}

export function LinkPreview({ url }: LinkPreviewProps) {
  const [expanded, setExpanded] = useState(true);
  const meta = parseMeta(url);
  if (!meta) return null;

  // Collapsed state: small pill prompting the user to reveal the card.
  if (!expanded) {
    return (
      <button
        onClick={e => { e.stopPropagation(); setExpanded(true); }}
        className="mt-1 inline-flex items-center gap-1.5 text-xs text-primary/70 hover:text-primary transition-colors rounded-lg px-2 py-1 hover:bg-primary/8 border border-primary/20"
        title={`Show link preview for ${meta.hostname}`}
      >
        <Eye className="w-3 h-3 shrink-0" />
        <span className="truncate max-w-[160px]">{meta.hostname}</span>
      </button>
    );
  }

  // Expanded state: full card, opens link on click.
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="mt-1.5 flex items-start gap-2.5 rounded-xl border border-border bg-muted/50 px-3 py-2.5 hover:bg-muted transition-colors group max-w-xs"
      onClick={e => e.stopPropagation()}
    >
      <Globe className="w-4 h-4 mt-0.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold text-foreground truncate group-hover:text-primary transition-colors">
          {meta.title}
        </p>
        {meta.description && (
          <p className="text-xs text-muted-foreground truncate mt-0.5">{meta.description}</p>
        )}
        <p className="text-xs text-primary/70 truncate mt-0.5 flex items-center gap-1">
          {meta.hostname}
          <ExternalLink className="w-2.5 h-2.5 inline" />
        </p>
      </div>
    </a>
  );
}

/** Extract the first URL from a plain-text message. */
export function extractFirstUrl(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s<>"']+/);
  return match ? match[0] : null;
}
