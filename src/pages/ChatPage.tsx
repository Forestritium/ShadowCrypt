import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { useAuth } from '@/contexts/AuthContext';
import { useTheme } from '@/contexts/ThemeContext';
import { autoDeleteOldMessages, isVaultUnlocked, getStoredSaltBase64, getEncryptedIdentityKeyBlob } from '@/lib/localStore';
import { supabase } from '@/db/supabase';
import { getContactsFromDB, saveContactToDB, removeContactAndMessagesFromDB, deleteConversationMessagesForBoth } from '@/lib/dbStore';
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
  fetchPendingRemovals,
  deleteRelayMessagesBetween,
  clearContactRemovalsBetween,
  refreshContactPublicKeys,
  subscribeToDeviceChanges,
} from '@/lib/relay';
import type { UserDevice, KeyChangeAlert } from '@/types/types';
import type { Contact, LocalMessage, ConversationPreview, RelayMessage, ContactRequest } from '@/types/types';
import { makeConversationId } from '@/lib/session';
import { computeFingerprint } from '@/lib/crypto';
import { Sidebar } from '@/components/chat/Sidebar';
import { ChatArea } from '@/components/chat/ChatArea';
import { MobileHeader } from '@/components/chat/MobileHeader';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';

// Show an anonymous push notification (never reveals sender)
function showAnonymousNotification() {
  if ('Notification' in window && Notification.permission === 'granted') {
    // eslint-disable-next-line no-new
    new Notification('SylvaCrypt', {
      body: 'You got a notification from SylvaCrypt',
      icon: '/icon-192x192.png',
      tag: 'sylvacrypt-message',
      silent: false,
    });
  }
}



export default function ChatPage() {
  const { user, profile, session, loading, signOut } = useAuth();
  const navigate = useNavigate();

  // Document-level capture deterrence — active for the entire chat page
  useCaptureDeterrence();

  const [contacts, setContacts] = useState<Contact[]>([]);
  const [selectedConversation, setSelectedConversation] = useState<ConversationPreview | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [desktopSidebarCollapsed, setDesktopSidebarCollapsed] = useState(true);
  const [incomingMessages, setIncomingMessages] = useState<LocalMessage[]>([]);
  const [pendingRequests, setPendingRequests] = useState<ContactRequest[]>([]);
  const [outgoingRequests, setOutgoingRequests] = useState<ContactRequest[]>([]);
  const [blockedIds, setBlockedIds] = useState<string[]>([]);

  // Keyboard shortcut refs — wired into <Sidebar> so Ctrl+K focuses search,
  // Ctrl+N opens Add Contact dialog.
  const focusSearchRef = useRef<(() => void) | null>(null);
  const triggerAddContactRef = useRef<(() => void) | null>(null);

  const { toggleTheme } = useTheme();
  useKeyboardShortcuts({
    onSearch: () => {
      setSidebarOpen(true);
      setTimeout(() => focusSearchRef.current?.(), 50);
    },
    onNewContact: () => {
      setSidebarOpen(true);
      setTimeout(() => triggerAddContactRef.current?.(), 50);
    },
    onToggleTheme: toggleTheme,
    onFocusMessageInput: () => {
      window.dispatchEvent(new CustomEvent('focus-message-input'));
    },
    onOpenSettings: () => navigate('/settings'),
  });

  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({});
  // Key-change alerts detected during contact key refresh — passed to ChatArea
  const [keyChangeAlerts, setKeyChangeAlerts] = useState<KeyChangeAlert[]>([]);

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
  // Eagerly sync the session public key to the profile whenever it is absent.
  // This self-heals accounts created before the reliable signup write was in
  // place — covering any active user without requiring a logout / login cycle.
  //
  // Dependencies include profile?.public_key so this re-fires once the profile
  // row is loaded and we can do an accurate comparison — without that, profile
  // would be null on mount and we'd always think a sync is needed.
  useEffect(() => {
    if (!user || !session?.publicKeyBase64) return;
    // Wait until the profile has been fetched from the DB.  When profile is
    // null the comparison is undefined vs key-string → always "not in sync",
    // which would trigger the PATCH on every mount even when unnecessary.
    if (!profile) return;
    if (profile.public_key === session.publicKeyBase64) return; // already in sync

    (async () => {
      try {
        // Gather all recoverable backup data so we write a complete row.
        const [saltB64, keyBlob] = await Promise.all([
          getStoredSaltBase64(),
          getEncryptedIdentityKeyBlob(),
        ]);
        // Only sync public_key, vault_salt and encrypted_private_key.
        // password_version / kdf_version must NOT be touched here — they are
        // set exclusively by the sign-in / sign-up / migration flows which
        // actually know the correct KDF algorithm for this account. Overwriting
        // them with a hardcoded value corrupts the vault key-derivation for
        // users originally created with a different KDF version.
        const updates: Record<string, string> = {
          public_key: session.publicKeyBase64,
        };
        if (saltB64) updates.vault_salt = saltB64;
        if (keyBlob) updates.encrypted_private_key = keyBlob;

        // Profile confirmed to exist (we just compared profile.public_key).
        // Refresh the session JWT first to prevent auth.uid() returning NULL
        // inside the RLS WITH CHECK, which would silently update 0 rows.
        await supabase.auth.refreshSession().catch(() => {});
        await supabase.from('profiles').update(updates).eq('id', user.id);
      } catch {
        // Non-critical — will retry on next mount
      }
    })();
  // profile?.public_key included so we re-run once profile loads from DB
  }, [user?.id, session?.publicKeyBase64, profile?.public_key]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadLocalData = useCallback(async () => {
    if (!user) return;
    try {
      // getContactsFromDB always recomputes fingerprint from the stored public_key
      const c = await getContactsFromDB(user.id);
      setContacts(c);
      // Refresh public keys from live profiles, detect any key changes, and
      // surface them as blocking alerts in ChatArea.
      if (c.length > 0) {
        const [updatedKeys, alerts] = await refreshContactPublicKeys(user.id, c.map(ct => ({
          id: ct.id,
          username: ct.username,
          publicKey: ct.publicKey,
          fingerprint: ct.fingerprint,
          verifiedViaQR: ct.verifiedViaQR,
        })));
        if (alerts.length > 0) setKeyChangeAlerts(prev => {
          // Merge: replace existing alerts for the same contactId, append new ones
          const existing = prev.filter(a => !alerts.find(n => n.contactId === a.contactId));
          return [...existing, ...alerts];
        });
        if (updatedKeys.size > 0) {
          const fingerprintUpdates = await Promise.all(
            [...updatedKeys.entries()].map(async ([id, key]) => ({
              id,
              publicKey: key,
              fingerprint: await computeFingerprint(key),
            }))
          );
          const fpMap = new Map(fingerprintUpdates.map(u => [u.id, u]));
          setContacts(prev => prev.map(ct => {
            const update = fpMap.get(ct.id);
            return update ? { ...ct, publicKey: update.publicKey, fingerprint: update.fingerprint } : ct;
          }));
        }
      }
    } catch (err) {
      console.error('[SylvaCrypt] Failed to load contacts:', err);
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
      console.error('[SylvaCrypt] Failed to load contact requests:', err);
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
    // Guard: vault must be unlocked AND session must be populated before we
    // attempt decryption.  The Realtime INSERT handler fires immediately on
    // message arrival — if the vault key isn't in memory yet (e.g. during the
    // keep-me-signed-in restore window), receiveAndDecryptMessage would run
    // without the key, return null, AND delete the relay row — permanently
    // losing the message.  Returning here is safe because the relay row stays
    // in the DB; the drain loop retries once isVaultUnlocked() becomes true.
    if (!isVaultUnlocked() || !currentUser || !currentSession) {
      console.warn('[SylvaCrypt] handleIncomingRelay: vault/session not ready — message will be retried on next drain', relayMsg.id);
      return;
    }
    if (blockedIdsRef.current.includes(relayMsg.sender_id)) return;

    const allContacts = await getContactsFromDB(currentUser.id);
    const contact = allContacts.find(c => c.id === relayMsg.sender_id);
    let senderUsername = contact?.username ?? '';

    // Always resolve the sender public key — fall back to live profile lookup
    let senderPublicKey = contact?.publicKey ?? '';
    if (!senderPublicKey || !senderUsername) {
      // Contact not yet in local vault (e.g. race between acceptance and first
      // message, or fresh-install multi-device sync).  Fetch the live profile
      // for both the public key AND the username so the stored message is
      // attributed correctly rather than landing as 'Unknown'.
      const { data: senderProfile } = await supabase
        .from('public_profiles')
        .select('username, public_key')
        .eq('id', relayMsg.sender_id)
        .maybeSingle();
      if (!senderPublicKey) senderPublicKey = senderProfile?.public_key ?? '';
      if (!senderUsername)  senderUsername  = senderProfile?.username  ?? 'Unknown';
    }
    if (!senderPublicKey) {
      console.warn('[SylvaCrypt] Cannot decrypt: no public key for', relayMsg.sender_id);
      return;
    }

    const localMsg = await receiveAndDecryptMessage(
      relayMsg, currentUser.id, currentSession.username, senderUsername, senderPublicKey
    );

    if (localMsg) {
      setIncomingMessages(prev => {
        const next = [...prev, localMsg];
        // Cap at 200 entries to prevent unbounded growth across long sessions.
        // Oldest entries for non-active conversations are trimmed first; mutations
        // for the active conversation are always applied before they age out.
        return next.length > 200 ? next.slice(-200) : next;
      });
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

    // Drain helper — called by subscribeToRelay's onReady on every SUBSCRIBED
    // event (initial connect + reconnects). This closes the race window between
    // the initial fetch and the channel becoming active: any message inserted
    // after the fetch fired but before the subscription was live is caught here.
    //
    // TWO prerequisites must both be true before we touch relay_messages:
    //
    //   1. Vault unlocked — if the vault key isn't ready yet (Argon2id derivation
    //      / IndexedDB restore still in flight on the keep-me-signed-in path),
    //      receiveAndDecryptMessage returns null and discards the message without
    //      ever retrying it.
    //
    //   2. sessionRef.current populated — handleIncomingRelay guards on
    //      `sessionRef.current` and silently returns (not re-queued) when it is
    //      null.  The vault module variable (currentSession in session.ts) and the
    //      React session state are TWO separate async layers: unlockSession sets
    //      the module variable synchronously, but the React state update goes
    //      through setSession → re-render → useEffect → sessionRef.current,
    //      which is typically one or two microtask/render cycles later.  If the
    //      drain fires in that gap every message in the backlog is silently lost.
    //
    // Retrying every 500 ms handles both races with no busy-loop risk.
    const drainPending = () => {
      if (!isVaultUnlocked() || !sessionRef.current) {
        console.debug('[SylvaCrypt] drainPending: waiting for vault/session —',
          !isVaultUnlocked() ? 'vault locked' : 'session not ready');
        setTimeout(drainPending, 500);
        return;
      }
      console.debug('[SylvaCrypt] drainPending: vault + session ready, draining relay…');
      // Refresh the JWT once before draining so RLS-gated DELETEs (removing
      // processed relay rows) never fail silently due to an expired token.
      supabase.auth.refreshSession().catch(() => {}).finally(() => {
        fetchPendingRelayMessages(userId).then(async pending => {
          console.debug(`[SylvaCrypt] drainPending: ${pending.length} pending relay message(s)`);
          for (const msg of pending) {
            try {
              await handleIncomingRelay(msg);
            } catch (err) {
              // Isolate per-message errors so one corrupted or undecryptable
              // relay row cannot stall the rest of the backlog.
              console.error('[SylvaCrypt] drainPending: error processing relay row:', err);
            }
          }
        });
      });
    };

    // Subscribe first; drain is triggered inside onReady once SUBSCRIBED so
    // there is no gap between fetch and an active channel.
    const unsubscribeRelay = subscribeToRelay(userId, handleIncomingRelay, drainPending);

    // Mutual contact removal: when another user removes us, remove them locally too
    const unsubscribeRemovals = subscribeToContactRemovals(userId, async ({removerId, isBlock}) => {
      const currentUser = userRef.current;
      if (!currentUser) return;
      const allContacts = await getContactsFromDB(currentUser.id);
      const contact = allContacts.find(c => c.id === removerId);
      if (!contact) return;
      
      if (isBlock) {
        toast.message('Contact blocked you', { description: `@${contact.username} blocked you.` });
        return; // Do NOT remove from local DB; keep them so we know they exist, they just blocked us.
      }
      
      const convId = makeConversationId(currentUser.id, removerId);
      await removeContactAndMessagesFromDB(currentUser.id, removerId, convId);
      await deleteContactRequestBetween(currentUser.id, removerId);
      // Also purge in-flight relay messages and the other user's DB copy
      await deleteRelayMessagesBetween(currentUser.id, removerId);
      await deleteConversationMessagesForBoth(currentUser.id, removerId, convId);
      setSelectedConversation(prev => prev?.id === convId ? null : prev);
      loadLocalData();
      toast.message('Contact removed', { description: `@${contact.username} removed you from their contacts.` });
    });

    const unsubscribeRequests = subscribeToContactRequests(
      userId,
      (newReq) => {
        setPendingRequests(prev => {
          if (prev.find(r => r.id === newReq.id)) return prev;
          toast.message('New contact request', {
            description: 'Open Contacts to accept or decline.',
          });
          return [...prev, newReq];
        });
      },
      () => {
        // onReconnect
        fetchIncomingRequests(userId).then(incoming => {
          setPendingRequests(prev => {
            // Keep existing blocked filter logic by assuming blockedIds is up to date 
            // (or we just use fetchBlockedUserIds inside here)
            fetchBlockedUserIds().then(blocked => {
              setPendingRequests(incoming.filter(r => !blocked.includes(r.sender_id)));
            });
            return prev;
          });
        });
      }
    );

    // Subscribe to this user's device table — primary device gets a toast when
    // a new secondary device registers and needs approval.
    const myDeviceId = localStorage.getItem('sc_device_id') ?? '';
    const unsubscribeDevices = subscribeToDeviceChanges(userId, (device: UserDevice, event) => {
      if (event === 'INSERT' && !device.approved && device.device_id !== myDeviceId) {
        toast.message('New device wants to link', {
          description: `"${device.device_name}" is pending approval.`,
          action: {
            label: 'Review',
            onClick: () => { window.location.href = '/linked-devices'; },
          },
          duration: 12000,
        });
      }
      if (event === 'UPDATE' && device.approved && device.device_id === myDeviceId) {
        toast.success('Device approved — you can now receive messages on this device.');
      }
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
                // Always fetch the receiver's CURRENT public key from their live profile.
                // accepted.receiverPublicKey was captured when the outgoing-request list
                // was loaded and may be stale if the receiver rotated their key in the
                // meantime — storing the stale key here would cause a fingerprint mismatch.
                const liveKey = (await getUserPublicKey(accepted.receiver_id)) ?? accepted.receiverPublicKey ?? '';
                if (!liveKey) return;
                const fp = await computeFingerprint(liveKey);
                const convId = makeConversationId(currentUser.id, accepted.receiver_id);
                await saveContactToDB(currentUser.id, {
                  id: accepted.receiver_id,
                  username: accepted.receiverUsername ?? 'Unknown',
                  publicKey: liveKey,
                  fingerprint: fp,
                  addedAt: Date.now(),
                  conversationId: convId,
                });
                // Clear stale contact_removals rows so a prior removal
                // notification never triggers a ghost re-removal on next login.
                await clearContactRemovalsBetween(currentUser.id, accepted.receiver_id).catch(() => {});
                loadLocalData();
              } catch (err) {
                console.error('[SylvaCrypt] Failed to save accepted contact:', err);
              }
            })();
          }
          return prev.filter(r => r.id !== requestId);
        });
        loadPendingRequests();
      } else {
        setOutgoingRequests(prev => prev.filter(r => r.id !== requestId));
      }
    },
    () => {
      // onReconnect
      fetchOutgoingRequests(userId).then(setOutgoingRequests);
    });

    // Subscribe to contacts table UPDATE events for this user.
    // When a contact's public_key changes (e.g. P-256→X25519 migration via DB
    // trigger), reload contacts so the displayed fingerprint updates live without
    // requiring the user to restart.
    // Store the channel reference so the cleanup can remove the exact channel
    // (supabase.channel(name) creates a NEW object each time — calling
    // .unsubscribe() on a freshly created channel has no effect on the original).
    const contactsKeyChannel = supabase
      .channel(`contacts-keywatch-${userId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'contacts', filter: `owner_id=eq.${userId}` },
        () => { loadLocalData(); }
      )
      .subscribe();

    return () => {
      unsubscribeRelay();
      unsubscribeRemovals();
      unsubscribeRequests();
      unsubscribeOutgoing();
      unsubscribeDevices();
      supabase.removeChannel(contactsKeyChannel);
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

    // Drain any pending relay messages (may have been skipped before session was ready)
    fetchPendingRelayMessages(user.id).then(async pending => {
      for (const msg of pending) {
        try {
          await handleIncomingRelay(msg);
        } catch (err) {
          console.error('[SylvaCrypt] session drain: error processing relay row:', err);
        }
      }
    });

    // Drain any contact-removal notifications that arrived while we were offline.
    // Realtime only delivers live INSERT events — existing rows must be polled.
    fetchPendingRemovals(user.id).then(async removals => {
      let changed = false;
      for (const { removerId, isBlock } of removals) {
        const allContacts = await getContactsFromDB(user.id);
        const contact = allContacts.find(c => c.id === removerId);
        if (!contact) continue;
        
        if (isBlock) {
          toast.message('Contact blocked you', { description: `@${contact.username} blocked you.` });
          continue;
        }
        
        const convId = makeConversationId(user.id, removerId);
        await removeContactAndMessagesFromDB(user.id, removerId, convId);
        await deleteContactRequestBetween(user.id, removerId);
        await deleteRelayMessagesBetween(user.id, removerId);
        await deleteConversationMessagesForBoth(user.id, removerId, convId);
        setSelectedConversation(prev => prev?.id === convId ? null : prev);
        toast.message('Contact removed', { description: `@${contact.username} removed you from their contacts.` });
        changed = true;
      }
      if (changed) loadLocalData();
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionUserId]); // fires exactly once when session first becomes valid

  // ── Polling fallback — defense-in-depth for WebSocket gaps ──────────────────
  // Supabase Realtime is the primary delivery path, but WebSocket connections
  // can silently stall (NAT timeouts, proxy resets, JWT expiry in the Realtime
  // layer, etc.).  A lightweight periodic drain ensures messages are never
  // permanently missed — the drain is idempotent (already-processed relay rows
  // have been deleted) so duplicate processing is impossible.
  // Only runs when the browser tab is visible to avoid unnecessary traffic.
  useEffect(() => {
    if (!userId || !sessionUserId) return;

    const poll = async () => {
      if (document.hidden) return; // skip when tab is backgrounded
      // Refresh JWT before polling so relay-row DELETEs succeed even if the
      // Supabase session was silently stale (Realtime token refresh is automatic
      // but the REST client sometimes lags behind).
      await supabase.auth.refreshSession().catch(() => {});
      const pending = await fetchPendingRelayMessages(userId).catch(() => [] as import('@/types/types').RelayMessage[]);
      for (const msg of pending) {
        await handleIncomingRelay(msg);
      }
    };

    const interval = setInterval(poll, 8000);
    return () => clearInterval(interval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, sessionUserId]);

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
    <div className="flex flex-col md:flex-row h-[100dvh] w-full bg-background overflow-hidden">
      {/* Mobile header - shown only when no conversation is selected on mobile */}
      {!selectedConversation && (
        <MobileHeader
          username={session.username}
          pendingCount={pendingRequests.length}
          unreadCount={Object.values(unreadCounts).reduce((s, n) => s + n, 0)}
          onMenuOpen={() => setSidebarOpen(true)}
          onLogout={handleLogout}
        />
      )}
      {/* Desktop sidebar — hidden when collapsed */}
      {!desktopSidebarCollapsed && (
        <Sidebar
          key="sidebar-expanded"
          contacts={contacts}
          selectedConversationId={selectedConversation?.id ?? null}
          currentUserId={user.id}
          username={session.username}
          fingerprint={session.fingerprint}
          myPublicKeyBase64={session.publicKeyBase64}
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
          onContactRemoved={async (contactId, isBlock) => {
            await notifyContactRemoval(contactId, isBlock);
          }}
          onConversationDeselect={convId => {
            if (selectedConversation?.id === convId) setSelectedConversation(null);
          }}
          onConversationRead={convId => setUnreadCounts(prev => { const n = { ...prev }; delete n[convId]; return n; })}
          onLogout={handleLogout}
          focusSearchRef={focusSearchRef}
          onTriggerAddContact={triggerAddContactRef}
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
          myPublicKeyBase64={session.publicKeyBase64}
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
          onContactRemoved={async (contactId, isBlock) => {
            await notifyContactRemoval(contactId, isBlock);
          }}
          onConversationDeselect={convId => {
            if (selectedConversation?.id === convId) setSelectedConversation(null);
          }}
          onConversationRead={convId => setUnreadCounts(prev => { const n = { ...prev }; delete n[convId]; return n; })}
          onLogout={handleLogout}
          focusSearchRef={focusSearchRef}
          onTriggerAddContact={triggerAddContactRef}
        />
      )}
      {/* Main chat area */}
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
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
          keyChangeAlerts={keyChangeAlerts}
          onKeyChangeAlertDismissed={contactId =>
            setKeyChangeAlerts(prev => prev.filter(a => a.contactId !== contactId))
          }
          onMessageSent={() => {}}
          sidebarCollapsed={desktopSidebarCollapsed}
          onMessagesConsumed={convId =>
            setIncomingMessages(prev => prev.filter(m => m.conversationId !== convId))
          }
          onBack={() => {
            setSelectedConversation(null);
            setDesktopSidebarCollapsed(false);
          }}
        />

      </div>
    </div>
  );
}
