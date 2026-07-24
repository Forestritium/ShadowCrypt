import { useState, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { AddContactDialog } from '@/components/chat/AddContactDialog';
import { useAuth } from '@/contexts/AuthContext';

/**
 * External QR scanner landing route.
 *
 * URL format: /add-contact?u=<username>&t=<qr_token>&fp=<fingerprint>
 *
 * When a user with "Keep me signed in" scans this URL with a generic QR app,
 * the browser opens the web app, the session is restored, and this component
 * auto-opens the add-contact dialog with the QR details pre-filled so a
 * contact request can be sent. The scanned user must approve the request
 * before the two become contacts.
 */
export default function AddContactPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { user, loading, session } = useAuth();
  const [open, setOpen] = useState(false);

  const username = params.get('u') ?? '';
  const token = params.get('t');
  const fingerprint = params.get('fp');

  useEffect(() => {
    if (!loading) {
      if (!user) {
        // Not signed in: send them to auth, preserving the QR params so the
        // dialog can reopen after login once keep-me-signed-in restores.
        navigate(`/auth?redirect=${encodeURIComponent(`/add-contact?${params.toString()}`)}`, {
          replace: true,
        });
      } else if (!username || !token) {
        // Invalid QR data
        navigate('/chat', { replace: true });
      } else {
        setOpen(true);
      }
    }
  }, [loading, user, username, token, params, navigate]);

  const handleClose = () => {
    setOpen(false);
    navigate('/chat', { replace: true });
  };

  if (loading) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="w-10 h-10 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">Unlocking SylvaCrypt…</p>
        </div>
      </div>
    );
  }

  if (!user) return null; // navigation handles redirect

  return (
    <AddContactDialog
      open={open}
      onOpenChange={handleClose}
      currentUserId={user.id}
      myPublicKeyBase64={session?.publicKeyBase64 ?? null}
      prefillUsername={username}
      prefillQrToken={token}
      prefillQrFingerprint={fingerprint}
      onContactAdded={() => {}}
    />
  );
}
