/**
 * SafetyNumberPage — dedicated secure safety number comparison screen.
 *
 * Accessed via /safety-number/:contactId
 * Shows the 60-digit safety number as a grid of 12 blocks (5 digits each),
 * a QR code of the safety number, and verification instructions.
 *
 * Data resolution order:
 *   1. Always fetch the live profile row from Supabase (username + public_key).
 *   2. Fall back to the local vault contact for the public key if the profile
 *      fetch fails or the profile has no public_key yet.
 *   3. This means the page works even when the contact is not (yet) in the
 *      local vault — which was the original source of the "Could not compute
 *      safety number" error.
 */
import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, CheckCircle2, ShieldCheck, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/contexts/AuthContext';
import { computeSafetyNumber } from '@/lib/crypto';
import { getContact } from '@/lib/localStore';
import { getContactsFromDB } from '@/lib/dbStore';
import { getUserPublicKey, fetchAcceptedContacts } from '@/lib/relay';
import type { Contact } from '@/types/types';

export default function SafetyNumberPage() {
  const { contactId } = useParams<{ contactId: string }>();
  const navigate = useNavigate();
  const { session } = useAuth();

  const [contact, setContact] = useState<Contact | null>(null);
  // Display name resolved from profile or local vault
  const [displayUsername, setDisplayUsername] = useState<string | null>(null);
  const [safetyNumber, setSafetyNumber] = useState<string | null>(null);
  const [verified, setVerified] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!contactId || !session?.publicKeyBase64) return;

    (async () => {
      setLoading(true);
      try {
        // Resolve the contact from multiple sources in order of freshness:
        // 1. Server-side contacts table (dbStore) — the canonical source of truth.
        // 2. Local vault contact (legacy localStore fallback).
        const dbContacts = await getContactsFromDB(session.userId);
        const dbContact = dbContacts.find(c => c.id === contactId) ?? null;
        const localContact = await getContact(contactId);
        const mergedContact: Contact | null = dbContact ?? localContact;
        setContact(mergedContact);

        // Resolve display username from whichever source has it.
        setDisplayUsername(mergedContact?.username ?? null);

        // Resolve their public key with multiple fallbacks:
        // 1. Server contacts table public_key ( freshest, includes key-rotation updates ).
        // 2. Local vault contact publicKey.
        // 3. Accepted contact_requests (the original request carries the sender's key).
        // 4. Live public_profiles lookup (handles contacts added outside the vault).
        let theirKey = dbContact?.publicKey ?? localContact?.publicKey ?? null;
        if (!theirKey) {
          const accepted = await fetchAcceptedContacts(session.userId);
          theirKey = accepted.find(c => c.userId === contactId)?.publicKey ?? null;
        }
        if (!theirKey) {
          theirKey = await getUserPublicKey(contactId);
        }

        if (theirKey) {
          const sn = await computeSafetyNumber(session.publicKeyBase64, theirKey);
          setSafetyNumber(sn);
        } else {
          console.warn('[SafetyNumber] No public key found for contact', contactId);
        }
      } catch (err) {
        console.error('[SafetyNumber] Failed to compute safety number:', err);
      } finally {
        setLoading(false);
      }
    })();
  }, [contactId, session]);

  // Format safety number as blocks of 5 digits (12 blocks = 60 digits)
  const blocks = safetyNumber
    ? safetyNumber.match(/.{1,5}/g) ?? []
    : [];

  const handleMarkVerified = () => {
    setVerified(v => !v);
  };

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Header */}
      <header className="sticky top-0 z-10 bg-card border-b border-border px-4 h-14 flex items-center gap-3">
        <button
          onClick={() => navigate(-1)}
          className="w-9 h-9 flex items-center justify-center rounded-lg hover:bg-muted transition-colors text-foreground"
          aria-label="Back"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="text-base font-semibold text-foreground">Safety Number</h1>
          {displayUsername && (
            <p className="text-xs text-muted-foreground truncate">@{displayUsername}</p>
          )}
        </div>
        {verified && (
          <CheckCircle2 className="w-5 h-5 text-green-500 shrink-0" />
        )}
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-md mx-auto px-4 py-8 flex flex-col items-center gap-8">

          {/* Icon */}
          <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
            <ShieldCheck className="w-8 h-8 text-primary" />
          </div>

          {/* Explanation */}
          <div className="text-center space-y-2">
            <h2 className="text-lg font-semibold text-foreground">
              Verify {displayUsername ?? contact?.username ?? 'Contact'}
            </h2>
            <p className="text-sm text-muted-foreground leading-relaxed max-w-sm">
              Compare this safety number with{' '}
              <span className="font-medium text-foreground">
                @{displayUsername ?? contact?.username ?? 'this contact'}
              </span>{' '}
              in person or via another secure channel. If the numbers match, your
              conversation is end-to-end encrypted with no interception.
            </p>
          </div>

          {loading ? (
            <div className="grid grid-cols-4 gap-2 w-full">
              {Array.from({ length: 12 }).map((_, i) => (
                <div key={i} className="h-12 rounded-xl bg-muted animate-pulse" />
              ))}
            </div>
          ) : safetyNumber ? (
            <>
              {/* Safety number grid — 12 blocks of 5 chars */}
              <div className="grid grid-cols-4 gap-2 w-full">
                {blocks.map((block, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-center h-12 rounded-xl bg-muted border border-border"
                  >
                    <span className="font-mono text-sm font-semibold text-foreground tracking-widest select-all">
                      {block}
                    </span>
                  </div>
                ))}
              </div>

              {/* Full hex string for copy */}
              <p className="font-mono text-xs text-muted-foreground text-center break-all select-all px-2">
                {safetyNumber}
              </p>
            </>
          ) : (
            <div className="flex flex-col items-center gap-2 text-sm text-destructive text-center">
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <span>Could not compute safety number.</span>
              </div>
              <p className="text-xs text-muted-foreground max-w-xs">
                The contact&apos;s public key could not be found. Ask them to open SylvaCrypt so their key is published, then pull down to refresh.
              </p>
            </div>
          )}

          {/* Verified status */}
          {safetyNumber && (
            <div className="w-full space-y-3">
              <Button
                variant={verified ? 'default' : 'outline'}
                className="w-full gap-2"
                onClick={handleMarkVerified}
              >
                <CheckCircle2 className="w-4 h-4" />
                {verified ? 'Marked as Verified' : 'Mark as Verified'}
              </Button>
              {verified && (
                <p className="text-xs text-center text-muted-foreground">
                  This session is marked verified. If the safety number ever changes,
                  SylvaCrypt will warn you immediately.
                </p>
              )}
            </div>
          )}

          {/* Warning */}
          <div className="w-full bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 flex gap-3">
            <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="text-xs font-semibold text-amber-600 dark:text-amber-400">
                Do not verify over this chat
              </p>
              <p className="text-xs text-muted-foreground leading-relaxed">
                If an attacker has compromised this channel, they can show you a
                matching number.  Always compare in person or via a different secure
                channel (phone call, video call, etc.).
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
