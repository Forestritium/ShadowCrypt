/**
 * Linked Devices page — Enterprise-grade multi-device management.
 *
 * Primary device:
 *   - Sees all registered devices with name, fingerprint, added date.
 *   - Can approve pending (unapproved) devices.
 *   - Can remove any device (own or linked).
 *
 * Secondary device:
 *   - Sees all devices but cannot approve others.
 *   - Can remove itself (de-register).
 *
 * Key fingerprint: SHA-256 of the device's X25519 public key, displayed as
 * space-separated hex groups (same format as standard safety numbers).
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Monitor, Smartphone, Globe, CheckCircle2,
  Clock, Trash2, ShieldCheck, ShieldAlert, Copy, RefreshCw,
  AlertTriangle,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/contexts/AuthContext';
import { fetchMyDevices, approveDevice, removeLinkedDevice } from '@/lib/relay';
import { computeFingerprint } from '@/lib/crypto';
import type { UserDevice } from '@/types/types';

// ─── helpers ─────────────────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

function deviceIcon(name: string): React.ReactElement {
  const lower = name.toLowerCase();
  if (/ios|android|mobile|phone/.test(lower))
    return <Smartphone className="w-5 h-5" />;
  if (/chrome|firefox|safari|edge|opera|browser/.test(lower))
    return <Globe className="w-5 h-5" />;
  return <Monitor className="w-5 h-5" />;
}

// ─── component ───────────────────────────────────────────────────────────────

export default function LinkedDevicesPage() {
  const navigate = useNavigate();
  const { profile } = useAuth();
  const userId = profile?.id ?? '';

  // The stable device ID for the current browser session (stored in localStorage)
  const [myDeviceId] = useState<string>(() => localStorage.getItem('sc_device_id') ?? '');

  const [devices, setDevices] = useState<UserDevice[]>([]);
  const [fingerprints, setFingerprints] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [approving, setApproving] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<UserDevice | null>(null);

  // Determine if this device is the primary one
  const myDevice = devices.find(d => d.device_id === myDeviceId);
  const isPrimaryDevice = myDevice?.is_primary ?? false;
  const pendingCount = devices.filter(d => !d.approved).length;

  const load = useCallback(async () => {
    if (!userId) return;
    try {
      const list = await fetchMyDevices(userId);
      setDevices(list);
      // Compute fingerprints for all devices in parallel
      const fps: Record<string, string> = {};
      await Promise.all(
        list.map(async d => {
          try {
            fps[d.id] = await computeFingerprint(d.public_key);
          } catch {
            fps[d.id] = 'unavailable';
          }
        })
      );
      setFingerprints(fps);
    } catch {
      toast.error('Failed to load devices');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [userId]);

  useEffect(() => { load(); }, [load]);

  const handleRefresh = () => { setRefreshing(true); load(); };

  const handleApprove = async (device: UserDevice) => {
    setApproving(device.id);
    try {
      await approveDevice(device.id);
      toast.success(`Approved "${device.device_name}"`);
      load();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setApproving(null);
    }
  };

  const handleRemoveConfirm = async () => {
    if (!removeTarget) return;
    setRemoving(removeTarget.id);
    try {
      await removeLinkedDevice(removeTarget.id);
      toast.success(`Removed "${removeTarget.device_name}"`);
      // If the user just removed their own device, log out
      if (removeTarget.device_id === myDeviceId) {
        navigate('/auth');
        return;
      }
      load();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setRemoving(null);
      setRemoveTarget(null);
    }
  };

  const copyFingerprint = (fp: string, name: string) => {
    navigator.clipboard.writeText(fp).then(() => {
      toast.success(`Copied fingerprint for "${name}"`);
    });
  };

  // ── Loading skeleton ────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="min-h-screen bg-background flex flex-col">
        <header className="sticky top-0 z-10 bg-card border-b border-border px-4 h-14 flex items-center gap-3">
          <button
            onClick={() => navigate('/settings')}
            className="w-9 h-9 flex items-center justify-center rounded-lg hover:bg-muted transition-colors text-foreground"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <h1 className="text-base font-semibold text-foreground">Linked Devices</h1>
        </header>
        <div className="flex-1 max-w-lg mx-auto w-full px-4 py-6 space-y-3">
          {[1, 2, 3].map(i => (
            <div key={i} className="bg-card border border-border rounded-2xl h-24 animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex flex-col">

      {/* ── Header ─────────────────────────────────────────────── */}
      <header className="sticky top-0 z-10 bg-card border-b border-border px-4 h-14 flex items-center gap-3">
        <button
          onClick={() => navigate('/settings')}
          className="w-9 h-9 flex items-center justify-center rounded-lg hover:bg-muted transition-colors text-foreground"
          aria-label="Back to settings"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h1 className="text-base font-semibold text-foreground flex-1 min-w-0 truncate">Linked Devices</h1>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="w-9 h-9 flex items-center justify-center rounded-lg hover:bg-muted transition-colors text-muted-foreground"
          aria-label="Refresh devices"
        >
          <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-lg mx-auto w-full px-4 py-6 space-y-6">

          {/* ── Info banner ────────────────────────────────────── */}
          <div className="bg-primary/8 border border-primary/20 rounded-2xl px-4 py-3.5 flex gap-3">
            <ShieldCheck className="w-5 h-5 text-primary shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="text-sm font-semibold text-foreground">Enterprise-grade multi-device</p>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Each device has its own X25519 identity key and independent Double Ratchet sessions.
                Messages are encrypted separately for every linked device — the server never sees plaintext.
              </p>
            </div>
          </div>

          {/* ── Pending approvals banner ────────────────────────── */}
          {isPrimaryDevice && pendingCount > 0 && (
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-2xl px-4 py-3.5 flex gap-3">
              <ShieldAlert className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-semibold text-foreground">
                  {pendingCount} device{pendingCount > 1 ? 's' : ''} waiting for approval
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Approve only devices you recognise. Verify fingerprints out-of-band.
                </p>
              </div>
            </div>
          )}

          {/* ── Device list ─────────────────────────────────────── */}
          {devices.length === 0 ? (
            <div className="bg-card border border-border rounded-2xl px-4 py-10 flex flex-col items-center gap-3 text-center">
              <Monitor className="w-10 h-10 text-muted-foreground/40" />
              <p className="text-sm font-medium text-foreground">No devices registered</p>
              <p className="text-xs text-muted-foreground">Log out and back in to register this device.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {devices.map(device => {
                const isThisDevice = device.device_id === myDeviceId;
                const fp = fingerprints[device.id] ?? '…';
                const canApprove = isPrimaryDevice && !device.approved && !isThisDevice;
                const canRemove = isThisDevice || isPrimaryDevice;

                return (
                  <div
                    key={device.id}
                    className={`bg-card border rounded-2xl px-4 py-4 space-y-3 transition-colors ${
                      isThisDevice
                        ? 'border-primary/40 bg-primary/5'
                        : device.approved
                          ? 'border-border'
                          : 'border-amber-500/40 bg-amber-500/5'
                    }`}
                  >
                    {/* Row 1: icon + name + badge */}
                    <div className="flex items-start gap-3">
                      <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
                        isThisDevice ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground'
                      }`}>
                        {deviceIcon(device.device_name)}
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="text-sm font-semibold text-foreground">{device.device_name}</p>
                          {isThisDevice && (
                            <span className="text-[10px] font-medium bg-primary/15 text-primary rounded-full px-2 py-0.5 shrink-0">
                              This device
                            </span>
                          )}
                          {device.is_primary && (
                            <span className="text-[10px] font-medium bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 rounded-full px-2 py-0.5 shrink-0">
                              Primary
                            </span>
                          )}
                          {!device.approved && (
                            <span className="text-[10px] font-medium bg-amber-500/15 text-amber-600 dark:text-amber-400 rounded-full px-2 py-0.5 shrink-0">
                              Pending
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 mt-0.5">
                          {device.approved
                            ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                            : <Clock className="w-3.5 h-3.5 text-amber-500 shrink-0" />}
                          <p className="text-xs text-muted-foreground">
                            Added {relativeTime(device.added_at)} · Last seen {relativeTime(device.last_seen_at)}
                          </p>
                        </div>
                      </div>
                    </div>

                    {/* Row 2: fingerprint */}
                    <div className="bg-muted/60 rounded-xl px-3 py-2.5">
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                          Key Fingerprint
                        </p>
                        <button
                          onClick={() => copyFingerprint(fp, device.device_name)}
                          className="text-muted-foreground hover:text-primary transition-colors"
                          aria-label="Copy fingerprint"
                        >
                          <Copy className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      <p className="font-mono text-[11px] text-primary/80 break-all leading-relaxed tracking-wide">
                        {fp}
                      </p>
                    </div>

                    {/* Row 3: actions */}
                    {(canApprove || canRemove) && (
                      <div className="flex gap-2 pt-1">
                        {canApprove && (
                          <Button
                            size="sm"
                            onClick={() => handleApprove(device)}
                            disabled={approving === device.id}
                            className="flex-1 h-8 text-xs"
                          >
                            {approving === device.id
                              ? <span className="w-3 h-3 border border-primary-foreground/60 border-t-primary-foreground rounded-full animate-spin mr-1.5" />
                              : <CheckCircle2 className="w-3.5 h-3.5 mr-1.5" />}
                            Approve Device
                          </Button>
                        )}
                        {canRemove && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setRemoveTarget(device)}
                            disabled={removing === device.id}
                            className="h-8 text-xs text-destructive hover:text-destructive hover:bg-destructive/10 border border-destructive/30"
                          >
                            <Trash2 className="w-3.5 h-3.5 mr-1.5" />
                            {isThisDevice ? 'Deregister' : 'Remove'}
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* ── How it works ────────────────────────────────────── */}
          <div className="bg-muted/40 border border-border rounded-2xl px-4 py-4 space-y-2">
            <p className="text-xs font-semibold text-foreground">How linked devices work</p>
            <ul className="text-xs text-muted-foreground space-y-1.5 list-none">
              <li>• The <strong className="text-foreground">primary device</strong> is the first browser where you logged in.</li>
              <li>• New devices are <strong className="text-foreground">pending</strong> until the primary device approves them.</li>
              <li>• Every approved device receives its own encrypted copy of each message.</li>
              <li>• Each device maintains <strong className="text-foreground">independent Double Ratchet sessions</strong> — no shared state.</li>
              <li>• Verify fingerprints out-of-band (e.g., in person) to confirm no MITM.</li>
            </ul>
          </div>

        </div>
      </div>

      {/* ── Remove confirmation dialog ──────────────────────────── */}
      <AlertDialog open={!!removeTarget} onOpenChange={open => !open && setRemoveTarget(null)}>
        <AlertDialogContent className="max-w-[calc(100%-2rem)] md:max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-destructive" />
              {removeTarget?.device_id === myDeviceId ? 'Deregister this device?' : 'Remove linked device?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {removeTarget?.device_id === myDeviceId
                ? 'This will remove your current device from the account. You will be signed out and will need to re-link the device next time you log in.'
                : `"${removeTarget?.device_name}" will no longer receive messages. This cannot be undone.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleRemoveConfirm}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {removing ? (
                <span className="w-3.5 h-3.5 border border-destructive-foreground/60 border-t-destructive-foreground rounded-full animate-spin mr-2" />
              ) : null}
              {removeTarget?.device_id === myDeviceId ? 'Deregister' : 'Remove Device'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
