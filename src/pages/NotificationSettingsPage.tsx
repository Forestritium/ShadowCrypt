import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, BellOff, BellRing, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/contexts/AuthContext';
import { saveContact } from '@/lib/localStore';
import { getContactsFromDB } from '@/lib/dbStore';
import { supabase } from '@/db/supabase';
import type { Contact } from '@/types/types';
import { toast } from 'sonner';

export default function NotificationSettingsPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [subscribed, setSubscribed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(false);

  useEffect(() => {
    if (!user) return;
    getContactsFromDB(user.id).then(setContacts);
    checkSubscription();
  }, [user]);

  type PushCapableRegistration = ServiceWorkerRegistration & {
    pushManager: PushManager;
  };

  const getRegistration = async (): Promise<PushCapableRegistration | null> => {
    if (!('serviceWorker' in navigator)) return null;
    return navigator.serviceWorker.ready as Promise<PushCapableRegistration>;
  };

  const checkSubscription = async () => {
    if (!('PushManager' in window) || !('serviceWorker' in navigator)) {
      setLoading(false);
      return;
    }
    try {
      const registration = await getRegistration();
      const existing = await registration?.pushManager.getSubscription();
      setSubscribed(!!existing);
    } catch {
      setSubscribed(false);
    } finally {
      setLoading(false);
    }
  };

  const removeDbSubscription = async (subscription: PushSubscription) => {
    const { error } = await supabase.from('push_subscriptions').delete().eq('endpoint', subscription.endpoint);
    if (error) throw new Error(error.message);
  };

  const saveDbSubscription = async (subscription: PushSubscription) => {
    if (!user) return;
    const sub = subscription.toJSON() as { endpoint: string; keys?: { p256dh: string; auth: string } };
    if (!sub.keys?.p256dh || !sub.keys?.auth) return;
    const deviceId = localStorage.getItem('deviceId') ?? null;
    const { error } = await supabase.from('push_subscriptions').upsert({
      user_id: user.id,
      device_id: deviceId,
      endpoint: sub.endpoint,
      p256dh: sub.keys.p256dh,
      auth: sub.keys.auth,
    }, { onConflict: 'endpoint' });
    if (error) throw new Error(`Database error: ${error.message}`);
  };

  const handleToggleGlobalPush = async () => {
    if (!('PushManager' in window) || !('serviceWorker' in navigator)) {
      toast.error('Push notifications are not supported in this browser.');
      return;
    }
    if (!user) {
      toast.error('You must be signed in to enable push notifications.');
      return;
    }

    setToggling(true);
    try {
      const registration = await getRegistration();
      if (!registration) {
        toast.error('Service worker is not ready. Try reloading the app.');
        return;
      }

      const existing = await registration.pushManager.getSubscription();

      if (existing) {
        await existing.unsubscribe();
        await removeDbSubscription(existing);
        setSubscribed(false);
        toast.success('Push notifications turned off.');
        return;
      }

      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        toast.error('Notification permission was denied.');
        return;
      }

      let publicKey: string | null = null;
      try {
        const { data, error } = await supabase.functions.invoke('push-vapid-key');
        if (error || !data?.publicKey) {
          toast.error('Push notifications are not configured on this server.');
          return;
        }
        publicKey = data.publicKey;
      } catch {
        toast.error('Could not retrieve push configuration.');
        return;
      }

      if (!publicKey) {
        toast.error('Could not retrieve push configuration.');
        return;
      }
      const newSub = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
      });

      await saveDbSubscription(newSub);
      setSubscribed(true);
      toast.success('Push notifications enabled.');
    } catch (err) {
      console.error('[SylvaCrypt] push toggle error:', err);
      if (err instanceof Error) {
        toast.error(err.message);
      } else {
        toast.error('Failed to update push notification settings.');
      }
    } finally {
      setToggling(false);
    }
  };

  const handleToggleContactPush = async (contact: Contact) => {
    if (!user) return;
    const current = contact.notificationsEnabled !== false; // default true
    const updated = { ...contact, notificationsEnabled: !current };
    setContacts(prev => prev.map(c => c.id === contact.id ? updated : c));
    await saveContact(updated);
  };

  function urlBase64ToUint8Array(base64String: string): Uint8Array {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    return Uint8Array.from(rawData.split('').map(c => c.charCodeAt(0)));
  }

  return (
    <div className="flex flex-col min-h-screen bg-background text-foreground">
      <header className="flex items-center gap-4 p-4 border-b border-border bg-card">
        <Button variant="ghost" size="icon" onClick={() => navigate(-1)} className="rounded-full shrink-0">
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <h1 className="text-xl font-semibold">Notifications</h1>
      </header>

      <main className="flex-1 p-4 max-w-lg mx-auto w-full space-y-8">
        <section>
          <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 px-1">Global Settings</h2>
          <div className="bg-card border border-border rounded-2xl overflow-hidden divide-y divide-border">
            <div className="p-4 flex items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground flex items-center gap-2">
                  {subscribed ? <BellRing className="w-3.5 h-3.5 text-primary" /> : <BellOff className="w-3.5 h-3.5 text-muted-foreground" />}
                  Push Notifications
                </p>
                <p className="text-xs text-muted-foreground text-pretty">
                  {subscribed
                    ? 'You will receive alerts for missed calls and messages.'
                    : 'Receive alerts for missed calls and messages even when the app is closed.'}
                </p>
              </div>
              <button
                onClick={handleToggleGlobalPush}
                disabled={loading || toggling}
                className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
                  subscribed ? 'bg-primary' : 'bg-muted-foreground/30'
                } ${(loading || toggling) ? 'opacity-60 cursor-not-allowed' : ''}`}
                aria-label={subscribed ? 'Disable push notifications' : 'Enable push notifications'}
              >
                <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  subscribed ? 'translate-x-6' : 'translate-x-1'
                }`} />
              </button>
            </div>
          </div>
          {loading && (
            <div className="flex items-center gap-2 mt-3 text-xs text-muted-foreground">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Checking push notification status…
            </div>
          )}
          {!('PushManager' in window) && (
            <div className="mt-3 text-xs text-destructive bg-destructive/10 rounded-lg p-3">
              Your browser or device does not support web push notifications. For the best experience, install SylvaCrypt as a PWA on a supported browser.
            </div>
          )}
        </section>

        {subscribed && (
          <section>
            <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 px-1">Per-Contact Settings</h2>
            <div className="bg-card border border-border rounded-2xl overflow-hidden divide-y divide-border">
              {contacts.length === 0 ? (
                <div className="p-4 text-center text-sm text-muted-foreground">No contacts yet</div>
              ) : (
                contacts.map(contact => {
                  const enabled = contact.notificationsEnabled !== false;
                  return (
                    <div key={contact.id} className="p-4 flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center text-muted-foreground font-semibold">
                          {contact.username.charAt(0).toUpperCase()}
                        </div>
                        <div>
                          <p className="text-sm font-medium text-foreground">@{contact.username}</p>
                          <p className="text-xs text-muted-foreground">Vault message alerts</p>
                        </div>
                      </div>
                      <button
                        onClick={() => handleToggleContactPush(contact)}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                          enabled ? 'bg-primary' : 'bg-muted-foreground/30'
                        }`}
                      >
                        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                          enabled ? 'translate-x-6' : 'translate-x-1'
                        }`} />
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}