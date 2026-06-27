import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Shield } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/contexts/AuthContext';
import { autoDeleteOldMessages } from '@/lib/localStore';
import { getContactsFromDB, saveContactToDB, removeContactAndMessagesFromDB } from '@/lib/dbStore';
import { useCaptureDeterrence } from '@/hooks/use-capture-deterrence';
import {
  subscribeToRelay,
  fetchPendingRelayMessages,
  receiveAndDecryptMessage,
  getUserPublicKey,
  fetchIncomingRequests,
  fetchOutgoingRequests,
  subscribeToContactRequests,
  subscribeToOutgoingRequestUpdates,
  fetchBlockedUserIds,
  subscribeToContactRemovals,
  notifyContactRemoval,
  fetchAcceptedContacts,
  deleteContactRequestBetween,
} from '@/lib/relay';
import type { Contact, LocalMessage, ConversationPreview, RelayMessage, ContactRequest } from '@/types/types';
import { makeConversationId } from '@/lib/session';
import { computeFingerprint } from '@/lib/crypto';
import { Sidebar } from '@/components/chat/Sidebar';
import { ChatArea } from '@/components/chat/ChatArea';
import { MobileHeader } from '@/components/chat/MobileHeader';

// Request browser notification permission once
function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {/* ignore */});
  }
}

// Show an anonymous push notification (never reveals sender)
function showAnonymousNotification() {
  if ('Notification' in window && Notification.permission === 'granted') {
    // eslint-disable-next-line no-new
    new Notification('ShadowCrypt', {
      body: 'You got a notification from ShadowCrypt',
      icon: '/favicon.ico',
      tag: 'shadowcrypt-message', // deduplicate rapid-fire notifications
      silent: false,
    });
  }
}

const PP_SEEN_KEY = 'sc_pp_v2_seen';

export default function ChatPage() {
  const { user, profile, session, loading, signOut } = useAuth();
  const navigate = useNavigate();

  // Document-level capture deterrence — active for the entire chat page
  useCaptureDeterrence();

  const [contacts, setContacts] = useState<Contact[]>([]);
  const [selectedConversation, setSelectedConversation] = useState<ConversationPreview | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [desktopSidebarCollapsed, setDesktopSidebarCollapsed] = useState(false);
  const [incomingMessages, setIncomingMessages] = useState<LocalMessage[]>([]);
  const [pendingRequests, setPendingRequests] = useState<ContactRequest[]>([]);
  const [outgoingRequests, setOutgoingRequests] = useState<ContactRequest[]>([]);
  const [blockedIds, setBlockedIds] = useState<string[]>([]);
  const [ppDialogOpen, setPpDialogOpen] = useState(false);
  // Unread counts keyed by conversationId
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({});

  // Keep mutable state in refs so relay callbacks are stable and never go stale
  const selectedConvRef = useRef<ConversationPreview | null>(null);
  const blockedIdsRef = useRef<string[]>([]);
  const sessionRef = useRef(session);
  const userRef = useRef(user);

  useEffect(() => { selectedConvRef.current = selectedConversation; }, [selectedConversation]);
  useEffect(() => { blockedIdsRef.current = blockedIds; }, [blockedIds]);
  useEffect(() => { sessionRef.current = session; }, [session]);
  useEffect(() => { userRef.current = user; }, [user]);

  // Auth guard — must be in useEffect, never in render body
  useEffect(() => {
    if (loading) return;
    if (!user) { navigate('/auth'); return; }
    // If auth is done, user is logged in, but vault session couldn't be restored
    // (e.g. incognito, different device, cleared storage) → send back to login
    if (!session) { navigate('/auth', { replace: true }); }
  }, [loading, user, session, navigate]);

  // Request notification permission on mount (after user is confirmed logged in)
  useEffect(() => {
    if (user) requestNotificationPermission();
  }, [user]);

  // Show Privacy Policy update popup once per user after v2.0.0
  useEffect(() => {
    if (!user || !session) return;
    const key = `${PP_SEEN_KEY}:${user.id}`;
    if (!localStorage.getItem(key)) {
      // Small delay so the main UI renders first
      const t = setTimeout(() => setPpDialogOpen(true), 800);
      return () => clearTimeout(t);
    }
  }, [user, session]);

  const loadLocalData = useCallback(async () => {
    if (!user) return;
    try {
      const c = await getContactsFromDB(user.id);
      setContacts(c);
    } catch (err) {
      console.error('[ShadowCrypt] Failed to load contacts:', err);
    }
  }, [user]);

  const loadPendingRequests = useCallback(async () => {
    if (!user) return;
    try {
      const [incoming, outgoing, blocked] = await Promise.all([
        fetchIncomingRequests(user.id),
        fetchOutgoingRequests(user.id),
        fetchBlockedUserIds(),
      ]);
      setPendingRequests(incoming.filter(r => !blocked.includes(r.sender_id)));
      setOutgoingRequests(outgoing);
      setBlockedIds(blocked);
    } catch (err) {
      console.error('[ShadowCrypt] Failed to load contact requests:', err);
    }
  }, [user]);

  useEffect(() => {
    if (user && session) {
      autoDeleteOldMessages().finally(() => loadLocalData());
      loadPendingRequests();
      // Multi-device sync: re-derive contacts from accepted contact_requests
      fetchAcceptedContacts(user.id).then(async (remoteContacts) => {
        if (remoteContacts.length === 0) return;
        const existing = await getContactsFromDB(user.id);
        const existingIds = new Set(existing.map(c => c.id));
        const toAdd = remoteContacts.filter(rc => !existingIds.has(rc.userId));
        for (const rc of toAdd) {
          try {
            const fp = await computeFingerprint(rc.publicKey);
            const convId = makeConversationId(user.id, rc.userId);
            await saveContactToDB(user.id, {
              id: rc.userId,
              username: rc.username,
              publicKey: rc.publicKey,
              fingerprint: fp,
              addedAt: Date.now(),
              conversationId: convId,
            });
          } catch {
            // Silently skip individual failures
          }
        }
        if (toAdd.length > 0) {
          loadLocalData();
          toast.message('Contacts synced', { description: `${toAdd.length} contact${toAdd.length === 1 ? '' : 's'} restored from your account.` });
        }
      }).catch(() => {/* ignore sync errors */});
    }
  }, [user, session, loadLocalData, loadPendingRequests]);

  // Handle incoming relay message.
  // Uses refs for all mutable values so this callback is stable (never re-created),
  // which prevents the subscription from tearing down on every state change.
  const handleIncomingRelay = useCallback(async (relayMsg: RelayMessage) => {
    const currentUser = userRef.current;
    const currentSession = sessionRef.current;
    if (!currentUser || !currentSession) return;
    if (blockedIdsRef.current.includes(relayMsg.sender_id)) return;

    const allContacts = await getContactsFromDB(currentUser.id);
    const contact = allContacts.find(c => c.id === relayMsg.sender_id);
    const senderUsername = contact?.username ?? 'Unknown';

    // Always resolve the sender public key — fall back to live profile lookup
    let senderPublicKey = contact?.publicKey ?? '';
    if (!senderPublicKey) {
      senderPublicKey = (await getUserPublicKey(relayMsg.sender_id)) ?? '';
    }
    if (!senderPublicKey) {
      console.warn('[ShadowCrypt] Cannot decrypt: no public key for', relayMsg.sender_id);
      return;
    }

    const localMsg = await receiveAndDecryptMessage(
      relayMsg, currentUser.id, currentSession.username, senderUsername, senderPublicKey
    );

    if (localMsg) {
      setIncomingMessages(prev => [...prev, localMsg]);
      // Show anonymous notification if the app is in background or a different chat is open
      const isActiveChat = selectedConvRef.current?.id === localMsg.conversationId;
      if (!isActiveChat || document.hidden) {
        showAnonymousNotification();
      }
      // Increment unread count for conversations not currently open
      if (!isActiveChat) {
        setUnreadCounts(prev => ({
          ...prev,
          [localMsg.conversationId]: (prev[localMsg.conversationId] ?? 0) + 1,
        }));
      }
      // In-app toast (no sender name to stay private)
      if (!isActiveChat) {
        toast.message('New encrypted message', {
          description: '🔒 Open the conversation to read it.',
        });
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // stable — reads all mutable state through refs

  // Subscribe to realtime relay.
  // Depends only on user.id (a stable string) — not on callback refs or state values.
  // handleIncomingRelay is stable (uses refs internally), so re-subscriptions only
  // happen on actual login/logout, eliminating the session-null race condition.
  const userId = user?.id;
  useEffect(() => {
    if (!userId) return;

    // Attempt to drain pending messages — this may fire before session is set,
    // in which case handleIncomingRelay will silently skip (session guard inside).
    // The session-keyed effect below guarantees a retry once session is available.
    fetchPendingRelayMessages(userId).then(async pending => {
      for (const msg of pending) {
        await handleIncomingRelay(msg);
      }
    });

    const unsubscribeRelay = subscribeToRelay(userId, handleIncomingRelay);

    // Mutual contact removal: when another user removes us, remove them locally too
    const unsubscribeRemovals = subscribeToContactRemovals(userId, async (removerId) => {
      const currentUser = userRef.current;
      if (!currentUser) return;
      const allContacts = await getContactsFromDB(currentUser.id);
      const contact = allContacts.find(c => c.id === removerId);
      if (!contact) return;
      const convId = makeConversationId(currentUser.id, removerId);
      await removeContactAndMessagesFromDB(currentUser.id, removerId, convId);
      await deleteContactRequestBetween(currentUser.id, removerId);
      setSelectedConversation(prev => prev?.id === convId ? null : prev);
      loadLocalData();
      toast.message('Contact removed', { description: `@${contact.username} removed you from their contacts.` });
    });

    const unsubscribeRequests = subscribeToContactRequests(userId, (newReq) => {
      setPendingRequests(prev => {
        if (prev.find(r => r.id === newReq.id)) return prev;
        toast.message('New contact request', {
          description: 'Open Contacts to accept or decline.',
        });
        return [...prev, newReq];
      });
    });

    const unsubscribeOutgoing = subscribeToOutgoingRequestUpdates(userId, async (requestId, status) => {
      const currentUser = userRef.current;
      if (!currentUser) return;
      if (status === 'accepted') {
        setOutgoingRequests(prev => {
          const accepted = prev.find(r => r.id === requestId);
          if (accepted) {
            (async () => {
              try {
                const pubKey = accepted.receiverPublicKey ?? (await getUserPublicKey(accepted.receiver_id)) ?? '';
                if (!pubKey) return;
                const fp = await computeFingerprint(pubKey);
                const convId = makeConversationId(currentUser.id, accepted.receiver_id);
                await saveContactToDB(currentUser.id, {
                  id: accepted.receiver_id,
                  username: accepted.receiverUsername ?? 'Unknown',
                  publicKey: pubKey,
                  fingerprint: fp,
                  addedAt: Date.now(),
                  conversationId: convId,
                });
                loadLocalData();
              } catch (err) {
                console.error('[ShadowCrypt] Failed to save accepted contact:', err);
              }
            })();
          }
          return prev.filter(r => r.id !== requestId);
        });
        loadPendingRequests();
      } else {
        setOutgoingRequests(prev => prev.filter(r => r.id !== requestId));
      }
    });

    return () => {
      unsubscribeRelay();
      unsubscribeRemovals();
      unsubscribeRequests();
      unsubscribeOutgoing();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]); // only re-subscribe on actual login/logout

  // BUG FIX: Drain pending relay messages the moment session first becomes available.
  // The subscription effect above fires when userId is set, but session may not be
  // set yet at that point (it's restored from sessionStorage asynchronously in
  // AuthContext, one microtask after setUser). handleIncomingRelay guards on
  // sessionRef.current, so any pending messages processed during that window are
  // silently skipped without being deleted from relay_messages.
  // This effect fires on session.userId becoming non-null (i.e. first successful
  // vault unlock) and retries the drain — by then sessionRef.current is set and
  // decryption will succeed.
  const sessionUserId = session?.userId;
  useEffect(() => {
    if (!sessionUserId || !user) return;
    fetchPendingRelayMessages(user.id).then(async pending => {
      for (const msg of pending) {
        await handleIncomingRelay(msg);
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionUserId]); // fires exactly once when session first becomes valid

  const handleLogout = async () => {
    await signOut();
    navigate('/auth');
  };

  // While auth is loading, or session is being restored from sessionStorage,
  // show the spinner — do NOT navigate during render (causes React state corruption)
  if (loading || !user || !session) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center space-y-3">
          <div className="w-8 h-8 border-2 border-primary/30 border-t-primary rounded-full animate-spin mx-auto" />
          <p className="text-muted-foreground text-sm">Decrypting vault...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen w-full bg-background overflow-hidden">
      {/* Privacy Policy update popup — shown once per user after v2.0.0 */}
      <Dialog open={ppDialogOpen} onOpenChange={open => {
        if (!open) {
          localStorage.setItem(`${PP_SEEN_KEY}:${user.id}`, '1');
          setPpDialogOpen(false);
        }
      }}>
        <DialogContent className="max-w-[calc(100%-2rem)] md:max-w-sm bg-card border-border">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-foreground">
              <Shield className="w-5 h-5 text-primary" />
              Privacy Policy Updated
            </DialogTitle>
            <DialogDescription className="text-muted-foreground text-pretty">
              We have updated our Privacy Policy. We recommend you check it out to understand
              how your data is protected in ShadowCrypt v2.4.0.
            </DialogDescription>
          </DialogHeader>
          <div className="flex gap-2 mt-1">
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => {
                localStorage.setItem(`${PP_SEEN_KEY}:${user.id}`, '1');
                setPpDialogOpen(false);
              }}
            >
              Dismiss
            </Button>
            <Button
              className="flex-1 bg-primary text-primary-foreground hover:bg-primary/90"
              asChild
            >
              <Link
                to="/privacy"
                onClick={() => {
                  localStorage.setItem(`${PP_SEEN_KEY}:${user.id}`, '1');
                  setPpDialogOpen(false);
                }}
              >
                View Policy
              </Link>
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      {/* Mobile header */}
      <MobileHeader
        username={session.username}
        pendingCount={pendingRequests.length}
        unreadCount={Object.values(unreadCounts).reduce((s, n) => s + n, 0)}
        onMenuOpen={() => setSidebarOpen(true)}
        onLogout={handleLogout}
      />
      {/* Desktop sidebar — hidden when collapsed */}
      {!desktopSidebarCollapsed && (
        <Sidebar
          key="sidebar-expanded"
          contacts={contacts}
          selectedConversationId={selectedConversation?.id ?? null}
          currentUserId={user.id}
          username={session.username}
          fingerprint={session.fingerprint}
          profile={profile}
          isOpen={sidebarOpen}
          pendingRequests={pendingRequests}
          outgoingRequests={outgoingRequests}
          blockedIds={blockedIds}
          unreadCounts={unreadCounts}
          onClose={() => setSidebarOpen(false)}
          onSelectConversation={conv => {
            setSelectedConversation(conv);
            setSidebarOpen(false);
            setDesktopSidebarCollapsed(true);
            setUnreadCounts(prev => { const n = { ...prev }; delete n[conv.id]; return n; });
          }}
          onContactsChange={loadLocalData}
          onRequestHandled={loadPendingRequests}
          onContactRemoved={async (contactId) => {
            await notifyContactRemoval(contactId);
          }}
          onConversationDeselect={convId => {
            if (selectedConversation?.id === convId) setSelectedConversation(null);
          }}
          onConversationRead={convId => setUnreadCounts(prev => { const n = { ...prev }; delete n[convId]; return n; })}
          onLogout={handleLogout}
        />
      )}
      {/* Mobile sidebar (Sheet) — always rendered for mobile overlay */}
      {desktopSidebarCollapsed && (
        <Sidebar
          key="sidebar-collapsed"
          contacts={contacts}
          selectedConversationId={selectedConversation?.id ?? null}
          currentUserId={user.id}
          username={session.username}
          fingerprint={session.fingerprint}
          profile={profile}
          isOpen={sidebarOpen}
          pendingRequests={pendingRequests}
          outgoingRequests={outgoingRequests}
          blockedIds={blockedIds}
          unreadCounts={unreadCounts}
          onClose={() => setSidebarOpen(false)}
          onSelectConversation={conv => {
            setSelectedConversation(conv);
            setSidebarOpen(false);
            setUnreadCounts(prev => { const n = { ...prev }; delete n[conv.id]; return n; });
          }}
          onContactsChange={loadLocalData}
          onRequestHandled={loadPendingRequests}
          onContactRemoved={async (contactId) => {
            await notifyContactRemoval(contactId);
          }}
          onConversationDeselect={convId => {
            if (selectedConversation?.id === convId) setSelectedConversation(null);
          }}
          onConversationRead={convId => setUnreadCounts(prev => { const n = { ...prev }; delete n[convId]; return n; })}
          onLogout={handleLogout}
        />
      )}
      {/* Main chat area */}
      <div className="flex-1 min-w-0 flex flex-col pt-14 md:pt-0">
        {/* Desktop sidebar expand button — shown when sidebar is collapsed */}
        {desktopSidebarCollapsed && (
          <></>
        )}
        <ChatArea
          conversation={selectedConversation}
          currentUserId={user.id}
          currentUsername={session.username}
          incomingMessages={incomingMessages}
          contacts={contacts}
          pendingRequests={pendingRequests}
          onMessageSent={() => {}}
          sidebarCollapsed={desktopSidebarCollapsed}
          onBack={() => {
            setSelectedConversation(null);
            setDesktopSidebarCollapsed(false);
          }}
        />
      </div>
    </div>
  );
}
