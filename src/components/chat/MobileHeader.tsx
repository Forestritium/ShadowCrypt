import { Menu, Bell } from 'lucide-react';
import logoUrl from '@/assets/logo.svg';

interface MobileHeaderProps {
  username: string;
  pendingCount?: number;
  unreadCount?: number;
  onMenuOpen: () => void;
  onLogout: () => void;
}

export function MobileHeader({ username, pendingCount = 0, unreadCount = 0, onMenuOpen }: MobileHeaderProps) {
  const totalBadge = pendingCount + unreadCount;
  return (
    <header className="shrink-0 md:hidden bg-card border-b border-border flex items-center justify-between px-4 h-14">
      {/* Hamburger */}
      <button
        onClick={onMenuOpen}
        className="relative w-9 h-9 flex items-center justify-center rounded-lg text-foreground hover:bg-muted transition-colors"
        aria-label="Open menu"
      >
        <Menu className="w-5 h-5" />
        {totalBadge > 0 && (
          <span className={`absolute -top-0.5 -right-0.5 w-4 h-4 ${unreadCount > 0 ? 'bg-destructive' : 'bg-amber-500'} text-white text-xs font-bold rounded-full flex items-center justify-center leading-none`}>
            {totalBadge > 9 ? '9+' : totalBadge}
          </span>
        )}
      </button>

      {/* Brand */}
      <div className="flex items-center gap-2">
        <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center overflow-hidden">
          <img src={logoUrl} alt="SylvaCrypt" className="w-5 h-5 object-contain" />
        </div>
        <span className="text-sm font-semibold text-foreground">SylvaCrypt</span>
      </div>

      {/* Username */}
      <div className="flex items-center gap-1 text-xs text-muted-foreground min-w-0 max-w-[90px]">
        {pendingCount > 0 && <Bell className="w-3.5 h-3.5 text-amber-500 shrink-0" />}
        <span className="truncate"><span className="text-primary/70">@</span>{username}</span>
      </div>
    </header>
  );
}
