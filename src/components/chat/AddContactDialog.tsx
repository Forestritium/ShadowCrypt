import { useState, useEffect } from 'react';
import { toast } from 'sonner';
import { UserPlus, AlertCircle, Shield, ShieldCheck, ShieldX, Key, Send, Clock } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { findUserByUsername, sendContactRequest, sendContactRequestViaQR, getRequestStatus } from '@/lib/relay';
import { computeFingerprint } from '@/lib/crypto';
import { supabase } from '@/db/supabase';

interface AddContactDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentUserId: string;
  /** The sender's own public key — written to their profile before submitting
   *  the request so the receiver can always retrieve it on acceptance. */
  myPublicKeyBase64?: string | null;
  prefillUsername?: string;
  /** QR token scanned from the contact's QR code — validated server-side when present. */
  prefillQrToken?: string | null;
  /**
   * Fingerprint embedded in the scanned QR code.
   * When present the app verifies it against the server's public key for this user
   * before allowing the contact request to proceed.
   */
  prefillQrFingerprint?: string | null;
  onContactAdded: () => void;
}

export function AddContactDialog({
  open,
  onOpenChange,
  currentUserId,
  myPublicKeyBase64,
  prefillUsername = '',
  prefillQrToken = null,
  prefillQrFingerprint = null,
  onContactAdded,
}: AddContactDialogProps) {
  const [searchUsername, setSearchUsername] = useState(prefillUsername);
  const [foundUser, setFoundUser] = useState<{ id: string; username: string; public_key: string | null } | null>(null);
  const [searching, setSearching] = useState(false);
  const [sending, setSending] = useState(false);
  const [requestSent, setRequestSent] = useState(false);
  const [existingStatus, setExistingStatus] = useState<'pending' | 'accepted' | 'rejected' | null>(null);
  const [error, setError] = useState('');
  const [fingerprint, setFingerprint] = useState('');
  const [pendingQrToken, setPendingQrToken] = useState<string | null>(null);
  /**
   * Result of QR fingerprint verification:
   *   'match'    — server key matches QR-embedded fingerprint ✓
   *   'mismatch' — server key does NOT match QR fingerprint (MITM warning)
   *   null       — no QR fingerprint to verify against (TOFU / manual search)
   */
  const [fpVerification, setFpVerification] = useState<'match' | 'mismatch' | null>(null);

  // When opened with a pre-filled username (e.g. from QR scan), sync the value
  // and trigger the search automatically so the user just confirms the request.
  useEffect(() => {
    if (open && prefillUsername) {
      setSearchUsername(prefillUsername);
      setPendingQrToken(prefillQrToken ?? null);
      const trimmed = prefillUsername.trim();
      if (!trimmed) return;
      setSearching(true);
      setError('');
      setFoundUser(null);
      setFingerprint('');
      setFpVerification(null);
      setRequestSent(false);
      setExistingStatus(null);
      (async () => {
        try {
          const result = await findUserByUsername(trimmed);
          if (!result) { setError(`No user found with username "${trimmed}".`); return; }
          if (result.id === currentUserId) { setError("You can't add yourself as a contact."); return; }
          setFoundUser(result);
          if (result.public_key) {
            const serverFP = await computeFingerprint(result.public_key);
            setFingerprint(serverFP);
            if (prefillQrFingerprint) {
              setFpVerification(serverFP === prefillQrFingerprint ? 'match' : 'mismatch');
            }
          }
          setExistingStatus(await getRequestStatus(currentUserId, result.id));

          // QR scan path: keep the QR token so the user can send a contact
          // request after reviewing the fingerprint. The scanned user must
          // approve the request before the two become contacts.
          if (prefillQrToken) {
            setPendingQrToken(prefillQrToken);
          }
        } catch {
          setError('Search failed. Please try again.');
        } finally {
          setSearching(false);
        }
      })();
    }
  }, [open, prefillUsername, prefillQrToken, prefillQrFingerprint, currentUserId]);

  const handleSearch = async () => {
    const trimmed = searchUsername.trim();
    if (!trimmed) return;
    setSearching(true);
    setError('');
    setFoundUser(null);
    setFingerprint('');
    setFpVerification(null);
    setRequestSent(false);
    setExistingStatus(null);
    try {
      const result = await findUserByUsername(trimmed);
      if (!result) {
        setError(`No user found with username "${trimmed}".`);
        return;
      }
      if (result.id === currentUserId) {
        setError("You can't add yourself as a contact.");
        return;
      }
      setFoundUser(result);
      if (result.public_key) {
        const fp = await computeFingerprint(result.public_key);
        setFingerprint(fp);
        // Manual search — no QR fingerprint to verify against
        setFpVerification(null);
      }
      const status = await getRequestStatus(currentUserId, result.id);
      setExistingStatus(status);
    } catch {
      setError('Search failed. Please try again.');
    } finally {
      setSearching(false);
    }
  };

  const handleSendRequest = async () => {
    if (!foundUser) return;
    if (fpVerification === 'mismatch') {
      toast.error('Fingerprint mismatch — contact request blocked.', {
        description: 'The key on the server does not match the QR code you scanned. Do not proceed.',
      });
      return;
    }
    setSending(true);
    try {
      // Ensure our own public key is written to our profile before submitting.
      // This covers new accounts whose signup write may not have completed yet —
      // the receiver will find the key in profiles when they accept.
      if (myPublicKeyBase64) {
        supabase.from('profiles')
          .update({ public_key: myPublicKeyBase64 })
          .eq('id', currentUserId)
          .then(() => {}); // fire-and-forget, non-blocking
      }

      // Pass the SENDER's own public key so the receiver can verify our identity
      // on acceptance.  Previously this incorrectly passed foundUser.public_key
      // (the receiver's key), which is not useful and was null for new accounts.
      // The receiver's key is resolved live from their profile on acceptance.
      const { error: reqErr } = pendingQrToken
        ? await sendContactRequestViaQR(foundUser.id, pendingQrToken, myPublicKeyBase64 ?? null)
        : await sendContactRequest(currentUserId, foundUser.id, myPublicKeyBase64 ?? null);
      if (reqErr) {
        toast.error(reqErr);
        return;
      }
      setRequestSent(true);
      toast.success(`Contact request sent to @${foundUser.username}.`);
      onContactAdded();
    } catch {
      toast.error('Failed to send request. Please try again.');
    } finally {
      setSending(false);
    }
  };

  const handleClose = () => {
    setSearchUsername('');
    setFoundUser(null);
    setError('');
    setFingerprint('');
    setFpVerification(null);
    setRequestSent(false);
    setExistingStatus(null);
    setPendingQrToken(null);
    onOpenChange(false);
  };

  const alreadyPending = existingStatus === 'pending' || requestSent;
  const alreadyAccepted = existingStatus === 'accepted';
  const sendBlocked = fpVerification === 'mismatch';

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-[calc(100%-2rem)] md:max-w-md bg-card border-border">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-foreground">
            <UserPlus className="w-5 h-5 text-primary" />
            Add Encrypted Contact
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Search for a user by their SylvaCrypt username to send a contact request. QR scans send a request that must be approved before you can chat.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 mt-2">
          <div className="space-y-1.5">
            <Label className="text-sm font-normal text-muted-foreground uppercase tracking-wider">
              Username
            </Label>
            <div className="flex gap-2">
              <Input
                value={searchUsername}
                onChange={e => { setSearchUsername(e.target.value); setError(''); }}
                onKeyDown={e => e.key === 'Enter' && handleSearch()}
                placeholder="their_username"
                className="bg-input border-border text-foreground placeholder:text-muted-foreground px-3"
              />
              <Button
                onClick={handleSearch}
                disabled={searching || !searchUsername.trim()}
                className="bg-primary text-primary-foreground hover:bg-primary/90 shrink-0"
              >
                {searching ? (
                  <span className="w-4 h-4 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />
                ) : 'Search'}
              </Button>
            </div>
            {error && (
              <p className="text-destructive text-xs flex items-center gap-1">
                <AlertCircle className="w-3 h-3" />{error}
              </p>
            )}
          </div>

          {foundUser && (
            <div className="bg-accent/60 border border-primary/30 rounded-lg p-4 space-y-3">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-primary/20 border border-primary/40 flex items-center justify-center shrink-0">
                  <span className="text-primary font-bold text-sm">
                    {foundUser.username.charAt(0).toUpperCase()}
                  </span>
                </div>
                <div>
                  <p className="text-foreground font-semibold">
                    <span className="text-primary/60">@</span>{foundUser.username}
                  </p>
                  <div className="flex items-center gap-1 mt-0.5">
                    <Shield className="w-3 h-3 text-primary" />
                    <span className="text-xs text-primary">E2E Encrypted</span>
                  </div>
                </div>
              </div>

              {fingerprint && (
                <div className="bg-background/50 rounded p-2 space-y-1">
                  <div className="flex items-center gap-1.5">
                    <Key className="w-3 h-3 text-muted-foreground" />
                    <span className="text-xs text-muted-foreground">Key Fingerprint</span>
                    {/* QR fingerprint verification badge */}
                    {fpVerification === 'match' && (
                      <span className="ml-auto flex items-center gap-1 text-[11px] font-medium text-green-500 bg-green-500/10 rounded px-1.5 py-0.5">
                        <ShieldCheck className="w-3 h-3" />
                        QR Verified
                      </span>
                    )}
                    {fpVerification === 'mismatch' && (
                      <span className="ml-auto flex items-center gap-1 text-[11px] font-medium text-destructive bg-destructive/10 rounded px-1.5 py-0.5">
                        <ShieldX className="w-3 h-3" />
                        Mismatch!
                      </span>
                    )}
                  </div>
                  <p className="text-xs font-mono text-primary/80 break-all">{fingerprint}</p>
                </div>
              )}

              {/* Fingerprint mismatch warning — shown prominently when detected */}
              {fpVerification === 'mismatch' && (
                <div className="border border-destructive/50 bg-destructive/10 rounded-lg p-3 space-y-1.5">
                  <div className="flex items-center gap-2 text-destructive font-semibold text-sm">
                    <ShieldX className="w-4 h-4 shrink-0" />
                    Key Mismatch — Possible Attack
                  </div>
                  <p className="text-xs text-destructive/80 text-pretty leading-relaxed">
                    The public key on the server does <strong>not</strong> match the fingerprint
                    in the QR code you scanned. This could mean the key was swapped after
                    the QR was generated. Do <strong>not</strong> send a contact request.
                  </p>
                  <p className="text-[11px] font-mono text-destructive/60 break-all">
                    QR: {prefillQrFingerprint}
                  </p>
                </div>
              )}

              {/* QR-verified trust notice */}
              {fpVerification === 'match' && (
                <div className="flex items-start gap-2 text-xs text-green-500/80 bg-green-500/10 border border-green-500/20 rounded px-3 py-2">
                  <ShieldCheck className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <span className="text-pretty">
                    The server key matches the fingerprint you scanned in person.
                    This is a cryptographically verified identity.
                  </span>
                </div>
              )}

              {alreadyAccepted ? (
                <div className="flex items-center gap-2 text-xs text-green-500 bg-green-500/10 rounded px-3 py-2">
                  <Shield className="w-3.5 h-3.5 shrink-0" />
                  Already in your contacts
                </div>
              ) : alreadyPending ? (
                <div className="flex items-center gap-2 text-xs text-yellow-500 bg-yellow-500/10 rounded px-3 py-2">
                  <Clock className="w-3.5 h-3.5 shrink-0" />
                  Contact request sent — waiting for @{foundUser.username} to accept
                </div>
              ) : (
                <>
                  {!foundUser.public_key && (
                    <div className="flex items-start gap-2 text-xs text-muted-foreground bg-muted/40 border border-border rounded px-3 py-2">
                      <Key className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                      <span className="text-pretty">
                        This user hasn't set up their vault yet. You can still send a request —
                        they'll receive it once they log in and complete setup.
                      </span>
                    </div>
                  )}
                  <Button
                    className={`w-full ${sendBlocked
                      ? 'bg-destructive/20 text-destructive cursor-not-allowed'
                      : 'bg-primary text-primary-foreground hover:bg-primary/90'}`}
                    onClick={handleSendRequest}
                    disabled={sending || sendBlocked}
                  >
                    {sending ? (
                      <span className="flex items-center gap-2">
                        <span className="w-3.5 h-3.5 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />
                        Sending request...
                      </span>
                    ) : sendBlocked ? (
                      <span className="flex items-center gap-2">
                        <ShieldX className="w-4 h-4" />
                        Blocked — Fingerprint Mismatch
                      </span>
                    ) : (
                      <span className="flex items-center gap-2">
                        <Send className="w-4 h-4" />
                        Send Contact Request
                      </span>
                    )}
                  </Button>
                </>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
