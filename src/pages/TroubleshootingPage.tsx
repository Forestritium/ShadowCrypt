import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft, RefreshCw, Bell, ShieldCheck, UserPlus,
  MessageSquare, Smartphone, AlertTriangle, Trash2,
  Lock, Moon, Sun,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';

interface TroubleshootingItem {
  id: string;
  icon: React.ReactNode;
  title: string;
  description: string;
  steps: string[];
}

const items: TroubleshootingItem[] = [
  {
    id: 'blank-screen',
    icon: <RefreshCw className="w-4 h-4" />,
    title: 'Blank or frozen screen',
    description: 'If SylvaCrypt loads but shows nothing, your browser may be stuck on stale assets.',
    steps: [
      'Close all SylvaCrypt tabs and reopen the app.',
      'Clear the browser cache for this site and reload.',
      'Make sure cookies / local storage are enabled for this domain.',
      'If the issue persists, use "Clear local data & reload" below.',
    ],
  },
  {
    id: 'notifications',
    icon: <Bell className="w-4 h-4" />,
    title: 'Push notifications not arriving',
    description: 'Push delivery depends on your browser and OS permissions.',
    steps: [
      'Open Settings → Notifications and toggle Push Notifications on.',
      'Allow browser permission when prompted.',
      'On iOS, add SylvaCrypt to your Home Screen so the PWA can receive pushes.',
      'On Android, make sure battery optimization is disabled for your browser.',
    ],
  },
  {
    id: 'contacts',
    icon: <UserPlus className="w-4 h-4" />,
    title: 'Contact request not received',
    description: 'When someone adds you, the request appears in the conversation list.',
    steps: [
      'Ask the sender to confirm your exact username.',
      'Make sure they are scanning your current QR code (codes rotate automatically).',
      'Pull down the conversation list or reopen the app to refresh requests.',
      'Check that neither of you has blocked the other.',
    ],
  },
  {
    id: 'messages',
    icon: <MessageSquare className="w-4 h-4" />,
    title: 'Messages fail to send or decrypt',
    description: 'This usually means a session key could not be established.',
    steps: [
      'Verify both users have accepted the contact request.',
      'Compare safety numbers in the Verify screen to confirm no key mismatch.',
      'If a key-change alert appears, verify the new key with your contact.',
      'Try sending the message again; the Double Ratchet session will recover.',
    ],
  },
  {
    id: 'devices',
    icon: <Smartphone className="w-4 h-4" />,
    title: 'Linked device not syncing',
    description: 'New devices must be approved by a primary device before they can decrypt messages.',
    steps: [
      'On the new device, choose "Add a linked device" from Settings → Linked Devices.',
      'Approve the pending device on your primary device.',
      'Wait a few seconds for the encrypted identity key to sync.',
      'Do not clear the primary device until at least one backup has completed.',
    ],
  },
  {
    id: 'theme',
    icon: <Moon className="w-4 h-4" />,
    title: 'Theme looks wrong',
    description: 'SylvaCrypt supports Light, Dark, Mint, and Olive Dusk themes.',
    steps: [
      'Open Settings → Themes and reselect your preferred theme.',
      'If the app is unreadable, switch to Light or Dark first.',
      'Reload the page after changing themes on some mobile browsers.',
    ],
  },
  {
    id: 'vault',
    icon: <Lock className="w-4 h-4" />,
    title: 'Forgot vault password or recovery phrase',
    description: 'Your vault key is never sent to our servers, so it cannot be reset remotely.',
    steps: [
      'Try your recovery phrase in the exact order it was written.',
      'Check any password manager or secure notes you may have saved it in.',
      'If you cannot recover it, you must clear local data and create a new account.',
    ],
  },
  {
    id: 'safety',
    icon: <ShieldCheck className="w-4 h-4" />,
    title: 'Safety number mismatch',
    description: 'A mismatch means the displayed public key does not match what was previously trusted.',
    steps: [
      'Compare safety numbers in person or over a trusted call.',
      'If the numbers do not match, someone may be impersonating your contact.',
      'Do not send sensitive messages until the mismatch is resolved.',
    ],
  },
];

export default function TroubleshootingPage() {
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);

  const toggle = (id: string) => {
    setExpanded(prev => (prev === id ? null : id));
  };

  const handleClearLocalData = async () => {
    if (!window.confirm('This will remove all local SylvaCrypt data from this browser and reload the page. Your account and contacts on the server will not be affected, but you will need to sign in again. Continue?')) {
      return;
    }
    setClearing(true);
    try {
      // Clear all localStorage keys used by SylvaCrypt
      const prefixes = ['sc_', 'sylvacrypt_', 'vaultKey', 'identityKey', 'deviceId'];
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (key && prefixes.some(p => key.startsWith(p))) {
          localStorage.removeItem(key);
        }
      }
      // Best-effort IndexedDB wipe for the two stores used by the app
      await Promise.all(
        ['sylvacrypt-db', 'vault-store'].map(name =>
          new Promise<void>((resolve) => {
            const req = indexedDB.deleteDatabase(name);
            req.onsuccess = () => resolve();
            req.onerror = () => resolve();
            req.onblocked = () => resolve();
          })
        )
      );
      toast.success('Local data cleared');
      window.location.href = '/';
    } catch {
      toast.error('Could not clear all local data');
      setClearing(false);
    }
  };

  return (
    <div className="flex flex-col min-h-screen bg-background text-foreground">
      <header className="flex items-center gap-4 p-4 border-b border-border bg-card">
        <Button variant="ghost" size="icon" onClick={() => navigate(-1)} className="rounded-full shrink-0">
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <h1 className="text-xl font-semibold">Troubleshooting</h1>
      </header>

      <main className="flex-1 p-4 max-w-lg mx-auto w-full space-y-6">
        <p className="text-sm text-muted-foreground">
          Common problems and quick fixes. If something is not listed here, make sure you are using the latest version of your browser.
        </p>

        <section className="space-y-3">
          {items.map(item => (
            <div
              key={item.id}
              className="bg-card border border-border rounded-2xl overflow-hidden"
            >
              <button
                type="button"
                onClick={() => toggle(item.id)}
                className="w-full flex items-center gap-3 px-4 py-3.5 text-left hover:bg-muted/50 transition-colors"
              >
                <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0 text-primary">
                  {item.icon}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground">{item.title}</p>
                  <p className="text-xs text-muted-foreground text-pretty">{item.description}</p>
                </div>
                <div className="shrink-0">
                  {expanded === item.id ? <Sun className="w-4 h-4 text-muted-foreground" /> : <Moon className="w-4 h-4 text-muted-foreground" />}
                </div>
              </button>
              {expanded === item.id && (
                <div className="px-4 pb-4 pt-0">
                  <ol className="space-y-2 pl-11 list-decimal">
                    {item.steps.map((step, idx) => (
                      <li key={idx} className="text-sm text-muted-foreground text-pretty">
                        {step}
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </div>
          ))}
        </section>

        <section className="bg-card border border-border rounded-2xl p-4 space-y-3">
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-lg bg-destructive/10 flex items-center justify-center shrink-0">
              <AlertTriangle className="w-4 h-4 text-destructive" />
            </div>
            <div>
              <p className="text-sm font-medium text-foreground">Still stuck?</p>
              <p className="text-xs text-muted-foreground text-pretty">
                Clear all local data and reload. This will log you out, but your server-side account and accepted contacts will remain.
              </p>
            </div>
          </div>
          <Button
            variant="outline"
            className="w-full gap-2 border-destructive/30 text-destructive hover:bg-destructive/10"
            onClick={handleClearLocalData}
            disabled={clearing}
          >
            {clearing ? (
              <RefreshCw className="w-4 h-4 animate-spin" />
            ) : (
              <Trash2 className="w-4 h-4" />
            )}
            {clearing ? 'Clearing…' : 'Clear local data & reload'}
          </Button>
        </section>
      </main>
    </div>
  );
}
