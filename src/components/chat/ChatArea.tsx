import { useState, useEffect, useRef, useCallback } from 'react';
import { toast } from 'sonner';
import {
  Shield, Lock, Key, Send, MessageSquare,
  AlertCircle, Info, Clock, ArrowLeft, ImageIcon, X, Reply, Bell, BellOff,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import type { ConversationPreview, LocalMessage, Contact, ContactRequest, ReplyTo } from '@/types/types';
import { getMessagesFromDB, subscribeToMessages } from '@/lib/dbStore';
import {
  sendEncryptedMessage,
  uploadChatImage, ImageLimitError, getTodayImageCount, fetchAndDecryptChatImage,
  uploadVoiceMessage, VoiceLimitError, getTodayVoiceDuration,
} from '@/lib/relay';
import { broadcastTyping, subscribeToTyping } from '@/lib/relay';
import { supabase } from '@/db/supabase';
import { ReplyPreviewBar } from './ReplyPreviewBar';
import { QuotedMessage } from './QuotedMessage';
import { VoiceRecordButton } from './VoiceRecordButton';
import { VoiceMessageBubble } from './VoiceMessageBubble';
import { playNotificationSound, unlockAudio, isMuted, setMuted, isDND } from '@/lib/notificationSound';
import { useCaptureDeterrence } from '@/hooks/use-capture-deterrence';
import { VOICE_DAILY_LIMIT_SECONDS } from '@/lib/voiceRecorder';

const IMAGE_DAILY_LIMIT = 10;

interface ChatAreaProps {
  conversation: ConversationPreview | null;
  currentUserId: string;
  currentUsername: string;
  incomingMessages: LocalMessage[];
  contacts: Contact[];
  pendingRequests: ContactRequest[];
  onMessageSent: () => void;
  onBack?: () => void;
  sidebarCollapsed?: boolean; // desktop sidebar is collapsed — show back button
}

function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDate(ts: number) {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' });
}

interface MessageBubbleProps {
  message: LocalMessage;
  isSelf: boolean;
  showAvatar: boolean;
  senderInitial: string;
  onReply: (msg: LocalMessage) => void;
  onScrollTo: (id: string) => void;
  decryptedImageUrl?: string | null;
}

function MessageBubble({ message, isSelf, showAvatar, senderInitial, onReply, onScrollTo, decryptedImageUrl }: MessageBubbleProps) {
  const [imgOpen, setImgOpen] = useState(false);
  const [showReplyBtn, setShowReplyBtn] = useState(false);
  // Swipe-right to reply (touch)
  const touchStartX = useRef<number | null>(null);
  const touchStartY = useRef<number | null>(null);
  const swipedRef = useRef(false);

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
    touchStartY.current = e.touches[0].clientY;
    swipedRef.current = false;
  };
  const handleTouchMove = (e: React.TouchEvent) => {
    if (touchStartX.current === null || touchStartY.current === null) return;
    const dx = e.touches[0].clientX - touchStartX.current;
    const dy = Math.abs(e.touches[0].clientY - touchStartY.current);
    if (!swipedRef.current && dx > 48 && dy < 30) {
      swipedRef.current = true;
      onReply(message);
    }
  };
  const handleTouchEnd = () => {
    touchStartX.current = null;
    touchStartY.current = null;
  };

  return (
    <div
      className={`flex w-full items-end gap-2 group ${isSelf ? 'flex-row-reverse' : 'flex-row'}`}
      onMouseEnter={() => setShowReplyBtn(true)}
      onMouseLeave={() => setShowReplyBtn(false)}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {!isSelf && (
        <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 self-end mb-1 ${
          showAvatar ? 'bg-muted border border-border' : 'invisible'
        }`}>
          <span className="text-xs font-semibold text-foreground">{senderInitial}</span>
        </div>
      )}

      {/* Reply button — visible on hover (desktop) */}
      <button
        type="button"
        aria-label="Reply"
        onClick={() => onReply(message)}
        className={`shrink-0 self-center w-7 h-7 flex items-center justify-center rounded-full text-muted-foreground hover:text-primary hover:bg-muted transition-all duration-150 ${
          showReplyBtn ? 'opacity-100 scale-100' : 'opacity-0 scale-75 pointer-events-none'
        } ${isSelf ? 'order-last ml-0 mr-0' : 'order-first'}`}
      >
        <Reply className="w-3.5 h-3.5" />
      </button>

      <div className={`min-w-0 max-w-[75%] flex flex-col gap-0.5 ${isSelf ? 'items-end' : 'items-start'}`}>
        <div className={`px-3 py-2 rounded-2xl text-sm leading-relaxed ${
          isSelf ? 'bubble-sent rounded-br-sm' : 'bubble-received rounded-bl-sm'
        }`}>
          {/* Quoted reply preview */}
          {message.replyTo && (
            <QuotedMessage replyTo={message.replyTo} onScrollTo={onScrollTo} />
          )}

          {message.imageUrl && (
            <div className="mb-1">
              <img
                src={message.imageUrl}
                alt="Shared image"
                className="rounded-xl max-w-[220px] md:max-w-[280px] w-full object-cover cursor-pointer hover:opacity-90 transition-opacity"
                onClick={() => setImgOpen(true)}
                loading="lazy"
                draggable={false}
              />
              {imgOpen && (
                <div
                  className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
                  onClick={() => setImgOpen(false)}
                >
                  <button
                    className="absolute top-4 right-4 text-white/80 hover:text-white"
                    onClick={() => setImgOpen(false)}
                    aria-label="Close"
                  >
                    <X className="w-6 h-6" />
                  </button>
                  <img
                    src={message.imageUrl}
                    alt="Full size"
                    className="max-w-full max-h-[90dvh] rounded-xl object-contain"
                    onClick={e => e.stopPropagation()}
                    draggable={false}
                  />
                </div>
              )}
            </div>
          )}
          {/* Encrypted image — resolved to a blob URL via signed URL + AES-GCM decryption */}
          {!message.imageUrl && decryptedImageUrl && (
            <div className="mb-1">
              <img
                src={decryptedImageUrl}
                alt="Shared image"
                className="rounded-xl max-w-[220px] md:max-w-[280px] w-full object-cover cursor-pointer hover:opacity-90 transition-opacity"
                onClick={() => setImgOpen(true)}
                loading="lazy"
                draggable={false}
              />
              {imgOpen && (
                <div
                  className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
                  onClick={() => setImgOpen(false)}
                >
                  <button
                    className="absolute top-4 right-4 text-white/80 hover:text-white"
                    onClick={() => setImgOpen(false)}
                    aria-label="Close"
                  >
                    <X className="w-6 h-6" />
                  </button>
                  <img
                    src={decryptedImageUrl}
                    alt="Full size"
                    className="max-w-full max-h-[90dvh] rounded-xl object-contain"
                    onClick={e => e.stopPropagation()}
                    draggable={false}
                  />
                </div>
              )}
            </div>
          )}
          {/* Encrypted image loading placeholder */}
          {!message.imageUrl && message.imageStoragePath && !decryptedImageUrl && (
            <div className="mb-1 w-[180px] h-[120px] rounded-xl bg-muted animate-pulse flex items-center justify-center">
              <Lock className="w-5 h-5 text-muted-foreground/50" />
            </div>
          )}
          {/* Voice message player — decrypted lazily on first play */}
          {message.voiceStoragePath && message.voiceKeyBase64 && (
            <VoiceMessageBubble
              storagePath={message.voiceStoragePath}
              voiceKey={message.voiceKeyBase64}
              duration={message.voiceDuration ?? 0}
              isSelf={isSelf}
            />
          )}
          {message.content && (
            <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{message.content}</p>
          )}
        </div>

        <div className={`flex items-center gap-1 px-1 ${isSelf ? 'flex-row-reverse' : 'flex-row'}`}>
          <span className="text-xs text-muted-foreground tabular-nums">{formatTime(message.timestamp)}</span>
          {message.status === 'failed' && isSelf && (
            <AlertCircle className="w-3 h-3 text-destructive" />
          )}
        </div>
      </div>
    </div>
  );
}

// ── Image daily limit dialog ──────────────────────────────────────────────────
function ImageLimitDialog({ open, resetAt, onClose }: { open: boolean; resetAt: Date | null; onClose: () => void }) {
  const formatReset = (d: Date) => {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true });
  };
  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-[calc(100%-2rem)] md:max-w-sm bg-card border-border">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-foreground">
            <ImageIcon className="w-5 h-5 text-primary" />
            Daily Image Limit Reached
          </DialogTitle>
          <DialogDescription className="text-muted-foreground text-pretty">
            You can send up to <strong>{IMAGE_DAILY_LIMIT} images per day</strong> to keep the service
            running smoothly. This limit will be increased in a future update.
          </DialogDescription>
        </DialogHeader>
        {resetAt && (
          <div className="flex items-center gap-2 bg-primary/5 border border-primary/20 rounded-lg px-3 py-2.5 text-sm">
            <Clock className="w-4 h-4 text-primary shrink-0" />
            <span className="text-foreground">
              Your limit resets today at <strong>{formatReset(resetAt)}</strong> (midnight UTC).
            </span>
          </div>
        )}
        <Button
          className="w-full bg-primary text-primary-foreground hover:bg-primary/90"
          onClick={onClose}
        >
          Got it
        </Button>
      </DialogContent>
    </Dialog>
  );
}

// ── Voice daily limit dialog ──────────────────────────────────────────────────
function VoiceLimitDialog({
  open, resetAt, remainingSeconds, onClose,
}: { open: boolean; resetAt: Date | null; remainingSeconds: number; onClose: () => void }) {
  const formatReset = (d: Date) =>
    d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true });
  const totalMin = Math.floor(VOICE_DAILY_LIMIT_SECONDS / 60);
  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-[calc(100%-2rem)] md:max-w-sm bg-card border-border">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-foreground">
            <Clock className="w-5 h-5 text-primary" />
            Daily Voice Limit Reached
          </DialogTitle>
          <DialogDescription className="text-muted-foreground text-pretty">
            You can send up to <strong>{totalMin} minutes of voice messages per day</strong>.
            {remainingSeconds > 0 && (
              <> Only <strong>{remainingSeconds}s</strong> remaining today — your recording was too long.</>
            )}
          </DialogDescription>
        </DialogHeader>
        {resetAt && (
          <div className="flex items-center gap-2 bg-primary/5 border border-primary/20 rounded-lg px-3 py-2.5 text-sm">
            <Clock className="w-4 h-4 text-primary shrink-0" />
            <span className="text-foreground">
              Your limit resets today at <strong>{formatReset(resetAt)}</strong> (midnight UTC).
            </span>
          </div>
        )}
        <Button className="w-full bg-primary text-primary-foreground hover:bg-primary/90" onClick={onClose}>
          Got it
        </Button>
      </DialogContent>
    </Dialog>
  );
}

export function ChatArea({
  conversation,
  currentUserId,
  currentUsername,
  incomingMessages,
  contacts,
  pendingRequests,
  onMessageSent,
  onBack,
  sidebarCollapsed = false,
}: ChatAreaProps) {
  const [messages, setMessages] = useState<LocalMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [remoteTyping, setRemoteTyping] = useState(false);
  const [contactBio, setContactBio] = useState<string | null>(null);
  // Reply state
  const [replyingTo, setReplyingTo] = useState<ReplyTo | null>(null);
  // Mute state (per-conversation, persisted in localStorage)
  const [muted, setMutedState] = useState(false);
  // Image state
  const [selectedImage, setSelectedImage] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [imageLimitOpen, setImageLimitOpen] = useState(false);
  const [imageLimitResetAt, setImageLimitResetAt] = useState<Date | null>(null);
  const [todayImageCount, setTodayImageCount] = useState(0);
  // Decrypted image blob URLs: messageId → objectURL (resolved from encrypted storage)
  const [decryptedImages, setDecryptedImages] = useState<Record<string, string>>({});
  // Voice state
  const [uploadingVoice, setUploadingVoice] = useState(false);
  const [todayVoiceSeconds, setTodayVoiceSeconds] = useState(0);
  const [voiceLimitOpen, setVoiceLimitOpen] = useState(false);
  const [voiceLimitResetAt, setVoiceLimitResetAt] = useState<Date | null>(null);
  const [voiceLimitRemaining, setVoiceLimitRemaining] = useState(0);
  // Unread divider: timestamp of the last message seen before this session opened
  const [unreadSinceTs, setUnreadSinceTs] = useState<number | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingClearRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Map of message id → DOM ref for scroll-to-original
  const msgRefsMap = useRef<Map<string, HTMLDivElement>>(new Map());
  // Track which message IDs have already triggered a sound (prevents double-play)
  const playedSoundIds = useRef<Set<string>>(new Set());
  // Timestamp (ms) when the current conversation was opened — sound only plays
  // for messages that arrive AFTER this moment (i.e. live incoming, not unread backlog)
  const conversationOpenedAt = useRef<number>(0);
  // Capture deterrence — context-menu suppression + visibility overlay
  const { containerProps: captureDeterrenceProps, overlayVisible } = useCaptureDeterrence();

  // Unlock Web Audio on first user interaction (satisfies browser autoplay policy)
  useEffect(() => {
    const unlock = () => unlockAudio();
    window.addEventListener('click', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    return () => {
      window.removeEventListener('click', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);

  // Resolve encrypted image blobs for any message that has imageStoragePath + imageKeyBase64
  // but no decrypted URL yet. Fetches a signed URL, downloads the ciphertext, decrypts
  // with AES-256-GCM, and stores the resulting blob: URL in decryptedImages.
  useEffect(() => {
    const pending = messages.filter(
      m => m.imageStoragePath && m.imageKeyBase64 && !decryptedImages[m.id]
    );
    if (pending.length === 0) return;

    let cancelled = false;
    const newUrls: Record<string, string> = {};

    (async () => {
      await Promise.allSettled(
        pending.map(async m => {
          try {
            const blobUrl = await fetchAndDecryptChatImage(m.imageStoragePath!, m.imageKeyBase64!);
            if (!cancelled) newUrls[m.id] = blobUrl;
          } catch (err) {
            console.error('[ShadowCrypt] Failed to decrypt image for message', m.id, err);
          }
        })
      );
      if (!cancelled && Object.keys(newUrls).length > 0) {
        setDecryptedImages(prev => ({ ...prev, ...newUrls }));
      }
    })();

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    messagesEndRef.current?.scrollIntoView({ behavior });
  }, []);

  const scrollToMessage = useCallback((id: string) => {
    const el = msgRefsMap.current.get(id);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // Brief highlight flash
      el.classList.add('ring-2', 'ring-primary/50', 'rounded-2xl', 'transition-all');
      setTimeout(() => el.classList.remove('ring-2', 'ring-primary/50', 'rounded-2xl', 'transition-all'), 1200);
    } else {
      toast.info('Original message no longer available.');
    }
  }, []);

  const handleReply = useCallback((msg: LocalMessage) => {
    const snippet = msg.content?.trim()
      ? msg.content.slice(0, 80) + (msg.content.length > 80 ? '…' : '')
      : msg.imageUrl ? '' : '';
    setReplyingTo({
      id: msg.id,
      senderId: msg.senderId,
      senderUsername: msg.senderUsername,
      snippet,
      imageUrl: msg.imageUrl ?? null,
    });
    textareaRef.current?.focus();
  }, []);

  // Fix: pre-seed playedSoundIds with all message IDs loaded from DB so
  // historical messages never trigger a sound when switching conversations.
  useEffect(() => {
    if (!conversation) { setMessages([]); setRemoteTyping(false); setContactBio(null); setUnreadSinceTs(null); return; }
    setLoadingMessages(true);
    setRemoteTyping(false);
    setContactBio(null);
    // Load mute preference for this conversation
    setMutedState(isMuted(conversation.id));
    // Reset played-sound tracking and record when this conversation was opened.
    // Only messages arriving AFTER this timestamp will trigger a sound.
    playedSoundIds.current.clear();
    conversationOpenedAt.current = Date.now();

    // Read the timestamp of the last-seen message before opening this chat.
    // We record this *before* loading so the divider marks messages the user
    // hadn't seen yet (i.e. arrived since the previous visit).
    const lastSeenKey = `sc_last_seen:${conversation.id}`;
    const savedTs = parseInt(localStorage.getItem(lastSeenKey) ?? '0', 10) || null;
    setUnreadSinceTs(savedTs);

    getMessagesFromDB(currentUserId, conversation.id)
      .then(msgs => {
        // Pre-seed all loaded message IDs as "already heard" so switching
        // conversations never re-triggers the sound for existing messages.
        msgs.forEach(m => playedSoundIds.current.add(m.id));
        setMessages(msgs);
        // Persist the newest message timestamp as the new "last seen"
        const latest = msgs.reduce<number>((max, m) => Math.max(max, m.timestamp), 0);
        if (latest > 0) localStorage.setItem(lastSeenKey, String(latest));
        setTimeout(() => scrollToBottom('auto'), 50);
      })
      .catch(() => setMessages([]))
      .finally(() => setLoadingMessages(false));
    if (conversation.type === 'direct' && conversation.contact?.id) {
      supabase
        .from('profiles')
        .select('bio, avatar_url, avatar_private')
        .eq('id', conversation.contact.id)
        .maybeSingle()
        .then(({ data }) => setContactBio(data?.bio ?? null));
    }
  }, [conversation?.id, currentUserId]);

  // Subscribe to typing indicators for current conversation
  useEffect(() => {
    if (!conversation || conversation.type !== 'direct') return;
    const unsub = subscribeToTyping(conversation.id, currentUserId, () => {
      setRemoteTyping(true);
      if (typingClearRef.current) clearTimeout(typingClearRef.current);
      typingClearRef.current = setTimeout(() => setRemoteTyping(false), 3000);
    });
    return () => {
      unsub();
      if (typingClearRef.current) clearTimeout(typingClearRef.current);
    };
  }, [conversation?.id, currentUserId]);

  // Subscribe to Realtime messages for instant delivery
  useEffect(() => {
    if (!conversation) return;
    const lastSeenKey = `sc_last_seen:${conversation.id}`;
    const unsub = subscribeToMessages(currentUserId, conversation.id, (msg) => {
      setMessages(prev => {
        const existing = prev.find(m => m.id === msg.id);
        if (existing) {
          if (!existing.imageUrl && msg.imageUrl) {
            return prev.map(m => m.id === msg.id ? { ...m, imageUrl: msg.imageUrl } : m);
          }
          return prev;
        }
        // Play sound only for messages that arrived AFTER this conversation was opened
        // (i.e. truly live — not unread backlog from while the user was elsewhere)
        if (!msg.isOwn && !playedSoundIds.current.has(msg.id) && !isDND() && !isMuted(conversation.id) && msg.timestamp >= conversationOpenedAt.current) {
          playedSoundIds.current.add(msg.id);
          playNotificationSound();
        }
        return [...prev, msg];
      });
      // Mark this message as seen immediately — the user is actively viewing this
      // conversation, so update sc_last_seen so it won't appear as "New Messages"
      // on the next visit.
      const stored = parseInt(localStorage.getItem(lastSeenKey) ?? '0', 10) || 0;
      if (msg.timestamp > stored) {
        localStorage.setItem(lastSeenKey, String(msg.timestamp));
      }
      setRemoteTyping(false);
    });
    return unsub;
  }, [conversation?.id, currentUserId]);

  useEffect(() => {
    if (!conversation || incomingMessages.length === 0) return;
    const relevant = incomingMessages.filter(m => m.conversationId === conversation.id);
    if (relevant.length === 0) return;
    setMessages(prev => {
      const idMap = new Map(prev.map(m => [m.id, m]));
      let changed = false;
      const merged = prev.map(m => {
        const incoming = relevant.find(r => r.id === m.id);
        if (incoming && !m.imageUrl && incoming.imageUrl) {
          changed = true;
          return { ...m, imageUrl: incoming.imageUrl };
        }
        return m;
      });
      const newMsgs = relevant.filter(m => !idMap.has(m.id));
      // Play sound only for messages that arrived AFTER this conversation was opened
      newMsgs.forEach(m => {
        if (!m.isOwn && !playedSoundIds.current.has(m.id) && !isDND() && !isMuted(conversation.id) && m.timestamp >= conversationOpenedAt.current) {
          playedSoundIds.current.add(m.id);
          playNotificationSound();
        }
      });
      if (newMsgs.length > 0) return [...merged, ...newMsgs];
      return changed ? merged : prev;
    });
    setRemoteTyping(false);
  }, [incomingMessages, conversation]);

  useEffect(() => { scrollToBottom(); }, [messages, scrollToBottom]);

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    // Throttle typing broadcasts: only send once per 1.5s
    if (conversation?.type === 'direct' && conversation.contact?.id) {
      if (typingTimeoutRef.current) return;
      broadcastTyping(conversation.id, currentUserId, currentUsername);
      typingTimeoutRef.current = setTimeout(() => {
        typingTimeoutRef.current = null;
      }, 1500);
    }
  };

  // Load today's image count when conversation changes
  useEffect(() => {
    if (!currentUserId) return;
    getTodayImageCount(currentUserId).then(setTodayImageCount).catch(() => {});
  }, [currentUserId, conversation?.id]);

  // Load today's voice duration when conversation changes
  useEffect(() => {
    if (!currentUserId) return;
    getTodayVoiceDuration(currentUserId).then(setTodayVoiceSeconds).catch(() => {});
  }, [currentUserId, conversation?.id]);

  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Reset input so same file can be re-selected
    e.target.value = '';
    if (todayImageCount >= IMAGE_DAILY_LIMIT) {
      const reset = new Date();
      reset.setUTCHours(24, 0, 0, 0);
      setImageLimitResetAt(reset);
      setImageLimitOpen(true);
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      toast.error('Image must be under 10 MB.');
      return;
    }
    setSelectedImage(file);
    setImagePreview(URL.createObjectURL(file));
  };

  const clearSelectedImage = () => {
    setSelectedImage(null);
    if (imagePreview) { URL.revokeObjectURL(imagePreview); }
    setImagePreview(null);
  };

  const handleSend = async () => {
    const text = input.trim();
    if (!text && !selectedImage) return;
    if (!conversation || sending || uploadingImage) return;

    const contact = contacts.find(c => c.id === conversation.contact?.id);
    if (!contact) { toast.error('Contact not found.'); return; }

    const tempId = crypto.randomUUID();
    let imageAttachment: { storagePath: string; imageKeyBase64: string } | undefined;

    if (selectedImage) {
      setUploadingImage(true);
      try {
        imageAttachment = await uploadChatImage(currentUserId, selectedImage);
        setTodayImageCount(c => c + 1);
      } catch (err) {
        if (err instanceof ImageLimitError) {
          setImageLimitResetAt(err.resetAt);
          setImageLimitOpen(true);
        } else {
          toast.error('Image upload failed. Please try again.');
        }
        setUploadingImage(false);
        return;
      }
      setUploadingImage(false);
    }

    // Capture and clear reply context before sending
    const currentReply = replyingTo;
    setSending(true);
    const optimistic: LocalMessage = {
      id: tempId,
      conversationId: conversation.id,
      senderId: currentUserId,
      senderUsername: currentUsername,
      content: text,
      timestamp: Date.now(),
      status: 'sent',
      isOwn: true,
      imageUrl: null,
      imageStoragePath: imageAttachment?.storagePath ?? null,
      imageKeyBase64: imageAttachment?.imageKeyBase64 ?? null,
      replyTo: currentReply,
      voiceStoragePath: null,
      voiceKeyBase64: null,
      voiceDuration: null,
    };
    setMessages(prev => [...prev, optimistic]);
    setInput('');
    setReplyingTo(null);
    clearSelectedImage();
    textareaRef.current?.focus();

    try {
      await sendEncryptedMessage(
        currentUserId, currentUsername, contact.id,
        conversation.id, text, contact.publicKey, tempId, imageAttachment, currentReply
      );
      setMessages(prev => prev.map(m => m.id === tempId ? { ...m, status: 'delivered' } : m));
      onMessageSent();
    } catch (err) {
      setMessages(prev => prev.map(m => m.id === tempId ? { ...m, status: 'failed' } : m));
      const msg = (err as Error).message ?? '';
      if (msg.startsWith('LEGACY_KEY_FORMAT')) {
        toast.error('Cannot send message', {
          description: `@${contact.username} needs to re-login to update their encryption key.`,
        });
      } else {
        toast.error('Failed to send. Please try again.');
      }
      console.error('[ShadowCrypt] Send error:', err);
    } finally {
      setSending(false);
    }
  };

  /** Called by VoiceRecordButton when a recording is ready to upload and send. */
  const handleVoiceRecorded = useCallback(async (blob: Blob, durationSeconds: number, mimeType: string) => {
    if (!conversation || uploadingVoice) return;
    const contact = contacts.find(c => c.id === conversation.contact?.id);
    if (!contact) { toast.error('Contact not found.'); return; }

    const tempId = crypto.randomUUID();
    setUploadingVoice(true);

    let voiceAttachment: { storagePath: string; voiceKeyBase64: string; voiceDuration: number } | undefined;
    try {
      voiceAttachment = await uploadVoiceMessage(currentUserId, blob, durationSeconds, mimeType);
      setTodayVoiceSeconds(s => s + durationSeconds);
    } catch (err) {
      if (err instanceof VoiceLimitError) {
        setVoiceLimitResetAt(err.resetAt);
        setVoiceLimitRemaining(err.remainingSeconds);
        setVoiceLimitOpen(true);
      } else {
        toast.error('Voice upload failed. Please try again.');
      }
      setUploadingVoice(false);
      return;
    }
    setUploadingVoice(false);

    // Add optimistic voice message
    const optimistic: LocalMessage = {
      id: tempId,
      conversationId: conversation.id,
      senderId: currentUserId,
      senderUsername: currentUsername,
      content: '',
      timestamp: Date.now(),
      status: 'sent',
      isOwn: true,
      imageUrl: null,
      imageStoragePath: null,
      imageKeyBase64: null,
      replyTo: null,
      voiceStoragePath: voiceAttachment.storagePath,
      voiceKeyBase64: voiceAttachment.voiceKeyBase64,
      voiceDuration: voiceAttachment.voiceDuration,
    };
    setMessages(prev => [...prev, optimistic]);

    try {
      await sendEncryptedMessage(
        currentUserId, currentUsername, contact.id,
        conversation.id, '', contact.publicKey, tempId,
        undefined, null, voiceAttachment
      );
      setMessages(prev => prev.map(m => m.id === tempId ? { ...m, status: 'delivered' } : m));
      onMessageSent();
    } catch (err) {
      setMessages(prev => prev.map(m => m.id === tempId ? { ...m, status: 'failed' } : m));
      const msg = (err as Error).message ?? '';
      if (msg.startsWith('LEGACY_KEY_FORMAT')) {
        toast.error('Cannot send voice message', {
          description: `@${contact.username} needs to re-login to update their encryption key.`,
        });
      } else {
        toast.error('Failed to send voice message. Please try again.');
      }
      console.error('[ShadowCrypt] Voice send error:', err);
    }
  }, [conversation, contacts, currentUserId, currentUsername, uploadingVoice, onMessageSent]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Group messages by date
  const groupedMessages = messages.reduce<{ date: string; messages: LocalMessage[] }[]>((acc, msg) => {
    const date = formatDate(msg.timestamp);
    const last = acc[acc.length - 1];
    if (last && last.date === date) last.messages.push(msg);
    else acc.push({ date, messages: [msg] });
    return acc;
  }, []);

  // ── Empty state ──
  if (!conversation) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-background p-8">
        <div className="text-center max-w-xs space-y-4">
          <div className="w-16 h-16 rounded-full bg-primary/10 border border-primary/15 flex items-center justify-center mx-auto">
            <MessageSquare className="w-7 h-7 text-primary/60" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-foreground text-balance">Your Messages</h2>
            <p className="text-sm text-muted-foreground mt-1 text-pretty">
              Select a contact from the sidebar to start a conversation.
            </p>
          </div>
          <div className="flex flex-col gap-2 text-xs text-muted-foreground pt-2">
            {[
              { icon: <Shield className="w-3.5 h-3.5 text-primary shrink-0" />, label: 'End-to-end encrypted with Signal Double Ratchet' },
              { icon: <Lock className="w-3.5 h-3.5 text-primary shrink-0" />, label: 'Messages stored only in your local encrypted vault' },
              { icon: <Key className="w-3.5 h-3.5 text-primary shrink-0" />, label: 'Zero-knowledge relay — server sees only ciphertext' },
            ].map(({ icon, label }) => (
              <div key={label} className="flex items-center gap-2">
                {icon}
                <span>{label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const contactObj = contacts.find(c => c.id === conversation.contact?.id);

  // Block messaging if request is still pending
  const isOutgoingPending =
    conversation.type === 'direct' &&
    pendingRequests.some(r => r.receiver_id === conversation.contact?.id && r.sender_id === currentUserId);
  const isIncomingPending =
    conversation.type === 'direct' &&
    pendingRequests.some(r => r.sender_id === conversation.contact?.id && r.receiver_id === currentUserId);
  const isRequestPending = isOutgoingPending || isIncomingPending;

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden bg-background" onContextMenu={captureDeterrenceProps.onContextMenu}>

      {/* ── Capture deterrence overlay ── */}
      {overlayVisible && (
        <div className="absolute inset-0 z-[100] bg-background/95 backdrop-blur-sm flex flex-col items-center justify-center gap-4 pointer-events-none select-none">
          <Lock className="w-10 h-10 text-primary" />
          <p className="text-sm font-semibold text-foreground text-balance text-center px-8">
            Chat content hidden
          </p>
          <p className="text-xs text-muted-foreground text-center px-8 text-pretty">
            Content is hidden while this window is not in focus. Note: OS-level screen capture cannot be blocked by a web app.
          </p>
        </div>
      )}

      {/* ── Chat header ── */}
      <div className="shrink-0 flex items-center gap-3 px-4 py-3 border-b border-border bg-card">
        {/* Back button — always on mobile; on desktop only when sidebar is collapsed */}
        {onBack && (
          <button
            onClick={onBack}
            className={`w-8 h-8 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0 ${sidebarCollapsed ? 'flex' : 'md:hidden'}`}
            aria-label="Back to contacts"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
        )}
        <div className="w-9 h-9 rounded-full bg-muted border border-border flex items-center justify-center shrink-0">
          <span className="text-sm font-semibold text-foreground">{conversation.name.charAt(0).toUpperCase()}</span>
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-foreground truncate">
            <span className="text-muted-foreground">@</span>
            {conversation.name}
          </p>
          <div className="flex items-center gap-1.5 min-h-4">
            {remoteTyping ? (
              <span className="text-xs text-primary animate-pulse">typing…</span>
            ) : contactBio ? (
              <span className="text-xs text-muted-foreground truncate">{contactBio}</span>
            ) : (
              <span className="badge-encrypted">
                <Shield className="w-2.5 h-2.5" />
                E2E Encrypted
              </span>
            )}
          </div>
        </div>

        {/* Mute toggle */}
        <button
          type="button"
          onClick={() => {
            if (!conversation) return;
            const next = !muted;
            setMuted(conversation.id, next);
            setMutedState(next);
            toast.success(next ? 'Notifications muted for this chat.' : 'Notifications unmuted.');
          }}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors shrink-0 px-2 py-1 rounded-lg hover:bg-muted"
          aria-label={muted ? 'Unmute notifications' : 'Mute notifications'}
          title={muted ? 'Unmute notifications' : 'Mute notifications'}
        >
          {muted
            ? <BellOff className="w-3.5 h-3.5" />
            : <Bell className="w-3.5 h-3.5" />
          }
        </button>

        {/* Fingerprint info */}
        {contactObj && (
          <Popover>
            <PopoverTrigger asChild>
              <button className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors shrink-0 px-2 py-1 rounded-lg hover:bg-muted">
                <Key className="w-3.5 h-3.5" />
                <span className="hidden md:inline">Fingerprint</span>
                <Info className="w-3 h-3" />
              </button>
            </PopoverTrigger>
            <PopoverContent side="bottom" align="end" className="w-80 p-4 text-sm">
              <p className="font-semibold text-foreground mb-2 flex items-center gap-2">
                <Key className="w-4 h-4 text-primary" />
                Verify Contact Fingerprint
              </p>
              <p className="text-xs text-muted-foreground mb-1.5">Their key fingerprint (stored locally):</p>
              <p className="fingerprint mb-3">{contactObj.fingerprint}</p>
              <p className="text-xs text-muted-foreground text-pretty">
                Ask <strong>@{contactObj.username}</strong> to share their fingerprint from the sidebar
                (Account → View Key Fingerprint). If both match, your chat is genuinely E2E encrypted
                with no man-in-the-middle.
              </p>
            </PopoverContent>
          </Popover>
        )}
      </div>

      {/* ── Message list ── */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden min-h-0 px-4 py-4 space-y-4">
        {loadingMessages ? (
          <div className="flex items-center justify-center h-full">
            <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-center">
            <div className="w-12 h-12 rounded-full bg-primary/10 border border-primary/15 flex items-center justify-center">
              <Lock className="w-5 h-5 text-primary/60" />
            </div>
            <div>
              <p className="text-sm font-medium text-foreground">No messages yet</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Messages are end-to-end encrypted and never stored on our servers.
              </p>
            </div>
          </div>
        ) : (
          groupedMessages.map(group => (
            <div key={group.date} className="w-full space-y-1.5">
              {/* Date separator */}
              <div className="flex items-center gap-3 py-2">
                <div className="flex-1 h-px bg-border" />
                <span className="text-xs text-muted-foreground bg-background px-2 shrink-0">{group.date}</span>
                <div className="flex-1 h-px bg-border" />
              </div>

              <div className="w-full space-y-1">
                {group.messages.map((msg, idx) => {
                  const isSelf = msg.senderId === currentUserId || msg.isOwn === true;
                  const prevMsg = idx > 0 ? group.messages[idx - 1] : null;
                  const showAvatar = !prevMsg || prevMsg.senderId !== msg.senderId;
                  const senderInitial = (msg.senderUsername ?? '?').charAt(0).toUpperCase();
                  // Show the red "New Messages" divider above the first message
                  // that arrived after the last-seen timestamp AND before this
                  // conversation was opened (i.e. it was waiting, not live).
                  // Messages that arrive via Realtime while the chat is open have
                  // timestamp >= conversationOpenedAt.current — excluding them
                  // prevents a false-positive divider for messages the user is
                  // actively watching arrive in real time.
                  const showUnreadDivider =
                    !msg.isOwn &&
                    unreadSinceTs !== null &&
                    msg.timestamp > unreadSinceTs &&
                    msg.timestamp < conversationOpenedAt.current &&
                    (idx === 0 || group.messages[idx - 1].timestamp <= unreadSinceTs);
                  return (
                    <div
                      key={msg.id}
                      ref={(el) => {
                        if (el) msgRefsMap.current.set(msg.id, el);
                        else msgRefsMap.current.delete(msg.id);
                      }}
                    >
                      {showUnreadDivider && (
                        <div className="flex items-center gap-3 py-2 my-1">
                          <div className="flex-1 h-px bg-destructive/50" />
                          <span className="text-xs font-semibold text-destructive shrink-0 px-2 bg-background">
                            New Messages
                          </span>
                          <div className="flex-1 h-px bg-destructive/50" />
                        </div>
                      )}
                      <MessageBubble
                        message={msg}
                        isSelf={isSelf}
                        showAvatar={showAvatar}
                        senderInitial={senderInitial}
                        onReply={handleReply}
                        onScrollTo={scrollToMessage}
                        decryptedImageUrl={decryptedImages[msg.id] ?? null}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* ── Input area ── */}
      <div className="shrink-0 border-t border-border bg-card px-4 py-3">
        {/* Typing indicator strip — shown above the input when remote is typing */}
        {remoteTyping && !isRequestPending && (
          <div className="flex items-center gap-1.5 mb-2 px-1">
            <span className="flex gap-0.5">
              {[0, 1, 2].map(i => (
                <span
                  key={i}
                  className="w-1.5 h-1.5 rounded-full bg-primary animate-bounce"
                  style={{ animationDelay: `${i * 0.15}s` }}
                />
              ))}
            </span>
            <span className="text-xs text-primary font-medium">
              @{conversation.name} is typing…
            </span>
          </div>
        )}

        {isRequestPending ? (
          <div className="flex items-center gap-2.5 bg-amber-500/10 border border-amber-500/25 rounded-xl px-4 py-3">
            <Clock className="w-4 h-4 text-amber-500 shrink-0" />
            <p className="text-sm text-amber-600 dark:text-amber-400 text-pretty">
              {isOutgoingPending
                ? `Waiting for @${conversation.name} to accept your contact request.`
                : `Accept @${conversation.name}'s request in the sidebar to start messaging.`}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {/* Reply preview bar */}
            {replyingTo && (
              <ReplyPreviewBar
                replyTo={replyingTo}
                onCancel={() => setReplyingTo(null)}
              />
            )}

            {/* Image preview strip */}
            {imagePreview && (
              <div className="flex items-start gap-2 bg-muted/60 border border-border rounded-xl px-3 py-2">
                <div className="relative shrink-0">
                  <img
                    src={imagePreview}
                    alt="Selected"
                    className="w-16 h-16 rounded-lg object-cover border border-border"
                  />
                  <button
                    onClick={clearSelectedImage}
                    className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center hover:bg-destructive/80 transition-colors"
                    aria-label="Remove image"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-foreground truncate">{selectedImage?.name}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {selectedImage ? `${(selectedImage.size / 1024).toFixed(0)} KB` : ''}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {IMAGE_DAILY_LIMIT - todayImageCount} image{IMAGE_DAILY_LIMIT - todayImageCount === 1 ? '' : 's'} remaining today
                  </p>
                </div>
              </div>
            )}

            <div className="flex items-end gap-2">
              {/* Hidden file input */}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/gif,image/webp,image/heic"
                className="sr-only"
                onChange={handleImageSelect}
                aria-label="Attach image"
              />
              {/* Image attach button */}
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploadingImage || sending || uploadingVoice}
                className="w-10 h-10 rounded-xl flex items-center justify-center text-muted-foreground hover:text-primary hover:bg-muted transition-colors shrink-0 disabled:opacity-40"
                aria-label="Attach image"
                title={`Attach image (${IMAGE_DAILY_LIMIT - todayImageCount}/${IMAGE_DAILY_LIMIT} remaining today)`}
              >
                {uploadingImage
                  ? <span className="w-4 h-4 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                  : <ImageIcon className="w-5 h-5" />
                }
              </button>
              {/* Voice record button */}
              {uploadingVoice ? (
                <div className="w-10 h-10 flex items-center justify-center shrink-0">
                  <span className="w-4 h-4 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                </div>
              ) : (
                <VoiceRecordButton
                  onRecordingComplete={handleVoiceRecorded}
                  usedSecondsToday={todayVoiceSeconds}
                  disabled={sending || uploadingImage}
                />
              )}

              <Textarea
                ref={textareaRef}
                value={input}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                placeholder="Message..."
                className="flex-1 min-w-0 bg-muted border-border text-foreground placeholder:text-muted-foreground resize-none min-h-[44px] max-h-32 px-3 py-2.5 text-sm leading-relaxed rounded-xl"
                rows={1}
              />
              <Button
                onClick={handleSend}
                disabled={(!input.trim() && !selectedImage) || sending || uploadingImage || uploadingVoice}
                size="icon"
                className="w-10 h-10 rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 shrink-0"
                aria-label="Send"
              >
                {sending
                  ? <span className="w-4 h-4 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />
                  : <Send className="w-4 h-4" />}
              </Button>
            </div>
          </div>
        )}
        {!isRequestPending && (
          <p className="text-xs text-muted-foreground mt-1.5 flex items-center gap-1">
            <Lock className="w-2.5 h-2.5 shrink-0" />
            AES-256-GCM encrypted · Enter to send · Shift+Enter for new line
          </p>
        )}
      </div>

      {/* Image limit dialog */}
      <ImageLimitDialog
        open={imageLimitOpen}
        resetAt={imageLimitResetAt}
        onClose={() => setImageLimitOpen(false)}
      />
      {/* Voice limit dialog */}
      <VoiceLimitDialog
        open={voiceLimitOpen}
        resetAt={voiceLimitResetAt}
        remainingSeconds={voiceLimitRemaining}
        onClose={() => setVoiceLimitOpen(false)}
      />
    </div>
  );
}
