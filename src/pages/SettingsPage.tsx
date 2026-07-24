import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Camera, Lock, Unlock, User, Edit2, Ban,
  Trash2, Eye, EyeOff, AlertTriangle, XCircle, Check,
  Shield, Info, ChevronRight, KeyRound, Download, Copy, CheckCircle2, RefreshCw, Smartphone,
  History, ToggleLeft, ToggleRight, UserX, HardDrive, LogOut, Key, Clock,
  ShieldCheck, LifeBuoy, BookOpen,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { unblockUser, fetchBlockedUsers, fetchContactKeyHistory } from '@/lib/relay';
import { getMnemonic, getEncryptedIdentityKeyBlob, getStoredSaltBase64, getKdfVersion, getContacts, syncVaultKeyPersistence, restoreVaultFromBackup } from '@/lib/localStore';
import {
  syncSessionPersistence,
  getKeepSignedInSetting,
  setKeepSignedInSetting,
  KEEP_SIGNED_IN_OPTIONS,
  type KeepSignedInDuration,
} from '@/lib/session';
import type { Contact } from '@/types/types';
import { toast } from 'sonner';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { ImageCropDialog } from '@/components/chat/ImageCropDialog';
import { usePWAInstall } from '@/hooks/usePWAInstall';

type Section = 'main' | 'bio' | 'username' | 'blocklist' | 'delete' | 'recovery' | 'security' | 'key-history';

// ── Vault lock removed — vault persists for the lifetime of the browser session ──

import { Bell } from 'lucide-react';
import { Palette, Activity } from 'lucide-react';
export default function SettingsPage() {
  const navigate = useNavigate();
  const {
    profile, session,
    updateBio, changeUsername, updateAvatar, updateAvatarPrivacy,
    deleteAccount, regenerateMnemonic,
    updateDiscoverable, signOutAllDevices,
  } = useAuth();
  const username = profile?.username ?? '';
  const { showBanner, install, isInstalled } = usePWAInstall();

  // Section navigation
  const [section, setSection] = useState<Section>('main');

  // Avatar
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [avatarPrivate, setAvatarPrivate] = useState(profile?.avatar_private ?? false);
  const [cropSrc, setCropSrc] = useState<string | null>(null);
  const [cropOpen, setCropOpen] = useState(false);

  // Bio
  const [bioInput, setBioInput] = useState(profile?.bio ?? '');
  const [bioPrivate, setBioPrivate] = useState(profile?.bio_private ?? false);
  const [savingBio, setSavingBio] = useState(false);

  // Username
  const [newUsernameInput, setNewUsernameInput] = useState('');
  const [changingUsername, setChangingUsername] = useState(false);

  // Blocklist
  const [blockedUsers, setBlockedUsers] = useState<{ id: string; username: string }[]>([]);
  const [unblockingId, setUnblockingId] = useState<string | null>(null);

  // Delete account
  const [deletePassword, setDeletePassword] = useState('');
  const [showDeletePassword, setShowDeletePassword] = useState(false);
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  // Recovery phrase
  const [recoveryMnemonic, setRecoveryMnemonic] = useState<string | null>(null);
  const [recoveryVisible, setRecoveryVisible] = useState(false);
  const [loadingMnemonic, setLoadingMnemonic] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [regenerateDialogOpen, setRegenerateDialogOpen] = useState(false);
  const [newMnemonic, setNewMnemonic] = useState<string | null>(null);
  const [copiedMnemonic, setCopiedMnemonic] = useState(false);

  // Security / privacy prefs (persisted in localStorage)
  const [typingDisabled, setTypingDisabled] = useState(
    () => localStorage.getItem('sc_typing_disabled') === '1',
  );
  // Keep-Me-Signed-In: duration selector (off | 1 | 3 | 5 | 7 | 14 | 30 | forever)
  // Default 14 days for new users; read existing setting for returning users.
  const [keepSignedInValue, setKeepSignedInValue] = useState<'off' | KeepSignedInDuration>(
    () => getKeepSignedInSetting(),
  );
  // Whether the duration dropdown is open
  const [keepSignedInOpen, setKeepSignedInOpen] = useState(false);
  const [discoverable, setDiscoverable] = useState(profile?.discoverable ?? true);

  // Key history
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [keyHistoryUsername, setKeyHistoryUsername] = useState('');
  const [keyHistoryRows, setKeyHistoryRows] = useState<
    { id: string; old_fp: string; new_fp: string; changed_at: string }[]
  >([]);
  const [loadingKeyHistory, setLoadingKeyHistory] = useState(false);

  // Backup
  const [exportingBackup, setExportingBackup] = useState(false);
  const [importingBackup, setImportingBackup] = useState(false);
  const backupImportRef = useRef<HTMLInputElement>(null);

  // Sign out all devices
  const [signingOutAll, setSigningOutAll] = useState(false);

  useEffect(() => {
    setBioInput(profile?.bio ?? '');
    setBioPrivate(profile?.bio_private ?? false);
    setAvatarPrivate(profile?.avatar_private ?? false);
    setDiscoverable(profile?.discoverable ?? true);
  }, [profile?.bio, profile?.bio_private, profile?.avatar_private, profile?.discoverable]);

  useEffect(() => {
    if (section === 'blocklist') fetchBlockedUsers().then(setBlockedUsers);
    if (section === 'security') getContacts().then(setContacts);
  }, [section]);

  // ── Avatar with crop ──────────────────────────────────────────────────────
  const handleAvatarFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) { toast.error('Image must be under 8 MB.'); return; }
    const url = URL.createObjectURL(file);
    setCropSrc(url);
    setCropOpen(true);
  };

  const handleCropComplete = async (blob: Blob) => {
    setCropOpen(false);
    if (cropSrc) URL.revokeObjectURL(cropSrc);
    setCropSrc(null);
    setUploadingAvatar(true);
    const file = new File([blob], 'avatar.png', { type: 'image/png' });
    const { error } = await updateAvatar(file);
    setUploadingAvatar(false);
    if (error) toast.error(error.message || 'Failed to upload avatar.');
    else toast.success('Profile picture updated.');
  };

  const handleAvatarPrivacyToggle = async () => {
    const next = !avatarPrivate;
    setAvatarPrivate(next);
    const { error } = await updateAvatarPrivacy(next);
    if (error) { setAvatarPrivate(!next); toast.error('Failed to update privacy setting.'); }
    else toast.success(next ? 'Profile picture is now private.' : 'Profile picture is now visible to contacts.');
  };

  // ── Bio ───────────────────────────────────────────────────────────────────
  const handleSaveBio = async () => {
    setSavingBio(true);
    const { error } = await updateBio(bioInput, bioPrivate);
    setSavingBio(false);
    if (error) toast.error(error.message || 'Failed to update bio.');
    else { toast.success('Bio updated.'); setSection('main'); }
  };

  // ── Username ──────────────────────────────────────────────────────────────
  const handleChangeUsername = async () => {
    setChangingUsername(true);
    const { error } = await changeUsername(newUsernameInput);
    setChangingUsername(false);
    if (error) toast.error(error.message);
    else { toast.success('Username changed successfully.'); setNewUsernameInput(''); setSection('main'); }
  };

  // ── Block list ────────────────────────────────────────────────────────────
  const handleUnblock = async (id: string, uname: string) => {
    setUnblockingId(id);
    try {
      await unblockUser(id);
      toast.success(`@${uname} unblocked.`);
      setBlockedUsers(prev => prev.filter(u => u.id !== id));
    } catch { toast.error('Failed to unblock user.'); }
    setUnblockingId(null);
  };

  // ── Delete account ────────────────────────────────────────────────────────
  const handleDeleteAccount = async () => {
    setDeletingAccount(true);
    const { error } = await deleteAccount(deletePassword);
    setDeletingAccount(false);
    if (error) { toast.error(error.message); return; }
    toast.success('Account deleted.');
    navigate('/auth');
  };

  // ── Recovery phrase ───────────────────────────────────────────────────────
  const handleViewMnemonic = async () => {
    setLoadingMnemonic(true);
    try {
      // getMnemonic() tries IDB first, then falls back to the Supabase cloud
      // backup (added in v333). If neither source has the phrase, automatically
      // generate a fresh one so the user is never left without a recovery path.
      let phrase = await getMnemonic();
      if (!phrase) {
        // No phrase in IDB or cloud — auto-generate a replacement so the user
        // always leaves Settings with a valid, visible recovery phrase.
        const { mnemonic, error } = await regenerateMnemonic();
        if (error || !mnemonic) {
          toast.error('Could not retrieve or generate a recovery phrase. Please try again.');
          return;
        }
        phrase = mnemonic;
        toast.info('A new recovery phrase was generated. Please save it — the old one (if any) is no longer valid.');
      }
      setRecoveryMnemonic(phrase);
      setRecoveryVisible(true);
    } finally { setLoadingMnemonic(false); }
  };

  const handleCopyMnemonic = (phrase: string) => {
    navigator.clipboard.writeText(phrase).then(() => {
      setCopiedMnemonic(true);
      setTimeout(() => setCopiedMnemonic(false), 2000);
    });
  };

  const handleDownloadMnemonic = (phrase: string) => {
    const content = [
      'SylvaCrypt Recovery Phrase',
      '============================',
      `Account: @${username}`,
      `Exported: ${new Date().toISOString()}`,
      '',
      'Store this file somewhere safe. Do NOT share it with anyone.',
      '',
      phrase,
      '',
      'Words in order:',
      ...phrase.split(' ').map((w, i) => `${i + 1}. ${w}`),
    ].join('\n');
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `SylvaCrypt_${username}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleRegenerate = async () => {
    setRegenerating(true);
    try {
      const { mnemonic, error } = await regenerateMnemonic();
      if (error || !mnemonic) { toast.error(error?.message || 'Failed to regenerate recovery phrase.'); return; }
      setNewMnemonic(mnemonic);
      setRecoveryMnemonic(mnemonic);
      setRecoveryVisible(true);
      setRegenerateDialogOpen(false);
      toast.success('Recovery phrase regenerated. Save your new phrase now.');
    } finally { setRegenerating(false); }
  };

  // Username cooldown calc
  const usernameCooldownDays = (() => {
    if (!profile?.username_last_changed) return 0;
    const ms = 14 * 24 * 60 * 60 * 1000;
    const elapsed = Date.now() - new Date(profile.username_last_changed).getTime();
    return elapsed < ms ? Math.ceil((ms - elapsed) / (24 * 60 * 60 * 1000)) : 0;
  })();

  // ── Security prefs ────────────────────────────────────────────────────────
  const toggleTyping = () => {
    const next = !typingDisabled;
    setTypingDisabled(next);
    localStorage.setItem('sc_typing_disabled', next ? '1' : '0');
    toast.success(next ? 'Typing indicators disabled.' : 'Typing indicators enabled.');
  };

  const handleKeepSignedInChange = async (value: 'off' | KeepSignedInDuration) => {
    setKeepSignedInValue(value);
    setKeepSignedInOpen(false);
    // Persist preference + expiry timestamp via session helper
    setKeepSignedInSetting(value);
    // Sync vault key IDB persistence and session info immediately so the new
    // setting takes effect for the current session without requiring re-login.
    await syncVaultKeyPersistence();
    syncSessionPersistence();
    const label = KEEP_SIGNED_IN_OPTIONS.find(o => o.value === value)?.label ?? value;
    if (value === 'off') {
      toast.success('"Keep me signed in" disabled.');
    } else {
      toast.success(`Signed in will persist for: ${label}.`);
    }
  };

  const handleDiscoverable = async (val: boolean) => {
    setDiscoverable(val);
    const { error } = await updateDiscoverable(val);
    if (error) { setDiscoverable(!val); toast.error('Failed to update discovery setting.'); }
    else toast.success(val ? 'You can now be found by username search.' : 'You are hidden from username search. Share via QR only.');
  };

  const handleSignOutAllDevices = async () => {
    setSigningOutAll(true);
    await signOutAllDevices();
    toast.success('Signed out from all devices.');
    navigate('/auth');
  };

  // ── Key history ───────────────────────────────────────────────────────────
  const openKeyHistory = async (contactId: string, cUsername: string) => {
    if (!session) return;
    setKeyHistoryUsername(cUsername);
    setLoadingKeyHistory(true);
    setSection('key-history');
    const rows = await fetchContactKeyHistory(session.userId, contactId);
    setKeyHistoryRows(rows);
    setLoadingKeyHistory(false);
  };

  // ── Encrypted local backup ────────────────────────────────────────────────
  const handleExportBackup = async () => {
    setExportingBackup(true);
    try {
      const [saltB64, keyBlob, kdfVersion] = await Promise.all([
        getStoredSaltBase64(),
        getEncryptedIdentityKeyBlob(),
        getKdfVersion(),
      ]);
      if (!saltB64 || !keyBlob) {
        toast.error('Vault data not available. Re-login and try again.');
        return;
      }
      const phrase = await getMnemonic();
      const bundle = JSON.stringify({
        version: 1,
        username,
        exportedAt: new Date().toISOString(),
        vault_salt: saltB64,
        encrypted_private_key: keyBlob,
        kdf_version: kdfVersion,
        // encrypted_private_key (keyBlob) holds the AES-GCM encrypted identity
        // key pair.  The mnemonic is backed up separately in
        // profiles.encrypted_mnemonic server-side; include only a hint here as
        // a human-readable reference — users should treat this file as
        // highly sensitive.
        recovery_phrase_hint: phrase ? `${phrase.split(' ').slice(0, 2).join(' ')} …` : null,
      }, null, 2);
      const blob = new Blob([bundle], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `SylvaCrypt_vault_${username}_${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success('Vault backup downloaded. Store it securely.');
    } catch (e) {
      toast.error('Export failed: ' + (e as Error).message);
    } finally {
      setExportingBackup(false);
    }
  };

  const handleImportBackup = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setImportingBackup(true);
    try {
      const text = await file.text();
      const bundle = JSON.parse(text);
      if (!bundle.vault_salt || !bundle.encrypted_private_key) {
        toast.error('Invalid backup file.');
        return;
      }
      // Import into IndexedDB via localStore — user will need to re-enter their
      // password on next login to decrypt the imported key.
      await restoreVaultFromBackup(bundle.vault_salt, bundle.encrypted_private_key, bundle.kdf_version ?? 0);
      toast.success('Vault backup imported. Sign in with your original password to unlock.');
    } catch (e) {
      toast.error('Import failed: ' + (e as Error).message);
    } finally {
      setImportingBackup(false);
    }
  };

  // ── Section renders ───────────────────────────────────────────────────────

  if (section === 'bio') {
    return (
      <div className="min-h-screen bg-background flex flex-col">
        <header className="sticky top-0 z-10 bg-card border-b border-border px-4 h-14 flex items-center gap-3">
          <button onClick={() => setSection('main')} className="w-9 h-9 flex items-center justify-center rounded-lg hover:bg-muted transition-colors text-foreground">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <h1 className="text-base font-semibold text-foreground">Edit Bio</h1>
        </header>
        <div className="flex-1 p-4 max-w-lg mx-auto w-full space-y-4">
          <div>
            <label className="text-sm font-medium text-foreground block mb-1.5">Bio</label>
            <textarea
              value={bioInput}
              onChange={e => setBioInput(e.target.value)}
              placeholder="Write something about yourself..."
              maxLength={160}
              rows={4}
              className="w-full text-sm bg-muted border border-border rounded-xl px-3 py-2.5 text-foreground placeholder:text-muted-foreground resize-none focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
            <p className="text-xs text-muted-foreground mt-1 text-right">{bioInput.length}/160</p>
          </div>
          <button onClick={() => setBioPrivate(!bioPrivate)}
            className={`flex items-center gap-2.5 w-full px-4 py-3 rounded-xl border transition-colors ${
              bioPrivate
                ? 'bg-amber-500/10 border-amber-500/30 text-amber-600 dark:text-amber-400'
                : 'bg-muted border-border text-foreground hover:bg-muted/80'
            }`}>
            {bioPrivate ? <Lock className="w-4 h-4 shrink-0" /> : <Unlock className="w-4 h-4 shrink-0" />}
            <div className="flex-1 text-left">
              <p className="text-sm font-medium leading-tight">
                {bioPrivate ? 'Bio is Private' : 'Bio is Public'}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {bioPrivate ? 'Only you can see your bio' : 'Your contacts can see your bio'}
              </p>
            </div>
          </button>
          <button onClick={handleSaveBio} disabled={savingBio}
            className="w-full h-10 rounded-xl bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 mt-2">
            {savingBio ? 'Saving...' : 'Save Bio'}
          </button>
        </div>
      </div>
    );
  }

  if (section === 'username') {
    return (
      <div className="min-h-screen bg-background flex flex-col">
        <header className="sticky top-0 z-10 bg-card border-b border-border px-4 h-14 flex items-center gap-3">
          <button onClick={() => setSection('main')} className="w-9 h-9 flex items-center justify-center rounded-lg hover:bg-muted transition-colors text-foreground">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <h1 className="text-base font-semibold text-foreground">Change Username</h1>
        </header>
        <div className="flex-1 p-4 max-w-lg mx-auto w-full space-y-4">
          {usernameCooldownDays > 0 ? (
            <div className="rounded-xl bg-amber-500/10 border border-amber-500/25 p-4 text-sm text-amber-600 dark:text-amber-400">
              You can change your username again in <strong>{usernameCooldownDays} day{usernameCooldownDays === 1 ? '' : 's'}</strong>.
            </div>
          ) : (
            <>
              <div>
                <label className="text-sm font-medium text-foreground block mb-1.5">New Username</label>
                <input
                  value={newUsernameInput}
                  onChange={e => setNewUsernameInput(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
                  placeholder={username}
                  maxLength={30}
                  className="w-full text-sm bg-muted border border-border rounded-xl px-3 py-2.5 text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                />
                <p className="text-xs text-muted-foreground mt-1">Lowercase letters, numbers, underscores only. 14-day cooldown after change.</p>
              </div>
              <button onClick={handleChangeUsername} disabled={changingUsername || !newUsernameInput.trim()}
                className="w-full h-10 rounded-xl bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50">
                {changingUsername ? 'Changing...' : 'Change Username'}
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  if (section === 'blocklist') {
    return (
      <div className="min-h-screen bg-background flex flex-col">
        <header className="sticky top-0 z-10 bg-card border-b border-border px-4 h-14 flex items-center gap-3">
          <button onClick={() => setSection('main')} className="w-9 h-9 flex items-center justify-center rounded-lg hover:bg-muted transition-colors text-foreground">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <h1 className="text-base font-semibold text-foreground">Blocked Users</h1>
        </header>
        <div className="flex-1 p-4 max-w-lg mx-auto w-full">
          {blockedUsers.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <div className="w-14 h-14 rounded-full bg-muted flex items-center justify-center">
                <Ban className="w-6 h-6 text-muted-foreground" />
              </div>
              <p className="text-sm text-muted-foreground">No blocked users.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {blockedUsers.map(bu => (
                <div key={bu.id} className="flex items-center gap-3 px-4 py-3 rounded-xl bg-card border border-border">
                  <div className="w-9 h-9 rounded-full bg-muted border border-border flex items-center justify-center shrink-0">
                    <span className="text-sm font-semibold text-foreground">{bu.username.charAt(0).toUpperCase()}</span>
                  </div>
                  <span className="flex-1 min-w-0 text-sm text-foreground truncate">
                    <span className="text-muted-foreground">@</span>{bu.username}
                  </span>
                  <button onClick={() => handleUnblock(bu.id, bu.username)} disabled={unblockingId === bu.id}
                    className="text-sm text-primary hover:text-primary/80 shrink-0 px-3 py-1.5 rounded-lg hover:bg-primary/10 transition-colors disabled:opacity-50 font-medium">
                    {unblockingId === bu.id ? '...' : 'Unblock'}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (section === 'recovery') {
    const words = recoveryMnemonic?.split(' ') ?? [];
    const displayPhrase = newMnemonic ?? recoveryMnemonic;
    return (
      <div className="min-h-screen bg-background flex flex-col">
        <header className="sticky top-0 z-10 bg-card border-b border-border px-4 h-14 flex items-center gap-3">
          <button onClick={() => { setSection('main'); setRecoveryVisible(false); setRecoveryMnemonic(null); setNewMnemonic(null); }}
            className="w-9 h-9 flex items-center justify-center rounded-lg hover:bg-muted transition-colors text-foreground">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <h1 className="text-base font-semibold text-foreground">Recovery Phrase</h1>
        </header>
        <div className="flex-1 p-4 max-w-lg mx-auto w-full space-y-4">
          <div className="rounded-xl bg-amber-500/10 border border-amber-500/25 p-4 flex gap-3">
            <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
            <p className="text-xs text-amber-600 dark:text-amber-400 leading-relaxed">
              Your recovery phrase is the only way to recover your account if you lose access. Never share it with anyone.
            </p>
          </div>
          {!recoveryMnemonic ? (
            <button onClick={handleViewMnemonic} disabled={loadingMnemonic}
              className="w-full flex items-center justify-center gap-2 h-11 rounded-xl bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50">
              <Eye className="w-4 h-4" />
              {loadingMnemonic ? 'Loading...' : 'Reveal Recovery Phrase'}
            </button>
          ) : (
            <div className="space-y-4">
              {recoveryVisible ? (
                <>
                  <div className="grid grid-cols-3 gap-2">
                    {words.map((w, i) => (
                      <div key={i} className="flex items-center gap-1.5 bg-muted border border-border rounded-lg px-2.5 py-2">
                        <span className="text-xs text-muted-foreground w-4 shrink-0">{i + 1}.</span>
                        <span className="text-sm font-medium text-foreground">{w}</span>
                      </div>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => displayPhrase && handleCopyMnemonic(displayPhrase)}
                      className="flex-1 flex items-center justify-center gap-2 h-10 rounded-xl bg-muted border border-border text-sm font-medium text-foreground hover:bg-muted/80 transition-colors">
                      {copiedMnemonic ? <CheckCircle2 className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" />}
                      {copiedMnemonic ? 'Copied' : 'Copy'}
                    </button>
                    <button onClick={() => displayPhrase && handleDownloadMnemonic(displayPhrase)}
                      className="flex-1 flex items-center justify-center gap-2 h-10 rounded-xl bg-muted border border-border text-sm font-medium text-foreground hover:bg-muted/80 transition-colors">
                      <Download className="w-4 h-4" />
                      Download
                    </button>
                  </div>
                  <button onClick={() => setRegenerateDialogOpen(true)}
                    className="w-full flex items-center justify-center gap-2 h-10 rounded-xl border border-destructive/40 text-destructive text-sm font-medium hover:bg-destructive/5 transition-colors">
                    <RefreshCw className="w-4 h-4" />
                    Regenerate Phrase
                  </button>
                </>
              ) : (
                <button onClick={() => setRecoveryVisible(true)}
                  className="w-full flex items-center justify-center gap-2 h-11 rounded-xl bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors">
                  <Eye className="w-4 h-4" />
                  Show Phrase
                </button>
              )}
            </div>
          )}
        </div>
        <AlertDialog open={regenerateDialogOpen} onOpenChange={setRegenerateDialogOpen}>
          <AlertDialogContent className="max-w-[calc(100%-2rem)] md:max-w-lg">
            <AlertDialogHeader>
              <AlertDialogTitle className="flex items-center gap-2 text-destructive">
                <AlertTriangle className="w-5 h-5 shrink-0" />
                Regenerate Recovery Phrase?
              </AlertDialogTitle>
              <AlertDialogDescription>
                This will permanently invalidate your current recovery phrase and generate a new one. The old phrase will no longer work.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={regenerating}>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={handleRegenerate} disabled={regenerating}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                {regenerating ? 'Regenerating...' : 'Regenerate'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    );
  }

  // ── Security tab ──────────────────────────────────────────────────────────
  if (section === 'security') {
    return (
      <div className="min-h-screen bg-background flex flex-col">
        <header className="sticky top-0 z-10 bg-card border-b border-border px-4 h-14 flex items-center gap-3">
          <button onClick={() => setSection('main')} className="w-9 h-9 flex items-center justify-center rounded-lg hover:bg-muted transition-colors text-foreground">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <h1 className="text-base font-semibold text-foreground">Security &amp; Privacy</h1>
        </header>
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-lg mx-auto px-4 py-6 space-y-6">

            {/* ── Key fingerprint ──────────────────────── */}
            <section>
              <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 px-1">Identity Key</h2>
              <div className="bg-card border border-border rounded-2xl p-4 space-y-3">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                    <Key className="w-4 h-4 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground">Your Key Fingerprint</p>
                    <p className="fingerprint text-primary/80 text-xs break-all mt-0.5 select-all">
                      {session?.fingerprint ?? 'Unavailable — open vault to compute'}
                    </p>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground pl-11 leading-relaxed">
                  Share this with contacts out-of-band to verify your identity. If theirs matches yours on their screen, you have a genuine E2E channel.
                </p>
              </div>
            </section>

            {/* ── Privacy toggles ───────────────────────── */}
            <section>
              <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 px-1">Privacy</h2>
              <div className="bg-card border border-border rounded-2xl overflow-hidden divide-y divide-border">

                {/* Typing indicators */}
                <button onClick={toggleTyping} className="w-full flex items-center gap-3 px-4 py-3.5 hover:bg-muted/50 transition-colors text-left">
                  <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                    {typingDisabled ? <ToggleLeft className="w-4 h-4 text-muted-foreground" /> : <ToggleRight className="w-4 h-4 text-primary" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground">Typing Indicators</p>
                    <p className="text-xs text-muted-foreground">Let contacts know when you are composing a message</p>
                  </div>
                  <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${typingDisabled ? 'bg-muted text-muted-foreground' : 'bg-primary/10 text-primary'}`}>
                    {typingDisabled ? 'Off' : 'On'}
                  </span>
                </button>

                {/* Username discovery */}
                <button onClick={() => handleDiscoverable(!discoverable)} className="w-full flex items-center gap-3 px-4 py-3.5 hover:bg-muted/50 transition-colors text-left">
                  <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                    {discoverable ? <ToggleRight className="w-4 h-4 text-primary" /> : <UserX className="w-4 h-4 text-muted-foreground" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground">Username Discovery</p>
                    <p className="text-xs text-muted-foreground">
                      {discoverable ? 'You can be found via username search' : 'Hidden — share your QR code to add contacts'}
                    </p>
                  </div>
                  <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${!discoverable ? 'bg-muted text-muted-foreground' : 'bg-primary/10 text-primary'}`}>
                    {discoverable ? 'On' : 'Off'}
                  </span>
                </button>
              </div>
            </section>

            {/* ── Session ───────────────────────────────── */}
            <section>
              <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 px-1">Session</h2>
              <div className="bg-card border border-border rounded-2xl divide-y divide-border">
                {/* Keep Me Signed In — On/Off toggle */}
                <button
                  type="button"
                  onClick={() => handleKeepSignedInChange(keepSignedInValue === 'off' ? '14' : 'off')}
                  className={`w-full flex items-center gap-3 px-4 py-3.5 hover:bg-muted/50 transition-colors text-left ${keepSignedInValue === 'off' ? 'rounded-2xl' : 'rounded-t-2xl'}`}
                >
                  <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                    <Clock className="w-4 h-4 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground">Keep Me Signed In</p>
                    <p className="text-xs text-muted-foreground">Persist your session across browser restarts</p>
                  </div>
                  <span className={`text-xs font-medium px-2.5 py-0.5 rounded-full shrink-0 ${keepSignedInValue !== 'off' ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}>
                    {keepSignedInValue !== 'off' ? 'On' : 'Off'}
                  </span>
                </button>

                {/* Duration selector — only shown when enabled */}
                {keepSignedInValue !== 'off' && (
                  <div className="px-4 py-3 flex items-center gap-3 rounded-b-2xl">
                    <div className="w-8 h-8 shrink-0" /> {/* spacer aligns with icon above */}
                    <p className="text-sm text-muted-foreground flex-1 min-w-0">Duration</p>
                    <div className="relative shrink-0">
                      <button
                        type="button"
                        onClick={() => setKeepSignedInOpen(o => !o)}
                        className="flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full border border-border bg-muted hover:bg-muted/80 transition-colors"
                      >
                        <span className="text-primary">
                          {KEEP_SIGNED_IN_OPTIONS.find(o => o.value === keepSignedInValue)?.label ?? '14 days'}
                        </span>
                        <ChevronRight className={`w-3 h-3 text-muted-foreground transition-transform ${keepSignedInOpen ? 'rotate-90' : ''}`} />
                      </button>
                      {keepSignedInOpen && (
                        <div className="absolute right-0 top-full mt-1 z-50 bg-card border border-border rounded-xl shadow-lg overflow-hidden min-w-[110px]">
                          {KEEP_SIGNED_IN_OPTIONS.filter(o => o.value !== 'off').map(opt => (
                            <button
                              key={opt.value}
                              type="button"
                              onClick={() => handleKeepSignedInChange(opt.value)}
                              className={`w-full flex items-center justify-between gap-2 px-3 py-2 text-xs hover:bg-muted transition-colors text-left ${keepSignedInValue === opt.value ? 'text-primary font-semibold' : 'text-foreground'}`}
                            >
                              {opt.label}
                              {keepSignedInValue === opt.value && <Check className="w-3 h-3 shrink-0" />}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </section>

            {/* ── Install PWA ───────────────────────────── */}
            {!isInstalled && (
              <section>
                <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 px-1">App Installation</h2>
                <div className="bg-card border border-border rounded-2xl overflow-hidden divide-y divide-border">
                  <div className="px-4 py-3">
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      Install SylvaCrypt as a standalone app for quick access and an improved experience without the browser toolbar.
                    </p>
                  </div>
                  {showBanner ? (
                    <button
                      onClick={install}
                      className="w-full flex items-center gap-3 px-4 py-3.5 hover:bg-muted/50 transition-colors text-left"
                    >
                      <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                        <Smartphone className="w-4 h-4 text-primary" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-foreground">Install SylvaCrypt</p>
                        <p className="text-xs text-muted-foreground">Add to your home screen or desktop</p>
                      </div>
                      <Download className="w-4 h-4 text-muted-foreground shrink-0" />
                    </button>
                  ) : (
                    <div className="w-full flex items-center gap-3 px-4 py-3.5 opacity-60">
                      <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center shrink-0">
                        <Smartphone className="w-4 h-4 text-muted-foreground" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-foreground">Install SylvaCrypt</p>
                        <p className="text-xs text-muted-foreground">Already installed or browser doesn't support install prompt</p>
                      </div>
                    </div>
                  )}
                </div>
              </section>
            )}

            {/* ── Backup ────────────────────────────────── */}
            <section>
              <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 px-1">Encrypted Vault Backup</h2>
              <div className="bg-card border border-border rounded-2xl overflow-hidden divide-y divide-border">
                <div className="px-4 py-3">
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Export an encrypted bundle of your vault. It contains your identity key pair protected by your password — the file is useless without it.
                  </p>
                </div>
                <button onClick={handleExportBackup} disabled={exportingBackup}
                  className="w-full flex items-center gap-3 px-4 py-3.5 hover:bg-muted/50 transition-colors text-left disabled:opacity-50">
                  <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                    <HardDrive className="w-4 h-4 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground">Export Vault Backup</p>
                    <p className="text-xs text-muted-foreground">Download an encrypted .json backup file</p>
                  </div>
                  {exportingBackup
                    ? <span className="w-4 h-4 border border-primary/50 border-t-primary rounded-full animate-spin shrink-0" />
                    : <Download className="w-4 h-4 text-muted-foreground shrink-0" />}
                </button>
                <button onClick={() => backupImportRef.current?.click()} disabled={importingBackup}
                  className="w-full flex items-center gap-3 px-4 py-3.5 hover:bg-muted/50 transition-colors text-left disabled:opacity-50">
                  <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center shrink-0">
                    <HardDrive className="w-4 h-4 text-muted-foreground" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground">Import Vault Backup</p>
                    <p className="text-xs text-muted-foreground">Restore from a previously exported backup file</p>
                  </div>
                  {importingBackup && <span className="w-4 h-4 border border-primary/50 border-t-primary rounded-full animate-spin shrink-0" />}
                </button>
                <input ref={backupImportRef} type="file" accept=".json,application/json" className="hidden" onChange={handleImportBackup} />
              </div>
            </section>

            {/* ── Session management ────────────────────── */}
            <section>
              <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 px-1">Session Management</h2>
              <div className="bg-card border border-border rounded-2xl overflow-hidden divide-y divide-border">
                <div className="px-4 py-3">
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Sign out of all devices at once. This terminates every active Supabase session including this one — you'll need to sign in again.
                  </p>
                </div>
                <button onClick={handleSignOutAllDevices} disabled={signingOutAll}
                  className="w-full flex items-center gap-3 px-4 py-3.5 hover:bg-destructive/5 transition-colors text-left disabled:opacity-50">
                  <div className="w-8 h-8 rounded-lg bg-destructive/10 flex items-center justify-center shrink-0">
                    <LogOut className="w-4 h-4 text-destructive" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-destructive">Sign Out All Devices</p>
                    <p className="text-xs text-muted-foreground">Revoke all active sessions globally</p>
                  </div>
                  {signingOutAll
                    ? <span className="w-4 h-4 border border-destructive/50 border-t-destructive rounded-full animate-spin shrink-0" />
                    : <ChevronRight className="w-4 h-4 text-destructive/60 shrink-0" />}
                </button>
              </div>
            </section>

            {/* ── Contact Key History ───────────────────── */}
            {contacts.length > 0 && (
              <section>
                <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 px-1">Contact Key History</h2>
                <div className="bg-card border border-border rounded-2xl overflow-hidden divide-y divide-border">
                  {contacts.map(c => (
                    <button key={c.id} onClick={() => openKeyHistory(c.id, c.username)}
                      className="w-full flex items-center gap-3 px-4 py-3.5 hover:bg-muted/50 transition-colors text-left">
                      <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0 text-sm font-bold text-primary">
                        {c.username.charAt(0).toUpperCase()}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-foreground">@{c.username}</p>
                        <p className="text-xs text-muted-foreground truncate font-mono">{c.fingerprint.slice(0, 16)}…</p>
                      </div>
                      <History className="w-4 h-4 text-muted-foreground shrink-0" />
                    </button>
                  ))}
                </div>
              </section>
            )}

            {/* ── Deferred features notice ─────────────── */}
            <section>
              <div className="bg-muted/50 border border-border rounded-2xl p-4 space-y-2">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Roadmap</p>
                <div className="space-y-1.5">
                  {[
                    { label: 'Full X3DH key exchange (Extended prekeys)', done: true },
                    { label: 'Sealed sender (hide sender identity from relay)', done: true },
                    { label: 'Post-quantum hybrid encryption (ML-KEM-768 / CRYSTALS-Kyber)', done: true },
                    { label: 'Multi-device support with per-device key pairs', done: true },
                    { label: 'Per-ratchet-step header key rotation (Full sealed sender)', done: true },
                    { label: 'Group messaging with sender keys', done: false },
                  ].map(item => (
                    <div key={item.label} className="flex items-start gap-2">
                      <div className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${item.done ? 'bg-green-500' : 'bg-muted-foreground/40'}`} />
                      <p className={`text-xs ${item.done ? 'text-foreground line-through decoration-muted-foreground/40' : 'text-muted-foreground'}`}>
                        {item.label}
                      </p>
                    </div>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground/70">Strikethrough items are shipped. Remaining items require protocol-level changes and are planned for a future release.</p>
              </div>
            </section>

          </div>
        </div>
      </div>
    );
  }

  // ── Key history tab ───────────────────────────────────────────────────────
  if (section === 'key-history') {
    return (
      <div className="min-h-screen bg-background flex flex-col">
        <header className="sticky top-0 z-10 bg-card border-b border-border px-4 h-14 flex items-center gap-3">
          <button onClick={() => setSection('security')} className="w-9 h-9 flex items-center justify-center rounded-lg hover:bg-muted transition-colors text-foreground">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="flex-1 min-w-0">
            <h1 className="text-base font-semibold text-foreground">Key History</h1>
            {keyHistoryUsername && <p className="text-xs text-muted-foreground">@{keyHistoryUsername}</p>}
          </div>
        </header>
        <div className="flex-1 p-4 max-w-lg mx-auto w-full">
          {loadingKeyHistory ? (
            <div className="space-y-3">
              {[0,1,2].map(i => <div key={i} className="h-20 bg-muted rounded-xl animate-pulse" />)}
            </div>
          ) : keyHistoryRows.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <div className="w-14 h-14 rounded-full bg-muted flex items-center justify-center">
                <History className="w-6 h-6 text-muted-foreground" />
              </div>
              <p className="text-sm text-muted-foreground">No key changes recorded for this contact.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {keyHistoryRows.map(row => (
                <div key={row.id} className="bg-card border border-border rounded-xl p-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                      <ShieldCheck className="w-3.5 h-3.5 text-amber-500" />
                      Key Changed
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {new Date(row.changed_at).toLocaleDateString()} {new Date(row.changed_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                  <div className="space-y-1">
                    <div>
                      <p className="text-xs text-muted-foreground mb-0.5">Previous fingerprint</p>
                      <p className="font-mono text-xs text-muted-foreground/80 break-all bg-muted rounded px-2 py-1">{row.old_fp}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground mb-0.5">New fingerprint</p>
                      <p className="font-mono text-xs text-primary/80 break-all bg-primary/5 rounded px-2 py-1">{row.new_fp}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── Main settings ─────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="sticky top-0 z-10 bg-card border-b border-border px-4 h-14 flex items-center gap-3">
        <button onClick={() => navigate('/chat')}
          className="w-9 h-9 flex items-center justify-center rounded-lg hover:bg-muted transition-colors text-foreground" aria-label="Back to chat">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h1 className="text-base font-semibold text-foreground">Settings</h1>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-lg mx-auto w-full px-4 py-6 space-y-6">

          {/* ── Profile Picture ────────────────────────────────── */}
          <section>
            <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 px-1">Profile Picture</h2>
            <div className="bg-card border border-border rounded-2xl p-5 flex flex-col items-center gap-4">
              <div className="relative">
                <div className="w-24 h-24 rounded-full bg-primary/15 border-2 border-primary/25 flex items-center justify-center overflow-hidden">
                  {profile?.avatar_url ? (
                    <img src={`${profile.avatar_url}?t=${profile.username}`} alt={username} className="w-full h-full object-cover" />
                  ) : (
                    <span className="text-3xl font-bold text-primary">{username.charAt(0).toUpperCase()}</span>
                  )}
                </div>
                <button onClick={() => avatarInputRef.current?.click()} disabled={uploadingAvatar}
                  className="absolute -bottom-1 -right-1 w-8 h-8 rounded-full bg-primary flex items-center justify-center border-2 border-background hover:bg-primary/90 transition-colors disabled:opacity-60"
                  title="Change profile picture (opens crop tool)">
                  {uploadingAvatar
                    ? <span className="w-3.5 h-3.5 border border-white/60 border-t-white rounded-full animate-spin" />
                    : <Camera className="w-3.5 h-3.5 text-primary-foreground" />}
                </button>
                <input ref={avatarInputRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif" className="hidden" onChange={handleAvatarFileSelect} />
              </div>

              <p className="text-sm font-medium text-foreground">
                <span className="text-muted-foreground">@</span>{username}
              </p>

              <button onClick={handleAvatarPrivacyToggle}
                className={`flex items-center gap-2.5 w-full px-4 py-3 rounded-xl border transition-colors ${
                  avatarPrivate
                    ? 'bg-amber-500/10 border-amber-500/30 text-amber-600 dark:text-amber-400'
                    : 'bg-muted border-border text-foreground hover:bg-muted/80'
                }`}>
                {avatarPrivate ? <Lock className="w-4 h-4 shrink-0" /> : <Unlock className="w-4 h-4 shrink-0" />}
                <div className="flex-1 text-left">
                  <p className="text-sm font-medium leading-tight">
                    {avatarPrivate ? 'Picture is Private' : 'Picture is Public'}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {avatarPrivate ? 'Only you can see your profile picture' : 'Your contacts can see your profile picture'}
                  </p>
                </div>
              </button>
            </div>
          </section>

          {/* ── Account ────────────────────────────────────────── */}
          <section>
            <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 px-1">Account</h2>
            <div className="bg-card border border-border rounded-2xl overflow-hidden divide-y divide-border">
              <button onClick={() => setSection('bio')} className="w-full flex items-center gap-3 px-4 py-3.5 hover:bg-muted/50 transition-colors text-left">
                <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                  <User className="w-4 h-4 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground">Edit Bio</p>
                  <p className="text-xs text-muted-foreground truncate">{profile?.bio || 'Add a bio to your profile'}</p>
                </div>
                <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
              </button>

              <button onClick={() => setSection('username')} className="w-full flex items-center gap-3 px-4 py-3.5 hover:bg-muted/50 transition-colors text-left">
                <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                  <Edit2 className="w-4 h-4 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground">Change Username</p>
                  <p className="text-xs text-muted-foreground">
                    {usernameCooldownDays > 0 ? `Available in ${usernameCooldownDays}d` : `Current: @${username}`}
                  </p>
                </div>
                <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
              </button>
            </div>
          </section>

          {/* ── Notifications ───────────────────────────────────────── */}
          <section>
            <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 px-1">Notifications</h2>
            <div className="bg-card border border-border rounded-2xl overflow-hidden divide-y divide-border">
              <button onClick={() => navigate('/settings/notifications')} className="w-full flex items-center gap-3 px-4 py-3.5 hover:bg-muted/50 transition-colors text-left">
                <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                  <Bell className="w-4 h-4 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground">Push Notifications</p>
                  <p className="text-xs text-muted-foreground">Manage global and per-contact alerts</p>
                </div>
                <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
              </button>
            </div>
          </section>

          {/* ── Customization ───────────────────────────────────────── */}
          <section>
            <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 px-1">Customization</h2>
            <div className="bg-card border border-border rounded-2xl overflow-hidden divide-y divide-border">
              <button onClick={() => navigate('/settings/themes')} className="w-full flex items-center gap-3 px-4 py-3.5 hover:bg-muted/50 transition-colors text-left">
                <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                  <Palette className="w-4 h-4 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground">Themes</p>
                  <p className="text-xs text-muted-foreground">Select Light, Dark, Mint, or Olive Dusk</p>
                </div>
                <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
              </button>
              
              <button onClick={() => navigate('/settings/waveform')} className="w-full flex items-center gap-3 px-4 py-3.5 hover:bg-muted/50 transition-colors text-left">
                <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                  <Activity className="w-4 h-4 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground">Waveform</p>
                  <p className="text-xs text-muted-foreground">Customize style and color of voice waveforms</p>
                </div>
                <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
              </button>
            </div>
          </section>


          {/* ── Security ───────────────────────────────────────── */}
          <section>
            <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 px-1">Security</h2>
            <div className="bg-card border border-border rounded-2xl overflow-hidden divide-y divide-border">

              {/* Security & Privacy tab */}
              <button onClick={() => setSection('security')} className="w-full flex items-center gap-3 px-4 py-3.5 hover:bg-muted/50 transition-colors text-left">
                <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                  <Shield className="w-4 h-4 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground">Security &amp; Privacy</p>
                  <p className="text-xs text-muted-foreground">Typing, auto-lock, backup, sessions, discovery</p>
                </div>
                <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
              </button>

              {/* Block list */}
              <button onClick={() => setSection('blocklist')} className="w-full flex items-center gap-3 px-4 py-3.5 hover:bg-muted/50 transition-colors text-left">
                <div className="w-8 h-8 rounded-lg bg-destructive/10 flex items-center justify-center shrink-0">
                  <Ban className="w-4 h-4 text-destructive" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground">Blocked Users</p>
                  <p className="text-xs text-muted-foreground">Manage who you have blocked</p>
                </div>
                <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
              </button>

              {/* Recovery Phrase */}
              <button onClick={() => setSection('recovery')} className="w-full flex items-center gap-3 px-4 py-3.5 hover:bg-muted/50 transition-colors text-left">
                <div className="w-8 h-8 rounded-lg bg-amber-500/15 flex items-center justify-center shrink-0">
                  <KeyRound className="w-4 h-4 text-amber-500" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground">Recovery Phrase</p>
                  <p className="text-xs text-muted-foreground">View or regenerate your 12-word backup phrase</p>
                </div>
                <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
              </button>

              {/* Linked Devices */}
              <button onClick={() => navigate('/linked-devices')} className="w-full flex items-center gap-3 px-4 py-3.5 hover:bg-muted/50 transition-colors text-left">
                <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                  <Smartphone className="w-4 h-4 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground">Linked Devices</p>
                  <p className="text-xs text-muted-foreground">Manage devices linked to your account</p>
                </div>
                <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
              </button>
            </div>
          </section>

          {/* ── Developers and Testers ───────────────────────────────────────── */}
          <section className="mb-8">
            <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 px-1">Developers and Testers</h2>
            <div className="bg-card border border-border rounded-2xl overflow-hidden shadow-sm divide-y divide-border">
              <button 
                onClick={() => navigate('/docs')}
                className="w-full flex items-center gap-3 p-4 hover:bg-muted/50 transition-colors text-left"
              >
                <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                  <BookOpen className="w-4 h-4 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground">Documentation</p>
                  <p className="text-xs text-muted-foreground">Whitepaper, Troubleshooting & License</p>
                </div>
                <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
              </button>
              
              <button 
                onClick={() => navigate('/docs/security-whitepaper')}
                className="w-full flex items-center gap-3 p-4 hover:bg-muted/50 transition-colors text-left"
              >
                <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                  <Shield className="w-4 h-4 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground">Security Whitepaper</p>
                  <p className="text-xs text-muted-foreground">Technical encryption flow documentation</p>
                </div>
                <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
              </button>
            </div>
          </section>

          {/* ── Support ───────────────────────────────────────── */}
          <section>
            <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 px-1">Support</h2>
            <div className="bg-card border border-border rounded-2xl overflow-hidden">
              <button
                onClick={() => navigate('/settings/troubleshooting')}
                className="w-full flex items-center gap-3 px-4 py-3.5 hover:bg-muted/50 transition-colors text-left"
              >
                <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                  <LifeBuoy className="w-4 h-4 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground">Troubleshooting</p>
                  <p className="text-xs text-muted-foreground">Common issues and quick fixes</p>
                </div>
                <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
              </button>
            </div>
          </section>

          {/* ── Danger Zone ────────────────────────────────────── */}
          <section>
            <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 px-1">Danger Zone</h2>
            <div className="bg-card border border-destructive/30 rounded-2xl overflow-hidden">
              <button onClick={() => { setDeleteDialogOpen(true); setDeletePassword(''); }}
                className="w-full flex items-center gap-3 px-4 py-3.5 hover:bg-destructive/5 transition-colors text-left">
                <div className="w-8 h-8 rounded-lg bg-destructive/10 flex items-center justify-center shrink-0">
                  <Trash2 className="w-4 h-4 text-destructive" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-destructive">Delete Account</p>
                  <p className="text-xs text-muted-foreground">Permanently delete your account and all data</p>
                </div>
                <ChevronRight className="w-4 h-4 text-destructive/60 shrink-0" />
              </button>
            </div>
          </section>

          {/* ── Keyboard shortcuts hint ────────────────────────── */}
          <section>
            <div className="bg-muted/50 border border-border rounded-2xl p-4 space-y-2">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Keyboard Shortcuts</p>
              <div className="space-y-1.5">
                {[
                  ['Ctrl + K', 'Focus search'],
                  ['Ctrl + Alt + N', 'Add new contact'],
                  ['Ctrl + Shift + D', 'Toggle light/dark theme'],
                  ['Ctrl + Shift + M', 'Focus message input'],
                  ['Ctrl + ,', 'Open settings'],
                  ['Escape', 'Close dialog / deselect chat'],
                ].map(([key, desc]) => (
                  <div key={key} className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">{desc}</span>
                    <kbd className="text-xs font-mono bg-background border border-border rounded px-1.5 py-0.5 text-foreground">{key}</kbd>
                  </div>
                ))}
              </div>
            </div>
          </section>

        </div>
      </div>

      {/* Delete Account Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={open => { setDeleteDialogOpen(open); if (!open) setDeletePassword(''); }}>
        <AlertDialogContent className="max-w-[calc(100%-2rem)] md:max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="w-5 h-5 shrink-0" />
              Delete Account Permanently?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-pretty">
              This action <strong>cannot be undone</strong>. Your account, profile, and all locally stored messages, contacts, and groups will be permanently deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="px-1 py-2">
            <label className="text-sm font-medium text-foreground block mb-1.5">Enter your password to confirm</label>
            <div className="relative">
              <input type={showDeletePassword ? 'text' : 'password'} value={deletePassword}
                onChange={e => setDeletePassword(e.target.value)}
                placeholder="Your password"
                className="w-full px-3 pr-10 py-2 text-sm bg-muted border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-destructive/50"
                onKeyDown={e => e.key === 'Enter' && handleDeleteAccount()} />
              <button type="button" onClick={() => setShowDeletePassword(v => !v)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors">
                {showDeletePassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletingAccount}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteAccount} disabled={deletingAccount || !deletePassword.trim()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              {deletingAccount ? 'Deleting...' : 'Yes, Delete Forever'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Image Crop Dialog */}
      {cropSrc && (
        <ImageCropDialog
          open={cropOpen}
          imageSrc={cropSrc}
          onCrop={handleCropComplete}
          onCancel={() => { setCropOpen(false); if (cropSrc) URL.revokeObjectURL(cropSrc); setCropSrc(null); }}
        />
      )}

      {/* Suppress unused import warnings */}
      <span className="hidden"><Check /><XCircle /><Info /><History /><ShieldCheck /></span>
    </div>
  );
}

