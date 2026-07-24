import { generateUUID } from "@/lib/uuid";
import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import {
  Shield, Lock, Key, Send, MessageSquare,
  AlertCircle, Clock, ArrowLeft, ImageIcon, X, Reply, Bell, BellOff, Paperclip,
  Pencil, Trash2, MoreHorizontal, MoreVertical, ShieldAlert, ShieldCheck,
  Pin, PinOff, Eye, Timer,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/components/ui/alert-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { ConversationPreview, LocalMessage, Contact, ContactRequest, ReplyTo, MessageReaction, KeyChangeAlert } from '@/types/types';
import {
  getMessagesFromDB, subscribeToMessages, updateMessageContentInDB, markMessageDeletedForEveryoneInDB,
  updateContactPublicKey, deleteMessageForMeInDB, clearConversationForMeInDB,
  consumeViewOnceMessageInDB, pinMessageForMe, unpinMessageForMe,
  pinMessageForEveryone, unpinMessageForEveryone, getPersonalPins, getConversationPins,
} from '@/lib/dbStore';
import {
  sendEncryptedMessage,
  uploadChatImage, ImageLimitError, getTodayImageCount, fetchAndDecryptChatImage,
  uploadVoiceMessage, VoiceLimitError, getTodayVoiceDuration,
  uploadChatFile, FileLimitError, getTodayFileBytes, FILE_DAILY_LIMIT_BYTES,
  addReaction, removeReaction, fetchReactionsForConversation, subscribeToReactions,
  sendEditedMessage, sendDeleteForEveryone, MESSAGE_EDIT_WINDOW_MS,
} from '@/lib/relay';
import { broadcastTyping, subscribeToTyping } from '@/lib/relay';
import { queueMessage, isOfflineError, dequeueMessage, getPendingMessages, OutboxItem } from '@/lib/outboxQueue';
import { supabase } from '@/db/supabase';
import { computeFingerprint } from '@/lib/crypto';
import { ReplyPreviewBar } from './ReplyPreviewBar';
import { QuotedMessage } from './QuotedMessage';
import { VoiceRecordButton } from './VoiceRecordButton';
import { VoiceWaveform } from './VoiceWaveform';
import { VoiceMessageBubble } from './VoiceMessageBubble';
import { FileAttachmentButton } from './FileAttachmentButton';
import { FileAttachmentBubble } from './FileAttachmentBubble';
import { ReactionBar } from './ReactionBar';
import { EmojiReactionPicker } from './EmojiReactionPicker';
import { playNotificationSound, unlockAudio, isMuted, setMuted, isDND } from '@/lib/notificationSound';
import { useCaptureDeterrence } from '@/hooks/use-capture-deterrence';
import { VOICE_DAILY_LIMIT_SECONDS } from '@/lib/voiceRecorder';
import { addFrequentEmoji } from '@/lib/emojiStore';
import { TypingIndicator } from './TypingIndicator';
import { LinkPreview, extractFirstUrl } from './LinkPreview';

// Client-side daily image limit (mirrors the server-side RPC threshold).
const IMAGE_DAILY_LIMIT = 10;

interface ChatAreaProps {
  conversation: ConversationPreview | null;
  currentUserId: string;
  currentUsername: string;
  incomingMessages: LocalMessage[];
  contacts: Contact[];
  pendingRequests: ContactRequest[];
  /**
   * Key-change alerts raised by the periodic contact key refresh.
   * ChatArea shows a blocking AlertDialog for the active contact when its entry
   * appears here, preventing any message from being sent until the user
   * explicitly trusts the new key or dismisses.
   */
  keyChangeAlerts?: KeyChangeAlert[];
  /** Called after the user acknowledges or dismisses an alert for contactId. */
  onKeyChangeAlertDismissed?: (contactId: string) => void;
  onMessageSent: () => void;
  onBack?: () => void;
  sidebarCollapsed?: boolean;
  /**
   * Called after incoming messages for the current conversation have been
   * merged into the displayed message list. ChatPage uses this to remove the
   * consumed entries from the shared incomingMessages array so the array stays
   * small and mutations are never re-applied on subsequent renders.
   */
  onMessagesConsumed?: (conversationId: string) => void;
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
  onReact: (msg: LocalMessage, emoji: string, alreadyReacted?: boolean) => void;
  currentUserId: string;
  onEdit: (msg: LocalMessage) => void;
  onDelete: (msg: LocalMessage) => void;
  onDeleteForMe: (msg: LocalMessage) => void;
  onPinForMe: (msg: LocalMessage) => void;
  onPinForEveryone: (msg: LocalMessage) => void;
  onUnpinForMe: (msg: LocalMessage) => void;
  onUnpinForEveryone: (msg: LocalMessage) => void;
  onViewOnceOpen: (msg: LocalMessage) => void;
  isPinnedForMe: boolean;
  isPinnedForEveryone: boolean;
  pinnedBy?: string;
}

function MessageBubble({
  message, isSelf, showAvatar, senderInitial, onReply, onScrollTo, decryptedImageUrl, onReact, currentUserId,
  onEdit, onDelete, onDeleteForMe, onPinForMe, onPinForEveryone, onUnpinForMe, onUnpinForEveryone,
  onViewOnceOpen, isPinnedForMe, isPinnedForEveryone, pinnedBy,
}: MessageBubbleProps) {
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

  // Within the 5-minute edit/delete window (own, non-deleted messages only)
  const withinWindow = isSelf && !message.isDeletedForEveryone &&
    (Date.now() - message.timestamp) < MESSAGE_EDIT_WINDOW_MS;
  // Only plain-text messages can be edited (no media)
  const canEdit = withinWindow && !message.imageStoragePath && !message.imageUrl &&
    !message.voiceStoragePath && !message.fileStoragePath && !!message.content;
  const canDelete = withinWindow;

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

      {/* Reply button — visible on hover (desktop); disabled for view-once messages */}
      {!message.isViewOnce && (
        <button
          type="button"
          aria-label="Reply"
          onClick={() => onReply(message)}
          className={`shrink-0 self-center w-7 h-7 flex items-center justify-center rounded-full text-muted-foreground hover:text-primary hover:bg-muted transition-all duration-150 ${
            showReplyBtn ? 'opacity-100 scale-100' : 'opacity-0 scale-75 pointer-events-none'
          } order-last`}
        >
          <Reply className="w-3.5 h-3.5" />
        </button>
      )}

      {/* Emoji reaction picker — visible on hover; disabled for view-once messages */}
      {!message.isViewOnce && (
        <div className={`shrink-0 self-center transition-all duration-150 ${
          showReplyBtn ? 'opacity-100 scale-100' : 'opacity-0 scale-75 pointer-events-none'
        } order-last`}>
          <EmojiReactionPicker onSelect={emoji => onReact(message, emoji)} />
        </div>
      )}

      {/* Options dropdown — own messages */}
      {isSelf && !message.isDeletedForEveryone && (
        <div className={`shrink-0 self-center transition-all duration-150 ${
          showReplyBtn ? 'opacity-100 scale-100' : 'opacity-0 scale-75 pointer-events-none'
        } order-last`}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Message options"
                className="w-7 h-7 flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              >
                <MoreHorizontal className="w-3.5 h-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              {canEdit && (
                <DropdownMenuItem onClick={() => onEdit(message)} className="gap-2 cursor-pointer">
                  <Pencil className="w-3.5 h-3.5" />
                  Edit
                </DropdownMenuItem>
              )}
              {!message.isDeletedForEveryone && !message.isViewOnce && (
                <>
                  {isPinnedForMe ? (
                    <DropdownMenuItem onClick={() => onUnpinForMe(message)} className="gap-2 cursor-pointer">
                      <PinOff className="w-3.5 h-3.5" />
                      Unpin for me
                    </DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem onClick={() => onPinForMe(message)} className="gap-2 cursor-pointer">
                      <Pin className="w-3.5 h-3.5" />
                      Pin for me
                    </DropdownMenuItem>
                  )}
                  {isPinnedForEveryone ? (
                    pinnedBy === currentUserId && (
                      <DropdownMenuItem onClick={() => onUnpinForEveryone(message)} className="gap-2 cursor-pointer">
                        <PinOff className="w-3.5 h-3.5" />
                        Unpin for everyone
                      </DropdownMenuItem>
                    )
                  ) : (
                    <DropdownMenuItem onClick={() => onPinForEveryone(message)} className="gap-2 cursor-pointer">
                      <Pin className="w-3.5 h-3.5" />
                      Pin for everyone
                    </DropdownMenuItem>
                  )}
                </>
              )}
              {canDelete && (
                <DropdownMenuItem
                  onClick={() => onDelete(message)}
                  className="gap-2 cursor-pointer text-destructive focus:text-destructive"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Delete for all
                </DropdownMenuItem>
              )}
              {!message.isDeletedForEveryone && (
                <DropdownMenuItem
                  onClick={() => onDeleteForMe(message)}
                  className="gap-2 cursor-pointer text-muted-foreground focus:text-foreground"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Delete for me
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}

      {/* Delete-for-me option on received messages (always visible on hover) */}
      {!isSelf && !message.isDeletedForEveryone && (
        <div className={`shrink-0 self-center transition-all duration-150 ${
          showReplyBtn ? 'opacity-100 scale-100' : 'opacity-0 scale-75 pointer-events-none'
        } order-last`}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Message options"
                className="w-7 h-7 flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              >
                <MoreHorizontal className="w-3.5 h-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-48">
              {!message.isDeletedForEveryone && !message.isViewOnce && (
                <>
                  {isPinnedForMe ? (
                    <DropdownMenuItem onClick={() => onUnpinForMe(message)} className="gap-2 cursor-pointer">
                      <PinOff className="w-3.5 h-3.5" />
                      Unpin for me
                    </DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem onClick={() => onPinForMe(message)} className="gap-2 cursor-pointer">
                      <Pin className="w-3.5 h-3.5" />
                      Pin for me
                    </DropdownMenuItem>
                  )}
                  {isPinnedForEveryone ? (
                    pinnedBy === currentUserId && (
                      <DropdownMenuItem onClick={() => onUnpinForEveryone(message)} className="gap-2 cursor-pointer">
                        <PinOff className="w-3.5 h-3.5" />
                        Unpin for everyone
                      </DropdownMenuItem>
                    )
                  ) : (
                    <DropdownMenuItem onClick={() => onPinForEveryone(message)} className="gap-2 cursor-pointer">
                      <Pin className="w-3.5 h-3.5" />
                      Pin for everyone
                    </DropdownMenuItem>
                  )}
                </>
              )}
              <DropdownMenuItem
                onClick={() => onDeleteForMe(message)}
                className="gap-2 cursor-pointer text-muted-foreground focus:text-foreground"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Delete for me
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}

      <div className={`min-w-0 max-w-[75%] flex flex-col gap-0.5 ${isSelf ? 'items-end' : 'items-start'}`}>
        {/* Deleted-for-everyone tombstone */}
        {message.isDeletedForEveryone ? (
          <div className={`px-3 py-2 rounded-2xl text-sm leading-relaxed italic text-muted-foreground border border-border/60 ${
            isSelf ? 'rounded-br-sm' : 'rounded-bl-sm'
          }`}>
            This message was deleted
          </div>
        ) : message.isViewOnce && message.viewOnceConsumed ? (
          <div className={`px-3 py-2 rounded-2xl text-sm leading-relaxed italic text-muted-foreground border border-dashed border-border/60 ${
            isSelf ? 'rounded-br-sm' : 'rounded-bl-sm'
          }`}>
            <Eye className="w-3.5 h-3.5 inline mr-1.5" />
            View once message viewed
          </div>
        ) : message.isViewOnce && !isSelf ? (
          <button
            type="button"
            onClick={() => onViewOnceOpen(message)}
            className={`px-4 py-3 rounded-2xl text-sm leading-relaxed border border-dashed border-border/60 bg-muted/30 hover:bg-muted/60 transition-colors ${
              isSelf ? 'rounded-br-sm' : 'rounded-bl-sm'
            }`}
          >
            <Eye className="w-4 h-4 inline mr-2 align-text-bottom" />
            View once message — tap to view
          </button>
        ) : (
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
          {/* File attachment — decrypt + download on click */}
          {message.fileStoragePath && message.fileKeyBase64 && message.fileName && (
            <FileAttachmentBubble
              storagePath={message.fileStoragePath}
              fileKey={message.fileKeyBase64}
              fileName={message.fileName}
              fileSize={message.fileSize ?? 0}
              mimeType={message.fileMimeType ?? 'application/octet-stream'}
              isSelf={isSelf}
            />
          )}
          {message.content && (
            <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{message.content}</p>
          )}
          {/* Client-side link preview — only for plain text messages with a URL */}
          {message.content && !message.imageStoragePath && !message.voiceStoragePath && !message.fileStoragePath && !message.isDeletedForEveryone && (() => {
            const url = extractFirstUrl(message.content);
            return url ? <LinkPreview url={url} /> : null;
          })()}
        </div>
        )}

        {/* Reaction bar — only for non-deleted messages */}
        {!message.isDeletedForEveryone && (message.reactions ?? []).length > 0 && (
          <ReactionBar
            reactions={message.reactions!}
            currentUserId={currentUserId}
            onToggle={(emoji, alreadyReacted) => onReact(message, emoji, alreadyReacted)}
          />
        )}

        <div className={`flex items-center gap-1 px-1 ${isSelf ? 'flex-row-reverse' : 'flex-row'}`}>
          <span className="text-xs text-muted-foreground tabular-nums">{formatTime(message.timestamp)}</span>
          {message.isEdited && !message.isDeletedForEveryone && (
            <span className="text-xs text-muted-foreground/70 italic">edited</span>
          )}
          {message.status === 'failed' && isSelf && (
            <AlertCircle className="w-3 h-3 text-destructive" />
          )}
          {message.status === 'queued' && isSelf && (
            <Clock className="w-3 h-3 text-muted-foreground" />
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

// ── Safety number popover ─────────────────────────────────────────────────────
/**
 * Shows a shared "safety number" derived from BOTH parties' public keys, sorted
 * lexicographically before hashing so both sides always compute the same value.
 * Replace the old single-key fingerprint which showed different values on each
 * end (hash of A's key for B, hash of B's key for A).
 */
export function ChatArea({
  conversation,
  currentUserId,
  currentUsername,
  incomingMessages,
  contacts,
  pendingRequests,
  keyChangeAlerts = [],
  onKeyChangeAlertDismissed,
  onMessageSent,
  onBack,
  sidebarCollapsed = false,
  onMessagesConsumed,
}: ChatAreaProps) {
  const [messages, setMessages] = useState<LocalMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [remoteTyping, setRemoteTyping] = useState(false);
  
  const [isRecording, setIsRecording] = useState(false);
  const [recordingAnalyser, setRecordingAnalyser] = useState<AnalyserNode | null>(null);

  const handleRecordingStateChange = useCallback((recording: boolean, analyser?: AnalyserNode) => {
    setIsRecording(recording);
    setRecordingAnalyser(analyser || null);
  }, []);
  const [contactBio, setContactBio] = useState<string | null>(null);
  const [contactAvatarUrl, setContactAvatarUrl] = useState<string | null>(null);
  const [contactAvatarPrivate, setContactAvatarPrivate] = useState(false);
  // Reply state
  const [replyingTo, setReplyingTo] = useState<ReplyTo | null>(null);
  // Mute state (per-conversation, persisted in localStorage)
  const [muted, setMutedState] = useState(false);
  // Clear-chat confirmation dialog
  const [clearChatOpen, setClearChatOpen] = useState(false);
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
  // File attachment state
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadingFile, setUploadingFile] = useState(false);
  const [fileLimitOpen, setFileLimitOpen] = useState(false);
  const [fileLimitResetAt, setFileLimitResetAt] = useState<Date | null>(null);
  const [fileLimitRemaining, setFileLimitRemaining] = useState(0);
  const [todayFileBytes, setTodayFileBytes] = useState(0);
  // Reactions state: messageId → MessageReaction[]
  const [reactions, setReactions] = useState<Record<string, MessageReaction[]>>({});
  // Unread divider: timestamp of the last message seen before this session opened
  const [unreadSinceTs, setUnreadSinceTs] = useState<number | null>(null);
  // Edit state
  const [editingMessage, setEditingMessage] = useState<LocalMessage | null>(null);
  const [editInput, setEditInput] = useState('');
  /**
   * Live key-change alert for the ACTIVE contact only.
   * Populated from the keyChangeAlerts prop when the active conversation's
   * contact has a pending alert, and also by the per-conversation live check
   * that fires once when the conversation is opened.
   */
  const [activeKeyAlert, setActiveKeyAlert] = useState<KeyChangeAlert | null>(null);
  // View-once send toggle
  const [sendAsViewOnce, setSendAsViewOnce] = useState(false);
  const [viewOnceMsg, setViewOnceMsg] = useState<LocalMessage | null>(null);
  // Disappearing-message TTL (seconds) — 0 means permanent
  const [ttlSeconds, setTtlSeconds] = useState<number>(0);
  const [ttlDialogOpen, setTtlDialogOpen] = useState(false);
  const [customTtlInput, setCustomTtlInput] = useState('');
  const [customTtlError, setCustomTtlError] = useState<string | null>(null);
  const MAX_TTL_SECONDS = 99 * 60 * 60; // 99 hours
  const TTL_OPTIONS: { label: string; value: number }[] = [
    { label: 'Off', value: 0 },
    { label: '5m', value: 5 * 60 },
    { label: '1h', value: 60 * 60 },
    { label: '1d', value: 24 * 60 * 60 },
    { label: '1w', value: 7 * 24 * 60 * 60 },
    { label: 'Custom', value: -1 },
  ];

  const formatSecondsAsHms = (seconds: number): string => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  const parseHmsToSeconds = (value: string): { seconds: number; error: string | null } => {
    const trimmed = value.trim();
    if (!trimmed) return { seconds: 0, error: 'Enter a time in HH:MM:SS.' };
    const parts = trimmed.split(':');
    if (parts.length !== 3) {
      return { seconds: 0, error: 'Use HH:MM:SS format (e.g. 02:30:00).' };
    }
    const [hStr, mStr, sStr] = parts;
    const h = parseInt(hStr, 10);
    const m = parseInt(mStr, 10);
    const s = parseInt(sStr, 10);
    if (
      Number.isNaN(h) || Number.isNaN(m) || Number.isNaN(s) ||
      m < 0 || m > 59 || s < 0 || s > 59 || h < 0
    ) {
      return { seconds: 0, error: 'Invalid time. Hours ≥0, minutes and seconds 0-59.' };
    }
    const seconds = h * 3600 + m * 60 + s;
    if (seconds === 0) return { seconds: 0, error: 'Timer must be greater than 0.' };
    if (seconds > MAX_TTL_SECONDS) {
      return { seconds: 0, error: `Maximum timer is ${Math.floor(MAX_TTL_SECONDS / 3600)} hours.` };
    }
    return { seconds, error: null };
  };

  const applyCustomTtl = () => {
    const { seconds, error } = parseHmsToSeconds(customTtlInput);
    if (error) {
      setCustomTtlError(error);
      return;
    }
    setCustomTtlError(null);
    setTtlSeconds(seconds);
    setTtlDialogOpen(false);
  };

  const openTtlDialog = () => {
    setCustomTtlInput(formatSecondsAsHms(ttlSeconds || 0));
    setCustomTtlError(null);
    setTtlDialogOpen(true);
  };
  // Pinned message IDs for this conversation
  const [personalPinIds, setPersonalPinIds] = useState<Set<string>>(new Set());
  const [conversationPins, setConversationPins] = useState<Map<string, string>>(new Map());
  const [pinPanelOpen, setPinPanelOpen] = useState(false);
  const editTextareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingClearRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const msgRefsMap = useRef<Map<string, HTMLDivElement>>(new Map());
  const playedSoundIds = useRef<Set<string>>(new Set());
  const conversationOpenedAt = useRef<number>(0);
  const { containerProps: captureDeterrenceProps, overlayVisible } = useCaptureDeterrence();
  const navigate = useNavigate();

  // Unlock Web Audio on first user interaction (satisfies browser autoplay policy)
  useEffect(() => {
    const unlock = () => unlockAudio();
    window.addEventListener('click', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    return () => {      window.removeEventListener('click', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);

  // Global keyboard shortcut: focus the message input.
  useEffect(() => {
    const handle = () => textareaRef.current?.focus();
    window.addEventListener('focus-message-input', handle);
    return () => window.removeEventListener('focus-message-input', handle);
  }, []);

  // Offline outbox queue: drain queued messages when the network returns.
  const processOutbox = useCallback(async () => {
    if (!currentUserId || !currentUsername || !conversation) return;
    const pending = await getPendingMessages();
    const forThisConv = pending.filter(p => p.conversationId === conversation.id);
    for (const item of forThisConv) {
      try {
        const finalMsg = await sendEncryptedMessage(
          item.senderId,
          item.senderUsername,
          item.recipientId,
          item.conversationId,
          item.content,
          item.recipientPublicKey,
          item.id,
          item.imageAttachment,
          item.replyTo ?? null,
          item.voiceAttachment,
          item.fileAttachment,
          item.isViewOnce,
          item.ttlSeconds ?? null
        );
        await dequeueMessage(item.id);
        setMessages(prev => prev.map(m => m.id === item.id ? finalMsg : m).sort((a, b) => a.timestamp - b.timestamp));
      } catch (err) {
        if (!isOfflineError(err)) {
          await dequeueMessage(item.id);
          setMessages(prev => prev.map(m => m.id === item.id ? { ...m, status: 'failed' } : m));
        }
      }
    }
  }, [currentUserId, currentUsername, conversation]);

  useEffect(() => {
    const handleOnline = () => { processOutbox().catch(() => {}); };
    window.addEventListener('online', handleOnline);
    processOutbox().catch(() => {});
    return () => window.removeEventListener('online', handleOnline);
  }, [processOutbox]);

  // ── Self-destructing message cleanup ──────────────────────────────────────
  // Messages with expiresAt must disappear from the active chat automatically
  // without waiting for a re-fetch.  Check on mount/when the conversation
  // changes and then every 30 seconds.
  useEffect(() => {
    if (!conversation) return;
    const filterExpired = () => {
      const nowMs = Date.now();
      setMessages(prev => {
        const filtered = prev.filter(m => !m.expiresAt || m.expiresAt > nowMs);
        return filtered.length === prev.length ? prev : filtered;
      });
    };
    filterExpired();
    const interval = setInterval(filterExpired, 30_000);
    return () => clearInterval(interval);
  }, [conversation?.id]);

  // ── Key-change detection ──────────────────────────────────────────────────
  // 1. Lift any matching alert from the parent's keyChangeAlerts prop into
  //    local state when the active conversation changes.
  const activeContactId = conversation?.contact?.id ?? null;
  useEffect(() => {
    if (!activeContactId) { setActiveKeyAlert(null); return; }
    const match = keyChangeAlerts.find(a => a.contactId === activeContactId);
    setActiveKeyAlert(match ?? null);
  }, [activeContactId, keyChangeAlerts]);

  // 2. Per-conversation live check: once when a conversation is opened, fetch
  //    the contact's current public key from profiles and compare to the stored
  //    key.  This catches a key change that happened BEFORE the last refresh.
  useEffect(() => {
    if (!activeContactId || !conversation) return;
    const contact = contacts.find(c => c.id === activeContactId);
    if (!contact) return;
    let cancelled = false;
    (async () => {
      try {
        const { data } = await supabase
          .from('public_profiles')
          .select('public_key')
          .eq('id', activeContactId)
          .maybeSingle();
        const liveKey = data?.public_key as string | null;
        if (!liveKey || cancelled) return;
        if (liveKey === contact.publicKey) return; // no change
        const [oldFP, newFP] = await Promise.all([
          computeFingerprint(contact.publicKey),
          computeFingerprint(liveKey),
        ]);
        if (!cancelled) {
          setActiveKeyAlert({
            contactId: activeContactId,
            username: contact.username,
            oldFingerprint: oldFP,
            newFingerprint: newFP,
            newPublicKey: liveKey,
          });
        }
      } catch { /* non-fatal — user can still read; alert shown on next refresh */ }
    })();
    return () => { cancelled = true; };
  // Only re-run when the active contact changes, not on every contact-list update
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeContactId]);

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
            console.error('[SylvaCrypt] Failed to decrypt image for message', m.id, err);
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

    // Load pins for this conversation
    (async () => {
      const [personal, shared] = await Promise.all([
        getPersonalPins(currentUserId, conversation.id),
        getConversationPins(conversation.id),
      ]);
      setPersonalPinIds(new Set(personal.map(p => p.messageId)));
      setConversationPins(new Map(shared.map(p => [p.messageId, p.pinnedBy])));
    })();

    getMessagesFromDB(currentUserId, conversation.id)
      .then(({ messages: msgs, truncated }) => {
        // Pre-seed all loaded message IDs as "already heard" so switching
        // conversations never re-triggers the sound for existing messages.
        msgs.forEach(m => playedSoundIds.current.add(m.id));
        const sorted = msgs.slice().sort((a, b) => a.timestamp - b.timestamp);
        setMessages(sorted);
        if (truncated) {
          toast.warning('Only the most recent 500 messages are shown. Older messages exist but are not displayed.');
        }
        // Persist the newest message timestamp as the new "last seen"
        const latest = msgs.reduce<number>((max, m) => Math.max(max, m.timestamp), 0);
        if (latest > 0) localStorage.setItem(lastSeenKey, String(latest));
        setTimeout(() => scrollToBottom('auto'), 50);
      })
      .catch(() => setMessages([]))
      .finally(() => setLoadingMessages(false));
    if (conversation.type === 'direct' && conversation.contact?.id) {
      supabase
        .from('public_profiles')
        .select('bio, avatar_url, avatar_private')
        .eq('id', conversation.contact.id)
        .maybeSingle()
        .then(({ data }) => {
          setContactBio(data?.bio ?? null);
          setContactAvatarUrl(data?.avatar_url ?? null);
          setContactAvatarPrivate(data?.avatar_private ?? false);
        });
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

  // Subscribe to shared conversation pins so "Pin for everyone" updates
  // instantly on all participants' devices.
  useEffect(() => {
    if (!conversation) return;
    const channel = supabase
      .channel(`conversation-pins:${conversation.id}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'conversation_pins',
          filter: `conversation_id=eq.${conversation.id}`,
        },
        (payload) => {
          const msgId = (payload.new as { message_id?: string }).message_id;
          if (msgId) {
            setConversationPins(prev => {
              if (prev.has(msgId)) return prev;
              const newPinnedBy = (payload.new as { pinned_by?: string }).pinned_by || '';
              return new Map(prev).set(msgId, newPinnedBy);
            });
          }
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'DELETE',
          schema: 'public',
          table: 'conversation_pins',
          filter: `conversation_id=eq.${conversation.id}`,
        },
        (payload) => {
          const msgId = (payload.old as { message_id?: string }).message_id;
          if (msgId) {
            setConversationPins(prev => {
              if (!prev.has(msgId)) return prev;
              const next = new Map(prev);
              next.delete(msgId);
              return next;
            });
          }
        }
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [conversation?.id]);

  // Subscribe to Realtime messages for instant delivery
  useEffect(() => {
    if (!conversation) return;
    const lastSeenKey = `sc_last_seen:${conversation.id}`;
    const unsub = subscribeToMessages(
      currentUserId,
      conversation.id,
      (msg) => {
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
          return [...prev, msg].sort((a, b) => a.timestamp - b.timestamp);
        });
        // Mark this message as seen immediately — the user is actively viewing this
        // conversation, so update sc_last_seen so it won't appear as "New Messages"
        // on the next visit.
        const stored = parseInt(localStorage.getItem(lastSeenKey) ?? '0', 10) || 0;
        if (msg.timestamp > stored) {
          localStorage.setItem(lastSeenKey, String(msg.timestamp));
        }
        setRemoteTyping(false);
      },
      () => {
        // onReconnect: re-fetch messages in case we missed any while offline
        getMessagesFromDB(currentUserId, conversation.id)
          .then(({ messages: msgs }) => {
            setMessages(prev => {
              const prevMap = new Map(prev.map(m => [m.id, m]));
              msgs.forEach(m => prevMap.set(m.id, m));
              return Array.from(prevMap.values()).sort((a, b) => a.timestamp - b.timestamp);
            });
          });
      }
    );
    return unsub;
  }, [conversation?.id, currentUserId]);

  // Subscribe to pin changes for the current conversation
  useEffect(() => {
    if (!conversation) return;
    const sharedChannel = supabase
      .channel(`conversation-pins-${conversation.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'conversation_pins', filter: `conversation_id=eq.${conversation.id}` },
        async () => {
          const shared = await getConversationPins(conversation.id);
          setConversationPins(new Map(shared.map(p => [p.messageId, p.pinnedBy])));
        }
      )
      .subscribe();

    const personalChannel = supabase
      .channel(`personal-pins-${currentUserId}-${conversation.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'personal_pins', filter: `owner_id=eq.${currentUserId}` },
        async () => {
          const personal = await getPersonalPins(currentUserId, conversation.id);
          setPersonalPinIds(new Set(personal.map(p => p.messageId)));
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(sharedChannel);
      supabase.removeChannel(personalChannel);
    };
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
        if (!incoming) return m;
        if (incoming._mutationType === 'edit') {
          changed = true;
          return { ...m, content: incoming.content, isEdited: true, editedAt: incoming.editedAt };
        }
        if (incoming._mutationType === 'delete') {
          changed = true;
          return { ...m, isDeletedForEveryone: true, content: '' };
        }
        if (!m.imageUrl && incoming.imageUrl) {
          changed = true;
          return { ...m, imageUrl: incoming.imageUrl };
        }
        return m;
      });
      const newMsgs = relevant.filter(m => !idMap.has(m.id) && !m._mutationType);
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
    // Notify ChatPage that all incoming entries for this conversation have been
    // merged so it can prune them from the shared array, preventing re-application
    // of mutations and keeping the array small.
    onMessagesConsumed?.(conversation.id);
  }, [incomingMessages, conversation]);

  useEffect(() => { scrollToBottom(); }, [messages, scrollToBottom]);

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
// Typing indicator: respect the typing_disabled user preference
    if (conversation?.type === 'direct' && conversation.contact?.id) {
      const typingDisabled = localStorage.getItem('sc_typing_disabled') === '1';
      if (!typingDisabled) {
        if (typingTimeoutRef.current) return;
        broadcastTyping(conversation.id, currentUserId, currentUsername);
        typingTimeoutRef.current = setTimeout(() => {
          typingTimeoutRef.current = null;
        }, 1500);
      }
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

  // Load today's file bytes when conversation changes
  useEffect(() => {
    if (!currentUserId) return;
    getTodayFileBytes(currentUserId).then(setTodayFileBytes).catch(() => {});
  }, [currentUserId, conversation?.id]);

  // Load reactions for the current conversation; subscribe to live updates
  useEffect(() => {
    if (!conversation) { setReactions({}); return; }
    fetchReactionsForConversation(conversation.id).then(map => {
      const obj: Record<string, MessageReaction[]> = {};
      map.forEach((v, k) => { obj[k] = v; });
      setReactions(obj);
    }).catch(() => {});

    const unsub = subscribeToReactions(
      conversation.id,
      (reaction) => {
        setReactions(prev => {
          const existing = prev[reaction.messageId] ?? [];
          // Deduplicate: skip if a reaction with the same sender+emoji already
          // exists in local state. Handles both:
          // (a) the optimistic-update bounce-back (reactor receives their own
          //     broadcast/postgres event after the optimistic add), and
          // (b) dual-path delivery where broadcast AND postgres_changes both
          //     fire for the same event.
          const duplicate = existing.some(
            r => r.senderId === reaction.senderId && r.emoji === reaction.emoji
          );
          if (duplicate) return prev;
          return {
            ...prev,
            [reaction.messageId]: [...existing, reaction],
          };
        });
      },
      (reactionId, messageId, senderId, emoji) => {
        setReactions(prev => {
          const list = prev[messageId] ?? [];
          // Remove by DB id when available (postgres_changes path),
          // otherwise fall back to sender+emoji matching (broadcast path).
          const filtered = reactionId
            ? list.filter(r => r.id !== reactionId)
            : list.filter(r => !(r.senderId === senderId && r.emoji === emoji));
          return { ...prev, [messageId]: filtered };
        });
      }
    );
    return unsub;
  }, [conversation?.id]);

  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
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

  /** Called by FileAttachmentButton when a file is selected. */
  const handleFileSelected = useCallback((file: File) => {
    if (!conversation || uploadingFile) return;

    // Pre-check quota client-side for fast feedback
    if (todayFileBytes + file.size > FILE_DAILY_LIMIT_BYTES) {
      const reset = new Date();
      reset.setUTCHours(24, 0, 0, 0);
      setFileLimitResetAt(reset);
      setFileLimitRemaining(Math.max(0, FILE_DAILY_LIMIT_BYTES - todayFileBytes));
      setFileLimitOpen(true);
      return;
    }

    // Stage the file — upload + send happens when the user clicks Send
    setSelectedFile(file);
  }, [conversation, uploadingFile, todayFileBytes]);

  /** Open the edit bar pre-filled with the message's current content. */
  const handleStartEdit = useCallback((msg: LocalMessage) => {
    setEditingMessage(msg);
    setEditInput(msg.content);
    setTimeout(() => editTextareaRef.current?.focus(), 50);
  }, []);

  /** Confirm edit — updates local state, DB row, and sends relay notification. */
  const handleConfirmEdit = useCallback(async () => {
    if (!editingMessage || !conversation) return;
    const newText = editInput.trim();
    if (!newText || newText === editingMessage.content) {
      setEditingMessage(null); setEditInput(''); return;
    }
    const contact = contacts.find(c => c.id === conversation.contact?.id);
    if (!contact) return;
    const editedAt = Date.now();
    setMessages(prev => prev.map(m =>
      m.id === editingMessage.id ? { ...m, content: newText, isEdited: true, editedAt } : m
    ));
    setEditingMessage(null); setEditInput('');
    try {
      await updateMessageContentInDB(currentUserId, editingMessage.id, newText, editedAt);
      await sendEditedMessage(currentUserId, contact.id, conversation.id, editingMessage.id, newText, contact.publicKey);
    } catch (err) {
      toast.error('Failed to send edit. Message updated locally.');
      console.error('[SylvaCrypt] Edit send error:', err);
    }
  }, [editingMessage, editInput, conversation, contacts, currentUserId]);

  /** Delete a message for everyone — tombstones both sides via encrypted relay. */
  const handleDeleteForEveryone = useCallback(async (msg: LocalMessage) => {
    if (!conversation) return;
    const contact = contacts.find(c => c.id === conversation.contact?.id);
    if (!contact) return;
    setMessages(prev => prev.map(m =>
      m.id === msg.id ? { ...m, isDeletedForEveryone: true, content: '' } : m
    ));
    try {
      await markMessageDeletedForEveryoneInDB(currentUserId, msg.id);
      await sendDeleteForEveryone(currentUserId, contact.id, conversation.id, msg.id, contact.publicKey);
    } catch (err) {
      toast.error('Failed to delete message for everyone.');
      console.error('[SylvaCrypt] Delete error:', err);
      setMessages(prev => prev.map(m =>
        m.id === msg.id ? { ...m, isDeletedForEveryone: false, content: msg.content } : m
      ));
    }
  }, [conversation, contacts, currentUserId]);

  /** Delete a message only for the current user — no relay, local-only. */
  const handleDeleteForMe = useCallback(async (msg: LocalMessage) => {
    if (!conversation) return;
    setMessages(prev => prev.filter(m => m.id !== msg.id));
    try {
      await deleteMessageForMeInDB(currentUserId, msg.id);
    } catch (err) {
      toast.error('Failed to delete message.');
      console.error('[SylvaCrypt] DeleteForMe error:', err);
      setMessages(prev => [...prev, msg].sort((a, b) => a.timestamp - b.timestamp));
    }
  }, [conversation, currentUserId]);

  /** Pin a message for the current user only. */
  const handlePinForMe = useCallback(async (msg: LocalMessage) => {
    if (!conversation) return;
    try {
      await pinMessageForMe(currentUserId, conversation.id, msg.id);
      setPersonalPinIds(prev => new Set(prev).add(msg.id));
      toast.success('Pinned for me');
    } catch (err) {
      toast.error('Failed to pin message.');
      console.error('[SylvaCrypt] pinMessageForMe error:', err);
    }
  }, [conversation, currentUserId]);

  /** Unpin a personal pin. */
  const handleUnpinForMe = useCallback(async (msg: LocalMessage) => {
    if (!conversation) return;
    try {
      await unpinMessageForMe(currentUserId, conversation.id, msg.id);
      setPersonalPinIds(prev => {
        const next = new Set(prev);
        next.delete(msg.id);
        return next;
      });
      toast.success('Unpinned for me');
    } catch (err) {
      toast.error('Failed to unpin message.');
      console.error('[SylvaCrypt] unpinMessageForMe error:', err);
    }
  }, [conversation, currentUserId]);

  /** Pin a message for everyone in the conversation. */
  const handlePinForEveryone = useCallback(async (msg: LocalMessage) => {
    if (!conversation) return;
    try {
      await pinMessageForEveryone(conversation.id, msg.id, currentUserId);
      setConversationPins(prev => new Map(prev).set(msg.id, currentUserId));
      toast.success('Pinned for everyone');
    } catch (err) {
      toast.error('Failed to pin message.');
      console.error('[SylvaCrypt] pinMessageForEveryone error:', err);
    }
  }, [conversation, currentUserId]);

  /** Unpin a shared conversation pin. */
  const handleUnpinForEveryone = useCallback(async (msg: LocalMessage) => {
    if (!conversation) return;
    try {
      await unpinMessageForEveryone(conversation.id, msg.id);
      setConversationPins(prev => {
        const next = new Map(prev);
        next.delete(msg.id);
        return next;
      });
      toast.success('Unpinned for everyone');
    } catch (err) {
      toast.error('Failed to unpin message.');
      console.error('[SylvaCrypt] unpinMessageForEveryone error:', err);
    }
  }, [conversation]);

  /** Consume (open) a view-once message received from a contact. */
  const handleViewOnceOpen = useCallback((msg: LocalMessage) => {
    setViewOnceMsg(msg);
  }, []);

  const handleCloseViewOnce = useCallback(async () => {
    if (!viewOnceMsg || !conversation) return;
    try {
      await consumeViewOnceMessageInDB(currentUserId, viewOnceMsg.id);
      setMessages(prev => prev.map(m => m.id === viewOnceMsg.id ? { ...m, viewOnceConsumed: true, content: 'View once message viewed', imageUrl: undefined, voiceStoragePath: undefined, fileStoragePath: undefined } : m));
    } catch (err) {
      toast.error('Failed to consume view-once message.');
    } finally {
      setViewOnceMsg(null);
    }
  }, [viewOnceMsg, conversation, currentUserId]);

  /** Clear the entire conversation for the current user only. */
  const handleClearChat = useCallback(async () => {
    if (!conversation) return;
    setMessages([]);
    try {
      await clearConversationForMeInDB(currentUserId, conversation.id);
      toast.success('Chat cleared.');
    } catch (err) {
      toast.error('Failed to clear chat.');
      console.error('[SylvaCrypt] ClearChat error:', err);
    }
  }, [conversation, currentUserId]);

  /** Toggle (add or remove) an emoji reaction on a message. */
  const handleReact = useCallback(async (msg: LocalMessage, emoji: string, alreadyReacted?: boolean) => {
    if (!conversation) return;
    const contact = contacts.find(c => c.id === conversation.contact?.id);
    if (!contact) return;

    // Determine whether the current user already has this exact reaction
    const existingReaction = (reactions[msg.id] ?? [])
      .find(r => r.senderId === currentUserId && r.emoji === emoji);
    const shouldRemove = alreadyReacted ?? !!existingReaction;

    if (!shouldRemove) {
      addFrequentEmoji(emoji);
    }

    // Optimistic update
    if (shouldRemove) {
      setReactions(prev => ({
        ...prev,
        [msg.id]: (prev[msg.id] ?? []).filter(
          r => !(r.senderId === currentUserId && r.emoji === emoji)
        ),
      }));
      await removeReaction(msg.id, conversation.id, currentUserId, emoji);
    } else {
      const optimisticReaction: MessageReaction = {
        id: generateUUID(),
        messageId: msg.id,
        senderId: currentUserId,
        emoji,
        createdAt: Date.now(),
      };
      setReactions(prev => ({
        ...prev,
        [msg.id]: [...(prev[msg.id] ?? []), optimisticReaction],
      }));
      await addReaction(msg.id, conversation.id, currentUserId, contact.id, emoji);
    }
  }, [conversation, contacts, currentUserId, reactions]);

  const handleSend = async () => {
    const text = input.trim();
    if (!text && !selectedImage && !selectedFile) return;
    if (!conversation || sending || uploadingImage || uploadingFile) return;

    const contact = contacts.find(c => c.id === conversation.contact?.id);
    if (!contact) { toast.error('Contact not found.'); return; }

    // Block sending while a key-change alert is active for this contact.
    // The user must resolve the alert (trust or dismiss) before messages can flow.
    if (activeKeyAlert && activeKeyAlert.contactId === contact.id) {
      toast.error('Message blocked — key change not resolved.', {
        description: 'Review the security alert and verify the new key before sending.',
      });
      return;
    }

    const tempId = generateUUID();
    let imageAttachment: { storagePath: string; imageKeyBase64: string } | undefined;
    let fileAttachment: { storagePath: string; fileKeyBase64: string; fileName: string; fileSize: number; fileMimeType: string } | undefined;

    // Upload image if selected
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

    // Upload file if staged
    if (selectedFile) {
      setUploadingFile(true);
      try {
        fileAttachment = await uploadChatFile(currentUserId, selectedFile);
        setTodayFileBytes(b => b + selectedFile.size);
      } catch (err) {
        if (err instanceof FileLimitError) {
          setFileLimitResetAt(err.resetAt);
          setFileLimitRemaining(err.remainingBytes);
          setFileLimitOpen(true);
        } else {
          toast.error('File upload failed. Please try again.');
        }
        setUploadingFile(false);
        return;
      }
      setUploadingFile(false);
    }

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
      fileStoragePath: fileAttachment?.storagePath ?? null,
      fileKeyBase64: fileAttachment?.fileKeyBase64 ?? null,
      fileName: fileAttachment?.fileName ?? null,
      fileSize: fileAttachment?.fileSize ?? null,
      fileMimeType: fileAttachment?.fileMimeType ?? null,
      isViewOnce: sendAsViewOnce,
      viewOnceConsumed: false,
      ttlSeconds: ttlSeconds || null,
      expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null,
    };
    setMessages(prev => [...prev, optimistic].sort((a, b) => a.timestamp - b.timestamp));
    setInput('');
    setReplyingTo(null);
    setSendAsViewOnce(false);
    setTtlSeconds(0);
    clearSelectedImage();
    setSelectedFile(null);
    textareaRef.current?.focus();

    try {
      const finalMsg = await sendEncryptedMessage(
        currentUserId, currentUsername, contact.id,
        conversation.id, text, contact.publicKey, tempId,
        imageAttachment, currentReply, undefined, fileAttachment, sendAsViewOnce,
        ttlSeconds || null
      );
      setMessages(prev => prev.map(m => m.id === tempId ? finalMsg : m).sort((a, b) => a.timestamp - b.timestamp));
      onMessageSent();
    } catch (err) {
      const offline = isOfflineError(err);
      if (offline) {
        const item: OutboxItem = {
          id: tempId,
          conversationId: conversation.id,
          recipientId: contact.id,
          senderId: currentUserId,
          senderUsername: currentUsername,
          content: text,
          recipientPublicKey: contact.publicKey,
          createdAt: Date.now(),
          imageAttachment,
          fileAttachment,
          replyTo: currentReply,
          isViewOnce: sendAsViewOnce,
          ttlSeconds: ttlSeconds || null,
        };
        await queueMessage(item);
        setMessages(prev => prev.map(m => m.id === tempId ? { ...m, status: 'queued' } : m));
        toast.info('Message queued — will send automatically when you are back online.');
      } else {
        setMessages(prev => prev.map(m => m.id === tempId ? { ...m, status: 'failed' } : m));
        const msg = (err as Error).message ?? '';
        if (msg.startsWith('LEGACY_KEY_FORMAT')) {
          toast.error('Cannot send message', {
            description: `@${contact.username} needs to re-login to update their encryption key.`,
          });
        } else {
          toast.error('Failed to send. Please try again.');
        }
      }
      console.error('[SylvaCrypt] Send error:', err);
    } finally {
      setSending(false);
    }
  };

  /** Called by VoiceRecordButton when a recording is ready to upload and send. */
  const handleVoiceRecorded = useCallback(async (blob: Blob, durationSeconds: number, mimeType: string) => {
    if (!conversation || uploadingVoice) return;
    const contact = contacts.find(c => c.id === conversation.contact?.id);
    if (!contact) { toast.error('Contact not found.'); return; }

    const tempId = generateUUID();
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
      fileStoragePath: null,
      fileKeyBase64: null,
      fileName: null,
      fileSize: null,
      fileMimeType: null,
      ttlSeconds: ttlSeconds || null,
      expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null,
    };
    setMessages(prev => [...prev, optimistic].sort((a, b) => a.timestamp - b.timestamp));

    try {
      const finalMsg = await sendEncryptedMessage(
        currentUserId, currentUsername, contact.id,
        conversation.id, '', contact.publicKey, tempId,
        undefined, null, voiceAttachment, undefined, false,
        ttlSeconds || null
      );
      setMessages(prev => prev.map(m => m.id === tempId ? finalMsg : m).sort((a, b) => a.timestamp - b.timestamp));
      onMessageSent();
      setTtlSeconds(0);
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
      console.error('[SylvaCrypt] Voice send error:', err);
    }
  }, [conversation, contacts, currentUserId, currentUsername, uploadingVoice, onMessageSent]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Group messages by date, and attach live reactions to each message
  const groupedMessages = messages.reduce<{ date: string; messages: LocalMessage[] }[]>((acc, msg) => {
    const msgWithReactions: LocalMessage = {
      ...msg,
      reactions: reactions[msg.id] ?? [],
    };
    const date = formatDate(msg.timestamp);
    const last = acc[acc.length - 1];
    if (last && last.date === date) last.messages.push(msgWithReactions);
    else acc.push({ date, messages: [msgWithReactions] });
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
              { icon: <Shield className="w-3.5 h-3.5 text-primary shrink-0" />, label: 'End-to-end encrypted with Double Ratchet' },
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
    <div className="relative flex-1 flex flex-col min-w-0 overflow-hidden bg-background" onContextMenu={captureDeterrenceProps.onContextMenu}>

      {/* ── Key-change blocking AlertDialog ── */}
      <AlertDialog open={!!activeKeyAlert}>
        <AlertDialogContent className="max-w-[calc(100%-2rem)] md:max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-destructive">
              <ShieldAlert className="w-5 h-5 shrink-0" />
              Security Alert — Key Changed
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 text-sm text-muted-foreground">
                <p className="text-pretty">
                  <strong className="text-foreground">@{activeKeyAlert?.username}</strong>&apos;s
                  encryption key has changed since you last verified it. This may be a legitimate
                  device reset, or it could indicate that someone has replaced their key on the server.
                </p>
                <p className="text-pretty font-medium text-foreground/80">
                  Verify this change with <strong>@{activeKeyAlert?.username}</strong> through a
                  trusted out-of-band channel (e.g. scan their new QR code in person) before
                  trusting the new key.
                </p>
                <div className="rounded-lg border border-border bg-muted/40 p-3 space-y-2 text-xs font-mono">
                  <div>
                    <span className="text-muted-foreground block mb-0.5">Previous key fingerprint</span>
                    <span className="text-foreground/70 break-all">{activeKeyAlert?.oldFingerprint}</span>
                  </div>
                  <div className="border-t border-border pt-2">
                    <span className="text-muted-foreground block mb-0.5">New key fingerprint</span>
                    <span className="text-destructive/80 break-all">{activeKeyAlert?.newFingerprint}</span>
                  </div>
                </div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col-reverse sm:flex-row gap-2">
            <AlertDialogCancel
              onClick={() => {
                setActiveKeyAlert(null);
                onKeyChangeAlertDismissed?.(activeKeyAlert!.contactId);
              }}
            >
              Dismiss (keep blocking)
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-primary text-primary-foreground hover:bg-primary/90 flex items-center gap-2"
              onClick={async () => {
                if (!activeKeyAlert || !currentUserId) return;
                await updateContactPublicKey(currentUserId, activeKeyAlert.contactId, activeKeyAlert.newPublicKey);
                setActiveKeyAlert(null);
                onKeyChangeAlertDismissed?.(activeKeyAlert.contactId);
                toast.success(`Trusted new key for @${activeKeyAlert.username}.`, {
                  description: 'Future messages will use the updated encryption key.',
                });
              }}
            >
              <ShieldCheck className="w-4 h-4" />
              Trust New Key
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Clear chat confirmation dialog ── */}
      <AlertDialog open={clearChatOpen} onOpenChange={setClearChatOpen}>
        <AlertDialogContent className="max-w-[calc(100%-2rem)] md:max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>Clear chat?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete all messages in this conversation for you only.
              The other person's history will not be affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={async () => {
                setClearChatOpen(false);
                await handleClearChat();
              }}
            >
              Clear chat
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
        <div className="w-9 h-9 rounded-full bg-muted border border-border flex items-center justify-center shrink-0 overflow-hidden">
          {contactAvatarUrl && !contactAvatarPrivate ? (
            <img
              src={`${contactAvatarUrl}?t=${conversation.name}`}
              alt={conversation.name}
              className="w-full h-full object-cover"
            />
          ) : (
            <span className="text-sm font-semibold text-foreground">{conversation.name.charAt(0).toUpperCase()}</span>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-foreground truncate">
            <span className="text-muted-foreground">@</span>
            {conversation.name}
          </p>
          <div className="flex items-center gap-1.5 min-h-4">
            {remoteTyping ? (
              <span className="text-xs text-primary animate-pulse">•••</span>
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

        {/* Pinned messages panel toggle */}
        <button
          type="button"
          onClick={() => setPinPanelOpen(true)}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors shrink-0 px-2 py-1 rounded-lg hover:bg-muted"
          aria-label="Pinned messages"
          title="Pinned messages"
        >
          <Pin className="w-4 h-4" />
          {conversationPins.size + personalPinIds.size > 0 && (
            <span className="bg-primary text-primary-foreground text-[10px] px-1 rounded-full">
              {conversationPins.size + personalPinIds.size}
            </span>
          )}
        </button>

        {/* Chat header overflow menu: Clear chat + safety number */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Chat options"
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors shrink-0 px-2 py-1 rounded-lg hover:bg-muted"
            >
              <MoreVertical className="w-5 h-5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem
              onClick={() => {
                if (!conversation) return;
                const next = !muted;
                setMuted(conversation.id, next);
                setMutedState(next);
                toast.success(next ? 'Notifications muted for this chat.' : 'Notifications unmuted.');
              }}
              className="gap-2 cursor-pointer"
            >
              {muted ? <BellOff className="w-4 h-4" /> : <Bell className="w-4 h-4" />}
              {muted ? 'Unmute' : 'Mute'}
            </DropdownMenuItem>

            {contactObj && (
              <DropdownMenuItem
                onClick={(e) => {
                  e.preventDefault();
                  navigate(`/safety-number/${contactObj.id}`);
                }}
                className="gap-2 cursor-pointer"
              >
                <ShieldCheck className="w-4 h-4" />
                Verify
              </DropdownMenuItem>
            )}

            <DropdownMenuItem
              onClick={() => setClearChatOpen(true)}
              className="gap-2 cursor-pointer text-destructive focus:text-destructive"
            >
              <Trash2 className="w-4 h-4" />
              Clear chat
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* ── Message list ── */}
      {/* Key Change Unverified Warning */}
      {contactObj && contactObj.verifiedViaQR === false && contactObj.originalFingerprint && contactObj.originalFingerprint !== contactObj.fingerprint && !activeKeyAlert && (
        <div className="bg-destructive/10 text-destructive-foreground px-4 py-2 flex items-center justify-between shrink-0 border-b border-border text-sm">
          <div className="flex items-center gap-2 min-w-0">
            <ShieldAlert className="w-4 h-4 shrink-0" />
            <span className="truncate">Safety number changed. Verify to ensure encryption is secure.</span>
          </div>
          <a
            href={`/safety-number/${contactObj.id}`}
            onClick={e => { e.preventDefault(); navigate(`/safety-number/${contactObj.id}`); }}
            className="px-3 py-1 rounded bg-background/50 hover:bg-background/80 transition-colors shrink-0 text-xs font-medium"
          >
            Verify Now
          </a>
        </div>
      )}
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
                        onReact={handleReact}
                        currentUserId={currentUserId}
                        onEdit={handleStartEdit}
                        onDelete={handleDeleteForEveryone}
                        onDeleteForMe={handleDeleteForMe}
                        onPinForMe={handlePinForMe}
                        onPinForEveryone={handlePinForEveryone}
                        onUnpinForMe={handleUnpinForMe}
                        onUnpinForEveryone={handleUnpinForEveryone}
                        onViewOnceOpen={handleViewOnceOpen}
                        isPinnedForMe={personalPinIds.has(msg.id)}
                        isPinnedForEveryone={conversationPins.has(msg.id)}
                        pinnedBy={conversationPins.get(msg.id)}
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
        {/* Edit bar — shown while editing a message */}
        {editingMessage && (
          <div className="flex flex-col gap-2 mb-2">
            <div className="flex items-center justify-between px-1">
              <div className="flex items-center gap-1.5 text-xs font-medium text-primary">
                <Pencil className="w-3.5 h-3.5" />
                Edit message
              </div>
              <button type="button" onClick={() => { setEditingMessage(null); setEditInput(''); }} className="text-muted-foreground hover:text-foreground transition-colors" aria-label="Cancel edit">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="flex items-end gap-2">
              <Textarea
                ref={editTextareaRef}
                value={editInput}
                onChange={e => setEditInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleConfirmEdit(); }
                  if (e.key === 'Escape') { setEditingMessage(null); setEditInput(''); }
                }}
                className="flex-1 min-h-[40px] max-h-[120px] resize-none text-sm"
                placeholder="Edit your message…"
                rows={1}
              />
              <Button size="sm" onClick={handleConfirmEdit} disabled={!editInput.trim() || editInput.trim() === editingMessage.content} className="h-10 px-3 shrink-0">
                <Send className="w-4 h-4" />
              </Button>
            </div>
          </div>
        )}
        {/* Typing indicator strip — shown above the input when remote is typing */}
        {!editingMessage && remoteTyping && !isRequestPending && (
          <TypingIndicator name={`@${conversation.name}`} visible={remoteTyping} />
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

            {/* File preview strip — shown while a file is staged but not yet sent */}
            {selectedFile && (
              <div className="flex items-center gap-2 bg-muted/60 border border-border rounded-xl px-3 py-2">
                <Paperclip className="w-4 h-4 text-primary shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-foreground truncate">{selectedFile.name}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {(selectedFile.size / (1024 * 1024)).toFixed(1)} MB · Ready to send
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedFile(null)}
                  className="shrink-0 w-5 h-5 flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                  aria-label="Remove file"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )}

            <div className="flex items-end gap-2">
              {/* Hidden file input for images */}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/gif,image/webp,image/heic"
                className="sr-only"
                onChange={handleImageSelect}
                aria-label="Attach image"
              />
              {/* Image attach button (Desktop) */}
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploadingImage || sending || uploadingVoice || uploadingFile}
                className="hidden md:flex w-10 h-10 rounded-xl items-center justify-center text-muted-foreground hover:text-primary hover:bg-muted transition-colors shrink-0 disabled:opacity-40"
                aria-label="Attach image"
                title={`Attach image (${IMAGE_DAILY_LIMIT - todayImageCount}/${IMAGE_DAILY_LIMIT} remaining today)`}
              >
                {uploadingImage
                  ? <span className="w-4 h-4 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                  : <ImageIcon className="w-5 h-5" />
                }
              </button>
              
              {/* File attach button (Desktop) */}
              <div className="hidden md:block">
                <FileAttachmentButton
                  onFileSelected={handleFileSelected}
                  disabled={sending || uploadingImage || uploadingVoice}
                  uploading={uploadingFile}
                  remainingBytes={Math.max(0, FILE_DAILY_LIMIT_BYTES - todayFileBytes)}
                />
              </div>

              {/* View-once toggle (Desktop) */}
              <button
                type="button"
                onClick={() => setSendAsViewOnce(v => !v)}
                className={`hidden md:flex w-10 h-10 rounded-xl items-center justify-center transition-colors shrink-0 ${
                  sendAsViewOnce
                    ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                    : 'text-muted-foreground hover:text-primary hover:bg-muted'
                }`}
                aria-label={sendAsViewOnce ? 'Disable view-once' : 'Send view-once'}
                title={sendAsViewOnce ? 'View-once enabled' : 'View-once message'}
              >
                <Eye className="w-5 h-5" />
              </button>

              {/* Disappearing-message TTL button (Desktop) */}
              <button
                type="button"
                onClick={openTtlDialog}
                className={`hidden md:flex items-center h-10 px-2 gap-1.5 rounded-xl shrink-0 text-xs font-medium transition-colors ${
                  ttlSeconds > 0 ? 'text-primary bg-primary/10' : 'text-muted-foreground hover:bg-muted'
                }`}
                aria-label="Disappearing message timer"
                title="Set disappearing message timer"
              >
                <Timer className="w-4 h-4 shrink-0" />
                <span className="tabular-nums">
                  {ttlSeconds > 0 ? formatSecondsAsHms(ttlSeconds) : 'Off'}
                </span>
              </button>

              {/* Mobile "More" dropdown for attachments & view-once */}
              <div className={`md:hidden flex items-center ${isRecording ? '!hidden' : ''}`}>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      disabled={sending || uploadingVoice}
                      className="w-10 h-10 rounded-xl flex items-center justify-center text-muted-foreground hover:text-primary hover:bg-muted transition-colors shrink-0 disabled:opacity-40"
                      aria-label="More options"
                    >
                      <MoreVertical className="w-5 h-5" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-56" sideOffset={8}>
                    {/* Image Attach Dropdown Item */}
                    <DropdownMenuItem 
                      onClick={() => fileInputRef.current?.click()}
                      disabled={uploadingImage || sending || uploadingVoice || uploadingFile}
                      className="gap-3 py-3 cursor-pointer"
                    >
                      {uploadingImage ? (
                        <span className="w-4 h-4 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                      ) : (
                        <ImageIcon className="w-4 h-4" />
                      )}
                      <div className="flex flex-col gap-0.5">
                        <span className="font-medium text-sm">Image</span>
                        <span className="text-[10px] text-muted-foreground">{IMAGE_DAILY_LIMIT - todayImageCount} left today</span>
                      </div>
                    </DropdownMenuItem>

                    {/* File Attach Dropdown Item */}
                    <FileAttachmentButton
                      onFileSelected={handleFileSelected}
                      disabled={sending || uploadingImage || uploadingVoice}
                      uploading={uploadingFile}
                      remainingBytes={Math.max(0, FILE_DAILY_LIMIT_BYTES - todayFileBytes)}
                      className="relative flex cursor-default select-none items-center rounded-sm px-2 py-3 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50 w-full gap-3 cursor-pointer"
                    >
                      {uploadingFile ? (
                        <span className="w-4 h-4 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                      ) : (
                        <Paperclip className="w-4 h-4" />
                      )}
                      <div className="flex flex-col gap-0.5 items-start">
                        <span className="font-medium text-sm">File</span>
                        <span className="text-[10px] text-muted-foreground">
                          {Math.max(0, FILE_DAILY_LIMIT_BYTES - todayFileBytes) > 0 
                            ? `${(Math.max(0, FILE_DAILY_LIMIT_BYTES - todayFileBytes) / (1024 * 1024)).toFixed(0)} MB left` 
                            : 'Limit reached'}
                        </span>
                      </div>
                    </FileAttachmentButton>

                    {/* Disappearing messages Dropdown Item */}
                    <DropdownMenuItem
                      onClick={() => openTtlDialog()}
                      className="gap-3 py-3 cursor-pointer flex justify-between"
                    >
                      <div className="flex items-center gap-3">
                        <Timer className={`w-4 h-4 ${ttlSeconds > 0 ? 'text-primary' : ''}`} />
                        <div className="flex flex-col gap-0.5">
                          <span className="font-medium text-sm">Disappearing messages</span>
                          <span className="text-[10px] text-muted-foreground">
                            {ttlSeconds > 0 ? formatSecondsAsHms(ttlSeconds) : 'Off'}
                          </span>
                        </div>
                      </div>
                      {ttlSeconds > 0 && <div className="w-2 h-2 rounded-full bg-primary" />}
                    </DropdownMenuItem>

                    {/* View-once Dropdown Item */}
                    <DropdownMenuItem 
                      onClick={(e) => {
                        e.preventDefault(); // Don't close immediately if we want to show toggle
                        setSendAsViewOnce(v => !v);
                      }}
                      className="gap-3 py-3 cursor-pointer flex justify-between"
                    >
                      <div className="flex items-center gap-3">
                        <Eye className={`w-4 h-4 ${sendAsViewOnce ? 'text-primary' : ''}`} />
                        <span className="font-medium text-sm">One-Time View</span>
                      </div>
                      {sendAsViewOnce && <div className="w-2 h-2 rounded-full bg-primary" />}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>

              {/* Voice record button (Desktop) */}
              <div className="hidden md:block shrink-0">
                {uploadingVoice ? (
                  <div className="w-10 h-10 flex items-center justify-center shrink-0">
                    <span className="w-4 h-4 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                  </div>
                ) : (
                  <VoiceRecordButton
                    onRecordingComplete={handleVoiceRecorded}
                    usedSecondsToday={todayVoiceSeconds}
                    disabled={sending || uploadingImage || uploadingFile}
                    onRecordingStateChange={handleRecordingStateChange}
                  />
                )}
              </div>

              {isRecording ? (
                <div className="flex-1 min-w-0 bg-muted border border-border flex items-center justify-center h-[44px] px-3 py-2.5 rounded-xl overflow-hidden">
                  <VoiceWaveform analyser={recordingAnalyser} />
                </div>
              ) : (
                <Textarea
                  ref={textareaRef}
                  value={input}
                  onChange={handleInputChange}
                  onKeyDown={handleKeyDown}
                  placeholder={sendAsViewOnce ? 'View-once message...' : 'Message...'}
                  className="flex-1 min-w-0 bg-muted border-border text-foreground placeholder:text-muted-foreground resize-none min-h-[44px] max-h-32 px-3 py-2.5 text-sm leading-relaxed rounded-xl"
                  rows={1}
                />
              )}
              
              {/* Voice record button (Mobile - shows when empty or recording) */}
              <div className={`md:hidden shrink-0 ${(!input.trim() && !selectedImage && !selectedFile) || isRecording ? 'block' : 'hidden'}`}>
                {uploadingVoice ? (
                  <div 
                    className="w-10 h-10 flex items-center justify-center shrink-0 rounded-full"
                    style={{ backgroundColor: 'hsl(var(--send-btn, var(--primary)))' }}
                  >
                    <span className="w-4 h-4 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />
                  </div>
                ) : (
                  <VoiceRecordButton
                    onRecordingComplete={handleVoiceRecorded}
                    usedSecondsToday={todayVoiceSeconds}
                    disabled={sending || uploadingImage || uploadingFile}
                    onRecordingStateChange={handleRecordingStateChange}
                    className="w-10 h-10 rounded-full hover:opacity-90 shrink-0 flex items-center justify-center disabled:opacity-40"
                    style={{
                      backgroundColor: 'hsl(var(--send-btn, var(--primary)))',
                      color: 'hsl(var(--send-btn-foreground, var(--primary-foreground)))'
                    }}
                  />
                )}
              </div>

              {/* Send Button (Always on desktop, hidden on mobile when empty unless recording) */}
              <Button
                onClick={handleSend}
                disabled={(!input.trim() && !selectedImage && !selectedFile) || sending || uploadingImage || uploadingVoice || uploadingFile || isRecording}
                size="icon"
                style={{
                  backgroundColor: 'hsl(var(--send-btn, var(--primary)))',
                  color: 'hsl(var(--send-btn-foreground, var(--primary-foreground)))'
                }}
                className={`w-10 h-10 md:rounded-xl rounded-full hover:opacity-90 shrink-0 ${isRecording || (!input.trim() && !selectedImage && !selectedFile) ? 'hidden md:flex' : 'flex'}`}
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
            AES-256-GCM encrypted<span className="hidden md:inline"> · Enter to send · Shift+Enter for new line</span>
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
      {/* File limit dialog */}
      <Dialog open={fileLimitOpen} onOpenChange={setFileLimitOpen}>
        <DialogContent className="max-w-[calc(100%-2rem)] md:max-w-sm bg-card border-border">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-foreground">
              <Paperclip className="w-5 h-5 text-primary" />
              Daily File Limit Reached
            </DialogTitle>
            <DialogDescription className="text-muted-foreground text-pretty">
              You can upload up to <strong>60 MB of files per day</strong> to keep the service running smoothly.
              {fileLimitRemaining > 0 && (
                <> Only <strong>{(fileLimitRemaining / (1024 * 1024)).toFixed(1)} MB</strong> remaining today.</>
              )}
            </DialogDescription>
          </DialogHeader>
          {fileLimitResetAt && (
            <div className="flex items-center gap-2 bg-primary/5 border border-primary/20 rounded-lg px-3 py-2.5 text-sm">
              <Clock className="w-4 h-4 text-primary shrink-0" />
              <span className="text-foreground">
                Your limit resets today at <strong>
                  {fileLimitResetAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true })}
                </strong> (midnight UTC).
              </span>
            </div>
          )}
          <Button className="w-full bg-primary text-primary-foreground hover:bg-primary/90" onClick={() => setFileLimitOpen(false)}>
            Got it
          </Button>
        </DialogContent>
      </Dialog>

      {/* Pinned messages panel */}
      <Dialog open={pinPanelOpen} onOpenChange={setPinPanelOpen}>
        <DialogContent className="max-w-[calc(100%-2rem)] md:max-w-md bg-card border-border max-h-[80dvh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-foreground">
              <Pin className="w-5 h-5 text-primary" />
              Pinned Messages
            </DialogTitle>
            <DialogDescription className="text-muted-foreground text-pretty">
              Messages pinned for everyone appear for both users. Messages pinned for me are visible only on this device.
            </DialogDescription>
          </DialogHeader>
          <div className="overflow-y-auto min-h-0 space-y-2 mt-2">
            {Array.from(conversationPins.keys()).map(id => messages.find(m => m.id === id)).filter(Boolean).map(msg => (
              <div key={msg!.id} className="p-3 rounded-xl bg-muted/40 border border-border/60 text-sm">
                <div className="flex items-center justify-between gap-1 text-xs text-primary mb-1">
                  <div className="flex items-center gap-1">
                    <Pin className="w-3 h-3" /> Pinned for everyone
                    <span className="text-muted-foreground ml-1">
                      (by {conversationPins.get(msg!.id) === currentUserId ? 'You' : conversation?.name || 'Contact'})
                    </span>
                  </div>
                  {conversationPins.get(msg!.id) === currentUserId && (
                    <button
                      onClick={() => handleUnpinForEveryone(msg!)}
                      className="text-muted-foreground hover:text-destructive flex items-center gap-1 transition-colors"
                      title="Unpin"
                    >
                      <PinOff className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
                <p className="text-foreground whitespace-pre-wrap break-words">
                  {msg!.content || (msg!.imageStoragePath ? 'Image' : msg!.voiceStoragePath ? 'Voice' : msg!.fileStoragePath ? 'File' : '')}
                </p>
                <span className="text-xs text-muted-foreground">{formatTime(msg!.timestamp)}</span>
              </div>
            ))}
            {Array.from(personalPinIds).map(id => messages.find(m => m.id === id)).filter(Boolean).map(msg => (
              <div key={msg!.id} className="p-3 rounded-xl bg-muted/40 border border-border/60 border-dashed text-sm">
                <div className="flex items-center justify-between gap-1 text-xs text-muted-foreground mb-1">
                  <div className="flex items-center gap-1">
                    <Pin className="w-3 h-3" /> Pinned for me
                  </div>
                  <button
                    onClick={() => handleUnpinForMe(msg!)}
                    className="hover:text-destructive flex items-center gap-1 transition-colors"
                    title="Unpin"
                  >
                    <PinOff className="w-3.5 h-3.5" />
                  </button>
                </div>
                <p className="text-foreground whitespace-pre-wrap break-words">
                  {msg!.content || (msg!.imageStoragePath ? 'Image' : msg!.voiceStoragePath ? 'Voice' : msg!.fileStoragePath ? 'File' : '')}
                </p>
                <span className="text-xs text-muted-foreground">{formatTime(msg!.timestamp)}</span>
              </div>
            ))}
            {conversationPins.size === 0 && personalPinIds.size === 0 && (
              <p className="text-center text-sm text-muted-foreground py-8">No pinned messages yet.</p>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!viewOnceMsg} onOpenChange={(open) => { if (!open) handleCloseViewOnce(); }}>
        <DialogContent className="max-w-[calc(100%-2rem)] md:max-w-3xl bg-black/90 border-border max-h-[90dvh] flex flex-col p-4">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-white font-semibold">View Once Message</h2>
            <button onClick={handleCloseViewOnce} className="text-white/80 hover:text-white"><X className="w-6 h-6" /></button>
          </div>
          <div className="flex-1 overflow-auto flex items-center justify-center">
            {viewOnceMsg?.imageUrl && <img src={viewOnceMsg.imageUrl} className="max-w-full max-h-full object-contain" alt="View Once" />}
            {!viewOnceMsg?.imageUrl && decryptedImages[viewOnceMsg?.id ?? ''] && <img src={decryptedImages[viewOnceMsg!.id]} className="max-w-full max-h-full object-contain" alt="View Once" />}
            {viewOnceMsg?.content && !viewOnceMsg.imageUrl && !decryptedImages[viewOnceMsg?.id ?? ''] && <p className="text-white text-xl text-center whitespace-pre-wrap">{viewOnceMsg.content}</p>}
          </div>
          <p className="text-white/50 text-xs text-center mt-4">This message will be permanently destroyed when you close this window.</p>
        </DialogContent>
      </Dialog>

      {/* Disappearing-message timer dialog */}
      <Dialog open={ttlDialogOpen} onOpenChange={setTtlDialogOpen}>
        <DialogContent className="max-w-[calc(100%-2rem)] md:max-w-sm bg-card border-border">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Timer className="w-4 h-4 text-primary" />
              Disappearing messages
            </DialogTitle>
            <DialogDescription className="text-muted-foreground text-pretty">
              Choose how long new messages remain visible. Maximum is 99 hours.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {/* Preset options */}
            <div className="grid grid-cols-3 gap-2">
              {TTL_OPTIONS.filter(o => o.value >= 0).map(opt => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => { setTtlSeconds(opt.value); setTtlDialogOpen(false); }}
                  className={`px-2 py-2 rounded-lg text-xs font-medium transition-colors border ${
                    ttlSeconds === opt.value
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'bg-background text-foreground border-border hover:bg-muted'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            {/* Custom HH:MM:SS input */}
            <div className="space-y-1.5">
              <Label htmlFor="custom-ttl" className="text-xs text-muted-foreground">Custom (HH:MM:SS)</Label>
              <Input
                id="custom-ttl"
                value={customTtlInput}
                onChange={e => {
                  setCustomTtlInput(e.target.value);
                  setCustomTtlError(null);
                }}
                onKeyDown={e => { if (e.key === 'Enter') applyCustomTtl(); }}
                placeholder="02:30:00"
                className="bg-background border-border text-foreground font-mono tracking-wide"
                maxLength={9}
              />
              {customTtlError && (
                <p className="text-xs text-destructive">{customTtlError}</p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTtlDialogOpen(false)}>Cancel</Button>
            <Button onClick={applyCustomTtl}>Set custom timer</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
