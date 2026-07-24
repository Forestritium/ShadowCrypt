/**
 * QRContactDialog — show the current user's QR code for contact exchange.
 *
 * The QR encodes:  sylvacrypt:add:<username>/<token>/<fingerprint>
 *   - token:       random nonce (profiles.qr_token) for server-side contact-request
 *                  validation; auto-rotated every qr_rotation_days days.
 *   - fingerprint: hex SHA-256 of the user's current public key so that the
 *                  scanner can verify cryptographic identity out-of-band without
 *                  trusting the server.
 *
 * Scanning is supported via:
 *   1. BarcodeDetector API (Chromium 83+, supported natively)
 *   2. File upload of a QR code image (universal fallback)
 */
import { useState, useRef, useCallback, useEffect } from 'react';
import { QrCode, Upload, Camera, Copy, Check, RefreshCw, Settings, ShieldCheck } from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { QRCodeDataUrl } from '@/components/ui/qrcodedataurl';
import { supabase } from '@/db/supabase';
import { computeFingerprint } from '@/lib/crypto';
import { toast } from 'sonner';

// ── BarcodeDetector type shim ─────────────────────────────────────────────────
type BarcodeFormat = 'qr_code' | string;
interface DetectedBarcode { rawValue: string; format: BarcodeFormat }
interface BarcodeDetectorOptions { formats: BarcodeFormat[] }
declare class BarcodeDetector {
  constructor(options?: BarcodeDetectorOptions);
  detect(image: ImageBitmapSource): Promise<DetectedBarcode[]>;
}

const QR_PREFIX = 'sylvacrypt:add:';
const APP_URL = (import.meta.env.VITE_APP_URL as string | undefined) ?? 'https://sylvacrypt.com';

/**
 * Build the full QR payload.
 * v5.1.58: the QR code is an HTTPS URL so any external QR scanner can open the
 * web app and trigger the auto-add contact flow (works for "Keep me signed in"
 * users because the session is restored before the route handler runs).
 * Legacy in-app format `sylvacrypt:add:<username>/<token>/<fingerprint>` is
 * still parsed for backward compatibility.
 */
export function buildQRValue(username: string, token: string, fingerprint: string): string {
  return `${APP_URL}/add-contact?u=${encodeURIComponent(username)}&t=${encodeURIComponent(token)}&fp=${encodeURIComponent(fingerprint)}`;
}

/** Extract username, token, and fingerprint from a scanned QR value. */
export function parseQRValue(raw: string): { username: string; token: string | null; fingerprint: string | null } | null {
  const trimmed = raw.trim();

  // External scanner / URL format
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    try {
      const url = new URL(trimmed);
      const username = url.searchParams.get('u');
      const token = url.searchParams.get('t');
      const fingerprint = url.searchParams.get('fp');
      if (username && /^[a-z0-9_]{2,32}$/i.test(username)) {
        return { username, token, fingerprint };
      }
    } catch {
      return null;
    }
  }

  // Legacy in-app format
  if (trimmed.startsWith(QR_PREFIX)) {
    const payload = trimmed.slice(QR_PREFIX.length);
    const parts = payload.split('/');
    const username = parts[0] || null;
    const token = parts[1] || null;
    const fingerprint = parts[2] || null;
    return username ? { username, token, fingerprint } : null;
  }

  // Fallback: plain username (no token or fingerprint)
  if (/^[a-z0-9_]{2,32}$/i.test(trimmed)) return { username: trimmed, token: null, fingerprint: null };
  return null;
}

/** Generate a cryptographically random hex token (16 bytes = 32 hex chars). */
function generateToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Returns true when the token should be rotated. */
function isTokenExpired(generatedAt: string | null, rotationDays: number): boolean {
  if (!generatedAt) return true;
  const ageMs = Date.now() - new Date(generatedAt).getTime();
  return ageMs >= rotationDays * 24 * 60 * 60 * 1000;
}

interface MyQRTabProps {
  userId: string;
  username: string;
  /** Session public key — used as fallback when the profile row hasn't been
   *  fully written yet (new accounts). Ensures the QR code is always shown. */
  myPublicKeyBase64?: string | null;
}

function MyQRTab({ userId, username, myPublicKeyBase64 }: MyQRTabProps) {
  const [token, setToken] = useState<string | null>(null);
  const [rotationDays, setRotationDays] = useState(3);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  // Load or initialise the QR token and own public key fingerprint on mount
  const [ownFingerprint, setOwnFingerprint] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const { data } = await supabase
          .from('profiles')
          .select('qr_token, qr_generated_at, qr_rotation_days, public_key')
          .eq('id', userId)
          .single();

        const savedDays: number = data?.qr_rotation_days ?? 3;
        setRotationDays(savedDays);

        // Compute fingerprint of own public key so it can be embedded in the QR code.
        // Prefer the live profile key; fall back to the in-memory session key for
        // new accounts where the profile write may still be in progress.
        const keyForFingerprint = data?.public_key ?? myPublicKeyBase64 ?? null;
        if (keyForFingerprint) {
          setOwnFingerprint(await computeFingerprint(keyForFingerprint));
        }

        if (!data?.qr_token || isTokenExpired(data.qr_generated_at, savedDays)) {
          // Auto-rotate: generate a fresh token
          await rotateToken(savedDays, false);
        } else {
          setToken(data.qr_token);
        }
      } catch {
        // If fetch fails (e.g. profile row not yet visible for new accounts),
        // generate a local-only token and use the in-memory key for the fingerprint.
        setToken(generateToken());
        if (myPublicKeyBase64) {
          computeFingerprint(myPublicKeyBase64).then(setOwnFingerprint).catch(() => {});
        }
      } finally {
        setLoading(false);
      }
    })();
  }, [userId]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Persist a new token (and optionally a new rotationDays) to the DB. */
  const rotateToken = useCallback(async (days: number, showToast = true) => {
    setSaving(true);
    try {
      const newToken = generateToken();
      const now = new Date().toISOString();
      await supabase.from('profiles').update({
        qr_token: newToken,
        qr_generated_at: now,
        qr_rotation_days: days,
      }).eq('id', userId);
      setToken(newToken);
      if (showToast) toast.success('QR code regenerated.');
    } catch {
      toast.error('Failed to regenerate QR code. Please try again.');
    } finally {
      setSaving(false);
    }
  }, [userId]);

  /** Save only the rotation-days setting without regenerating the token. */
  const saveRotationDays = useCallback(async (days: number) => {
    setSaving(true);
    try {
      await supabase.from('profiles').update({ qr_rotation_days: days }).eq('id', userId);
      setRotationDays(days);
      toast.success(`QR rotation set to every ${days} day${days === 1 ? '' : 's'}.`);
    } catch {
      toast.error('Failed to save setting.');
    } finally {
      setSaving(false);
    }
  }, [userId]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(username);
      setCopied(true);
      toast.success('Username copied!');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Could not copy to clipboard');
    }
  };

  const qrValue = token && ownFingerprint ? buildQRValue(username, token, ownFingerprint) : '';

  if (loading) {
    return (
      <div className="flex flex-col items-center gap-4 py-6">
        <div className="w-48 h-48 rounded-xl bg-muted animate-pulse" />
        <p className="text-xs text-muted-foreground">Loading QR code…</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-4">
      <p className="text-xs text-muted-foreground text-center text-pretty">
        Ask your contact to scan this code. It encodes a time-limited token that
        rotates every <strong>{rotationDays} day{rotationDays === 1 ? '' : 's'}</strong>.
      </p>

      {/* QR canvas */}
      <div className="rounded-xl border-2 border-primary/20 bg-white p-3 shadow-sm">
        {qrValue ? <QRCodeDataUrl value={qrValue} size={192} /> : (
          <div className="w-48 h-48 flex items-center justify-center bg-muted rounded-lg">
            <QrCode className="w-12 h-12 text-muted-foreground" />
          </div>
        )}
      </div>

      <p className="text-sm font-semibold text-foreground">@{username}</p>

      {/* Key fingerprint — shown so the contact can verify it matches after scanning */}
      {ownFingerprint && (
        <div className="w-full bg-muted/40 border border-border rounded-lg px-3 py-2 space-y-1">
          <div className="flex items-center gap-1.5">
            <ShieldCheck className="w-3.5 h-3.5 text-primary shrink-0" />
            <span className="text-xs font-medium text-muted-foreground">Your key fingerprint</span>
          </div>
          <p className="text-[11px] font-mono text-primary/70 break-all leading-relaxed">
            {ownFingerprint}
          </p>
          <p className="text-[10px] text-muted-foreground/60 text-pretty">
            Embedded in QR — your contact&apos;s app will verify this matches your server key.
          </p>
        </div>
      )}

      {/* Actions row */}
      <div className="flex gap-2 w-full">
        <Button
          variant="outline"
          size="sm"
          className="gap-2 flex-1"
          onClick={handleCopy}
        >
          {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
          {copied ? 'Copied!' : 'Copy username'}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="gap-2 flex-1"
          onClick={() => rotateToken(rotationDays)}
          disabled={saving}
        >
          <RefreshCw className={`w-3.5 h-3.5 ${saving ? 'animate-spin' : ''}`} />
          New QR
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="px-2.5"
          title="QR rotation settings"
          onClick={() => setShowSettings(v => !v)}
        >
          <Settings className="w-3.5 h-3.5" />
        </Button>
      </div>

      {/* Rotation settings panel */}
      {showSettings && (
        <div className="w-full bg-muted/40 border border-border rounded-lg p-3 space-y-3">
          <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Auto-rotation interval
          </Label>
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={1}
              max={14}
              value={rotationDays}
              onChange={e => setRotationDays(Number(e.target.value))}
              className="flex-1 accent-primary"
            />
            <span className="text-sm font-semibold text-foreground w-16 text-right shrink-0">
              {rotationDays} day{rotationDays === 1 ? '' : 's'}
            </span>
          </div>
          <p className="text-xs text-muted-foreground text-pretty">
            Your QR token will automatically refresh every <strong>{rotationDays} day{rotationDays === 1 ? '' : 's'}</strong>.
            When a new QR code is generated (automatically or manually), all previous QR codes are immediately invalidated and will no longer work.
          </p>
          <Button
            size="sm"
            className="w-full bg-primary text-primary-foreground hover:bg-primary/90"
            onClick={() => saveRotationDays(rotationDays)}
            disabled={saving}
          >
            {saving ? 'Saving…' : 'Save rotation setting'}
          </Button>
        </div>
      )}
    </div>
  );
}

// ── Scan QR tab ───────────────────────────────────────────────────────────────
/** ScanQRTab calls back with username + extracted token + embedded fingerprint */
function ScanQRTab({ onScanned }: { onScanned: (username: string, token: string | null, fingerprint: string | null) => void }) {
  const [scanning, setScanning] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animFrameRef = useRef<number>(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hasBarcodeDetector = typeof window !== 'undefined' && 'BarcodeDetector' in window;

  const stopCamera = useCallback(() => {
    cancelAnimationFrame(animFrameRef.current);
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    setScanning(false);
  }, []);

  const startCamera = useCallback(async () => {
    setCameraError('');
    setScanning(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      const detector = new BarcodeDetector({ formats: ['qr_code'] });
      const scan = async () => {
        if (!videoRef.current || videoRef.current.readyState < 2) {
          animFrameRef.current = requestAnimationFrame(scan);
          return;
        }
        try {
          const barcodes = await detector.detect(videoRef.current);
          if (barcodes.length > 0) {
            const parsed = parseQRValue(barcodes[0].rawValue);
            if (parsed) { stopCamera(); onScanned(parsed.username, parsed.token, parsed.fingerprint); return; }
          }
        } catch { /* ignore single-frame errors */ }
        animFrameRef.current = requestAnimationFrame(scan);
      };
      animFrameRef.current = requestAnimationFrame(scan);
    } catch (err) {
      setScanning(false);
      const msg = err instanceof Error ? err.message : String(err);
      setCameraError(msg.includes('NotAllowed') ? 'Camera permission denied.' : `Camera error: ${msg}`);
    }
  }, [onScanned, stopCamera]);

  const handleFileUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    try {
      const img = new Image();
      img.src = URL.createObjectURL(file);
      await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = rej; });
      const detector = new BarcodeDetector({ formats: ['qr_code'] });
      const barcodes = await detector.detect(img);
      URL.revokeObjectURL(img.src);
      if (barcodes.length === 0) { toast.error('No QR code found in image'); return; }
      const parsed = parseQRValue(barcodes[0].rawValue);
      if (!parsed) { toast.error('QR code is not a SylvaCrypt contact QR'); return; }
      onScanned(parsed.username, parsed.token, parsed.fingerprint);
    } catch {
      toast.error('Could not read QR code from image');
    }
  }, [onScanned]);

  return (
    <div className="flex flex-col gap-3">
      {scanning ? (
        <div className="relative rounded-xl overflow-hidden border-2 border-primary/30 bg-black aspect-square max-h-48">
          <video ref={videoRef} className="w-full h-full object-cover" playsInline muted />
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="w-36 h-36 border-2 border-primary rounded-lg opacity-70" />
          </div>
          <Button
            size="sm"
            variant="ghost"
            className="absolute top-2 right-2 border border-white/60 text-white hover:bg-white/10"
            onClick={stopCamera}
          >
            Stop
          </Button>
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-muted/30 p-6 flex flex-col items-center gap-3">
          <Camera className="w-10 h-10 text-muted-foreground" />
          <p className="text-xs text-muted-foreground text-center text-pretty">
            {hasBarcodeDetector
              ? "Point your camera at a SylvaCrypt QR code to auto-fill the username."
              : "Your browser doesn't support live scanning. Upload a QR image below."}
          </p>
          {cameraError && <p className="text-xs text-destructive text-center">{cameraError}</p>}
          {hasBarcodeDetector && (
            <Button size="sm" className="gap-2" onClick={startCamera}>
              <Camera className="w-3.5 h-3.5" />
              Start camera
            </Button>
          )}
        </div>
      )}
      <div className="flex items-center gap-2">
        <div className="flex-1 h-px bg-border" />
        <span className="text-xs text-muted-foreground">or upload QR image</span>
        <div className="flex-1 h-px bg-border" />
      </div>
      <Button
        variant="outline"
        size="sm"
        className="gap-2 w-full"
        onClick={() => fileInputRef.current?.click()}
        disabled={!hasBarcodeDetector}
      >
        <Upload className="w-3.5 h-3.5" />
        {hasBarcodeDetector ? 'Upload QR image' : 'Browser not supported'}
      </Button>
      <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleFileUpload} />
    </div>
  );
}

// ── Main dialog ───────────────────────────────────────────────────────────────
type QRTab = 'my-qr' | 'scan';

interface QRContactDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: string;
  username: string;
  /** Session public key — passed down so MyQRTab can show a QR even when the
   *  profile row hasn't been written yet (new accounts). */
  myPublicKeyBase64?: string | null;
  /** Called with scanned username, qr_token, and fingerprint embedded in the QR */
  onUsernameScanned: (username: string, qrToken: string | null, qrFingerprint: string | null) => void;
}

export function QRContactDialog({ open, onOpenChange, userId, username, myPublicKeyBase64, onUsernameScanned }: QRContactDialogProps) {
  const [tab, setTab] = useState<QRTab>('my-qr');

  const handleScanned = (scannedUsername: string, qrToken: string | null, qrFingerprint: string | null) => {
    onOpenChange(false);
    onUsernameScanned(scannedUsername, qrToken, qrFingerprint);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100%-2rem)] md:max-w-sm bg-card border-border">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-foreground">
            <QrCode className="w-5 h-5 text-primary" />
            QR Code Contact Exchange
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Share your QR code or scan a contact's code to add them instantly.
          </DialogDescription>
        </DialogHeader>

        {/* Tabs */}
        <div className="flex rounded-lg border border-border overflow-hidden">
          {(['my-qr', 'scan'] as QRTab[]).map(t => (
            <button
              key={t}
              className={`flex-1 py-2 text-xs font-medium transition-colors ${tab === t ? 'bg-primary text-primary-foreground' : 'bg-transparent text-muted-foreground hover:text-foreground'}`}
              onClick={() => setTab(t)}
            >
              {t === 'my-qr' ? 'My QR Code' : 'Scan QR Code'}
            </button>
          ))}
        </div>

        <div className="mt-1">
          {tab === 'my-qr'
            ? <MyQRTab userId={userId} username={username} myPublicKeyBase64={myPublicKeyBase64} />
            : <ScanQRTab onScanned={handleScanned} />
          }
        </div>
      </DialogContent>
    </Dialog>
  );
}
