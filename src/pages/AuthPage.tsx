import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Shield, Eye, EyeOff, AlertCircle, CheckCircle2, Lock, KeyRound, Download, Copy } from 'lucide-react';
import { estimatePasswordStrength } from '@/lib/zxcvbn';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/contexts/AuthContext';
import SplashScreen from '@/components/SplashScreen';
import logoUrl from '@/assets/logo.svg';
import { isValidMnemonic } from '@/lib/mnemonic';
import { supabase } from '@/db/supabase';

type Mode = 'login' | 'register-username' | 'register-password' | 'forgot-password' | 'migrate-password';

/** Returns null if valid, or an error string */
function validatePassword(p: string): string | null {
  if (p.length < 6 || p.length > 20) return 'Password must be 6–20 characters.';
  if (!/[A-Z]/.test(p)) return 'Must include at least 1 uppercase letter.';
  if (!/[a-z]/.test(p)) return 'Must include at least 1 lowercase letter.';
  if (!/[0-9]/.test(p)) return 'Must include at least 1 number.';
  if (!/[^a-zA-Z0-9]/.test(p)) return 'Must include at least 1 special character.';
  return null;
}

interface Requirement { label: string; met: (p: string) => boolean }
const REQUIREMENTS: Requirement[] = [
  { label: '6–20 characters',          met: p => p.length >= 6 && p.length <= 20 },
  { label: '1 uppercase letter',        met: p => /[A-Z]/.test(p) },
  { label: '1 lowercase letter',        met: p => /[a-z]/.test(p) },
  { label: '1 number',                  met: p => /[0-9]/.test(p) },
  { label: '1 special character',       met: p => /[^a-zA-Z0-9]/.test(p) },
];

function PasswordRequirements({ password }: { password: string }) {
  if (!password) return null;
  return (
    <ul className="mt-2 space-y-1">
      {REQUIREMENTS.map(r => (
        <li key={r.label} className={`flex items-center gap-1.5 text-xs ${r.met(password) ? 'text-green-500' : 'text-muted-foreground'}`}>
          {r.met(password)
            ? <CheckCircle2 className="w-3 h-3 shrink-0 text-green-500" />
            : <AlertCircle className="w-3 h-3 shrink-0" />}
          {r.label}
        </li>
      ))}
    </ul>
  );
}

// ── Password Strength Meter ──────────────────────────────────────────────────
function StrengthMeter({ password }: { password: string }) {
  if (!password) return null;
  const strength = estimatePasswordStrength(password);
  const segments = 4;
  const filled = strength.score + 1; // 0–4 → 1–5 bars for visual clarity

  return (
    <div className="space-y-1 mt-2">
      <div className="flex gap-1">
        {Array.from({ length: segments }).map((_, i) => (
          <div
            key={i}
            className={`h-1.5 flex-1 rounded-full transition-colors ${
              i < filled ? strength.color : 'bg-muted'
            }`}
          />
        ))}
      </div>
      <div className="flex items-center justify-between">
        <span className={`text-xs font-medium ${strength.score >= 3 ? 'text-green-500' : strength.score >= 2 ? 'text-yellow-500' : 'text-destructive'}`}>
          {strength.label}
        </span>
        <span className="text-[10px] text-muted-foreground">
          {strength.crackTimeDisplay}
        </span>
      </div>
      {strength.feedback && (
        <p className="text-[10px] text-muted-foreground">{strength.feedback}</p>
      )}
    </div>
  );
}

// ── Mnemonic Reveal Modal ────────────────────────────────────────────────────
function MnemonicModal({ mnemonic, username, onClose }: {
  mnemonic: string;
  username: string;
  onClose: () => void;
}) {
  const words = mnemonic.split(' ');
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(mnemonic).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const handleDownload = () => {
    const content = [
      'ShadowCrypt Recovery Phrase',
      '============================',
      `Account: @${username}`,
      `Generated: ${new Date().toISOString()}`,
      '',
      'Store this file somewhere safe. Do NOT share it with anyone.',
      '',
      mnemonic,
      '',
      'Words in order:',
      ...words.map((w, i) => `${i + 1}. ${w}`),
    ].join('\n');
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ShadowCrypt_${username}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="bg-card border border-border rounded-2xl shadow-xl w-full max-w-sm space-y-5 p-6">
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-amber-500/15 flex items-center justify-center shrink-0">
              <KeyRound className="w-4 h-4 text-amber-500" />
            </div>
            <h2 className="text-base font-semibold text-foreground">Save your recovery phrase</h2>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed text-pretty">
            Write down or download these <strong className="text-foreground">12 words in order</strong>.
            They are the <strong className="text-foreground">only way</strong> to recover your account
            if you forget your password. <span className="text-destructive font-medium">Never share them with anyone.</span>
          </p>
        </div>

        {/* Word grid */}
        <div className="grid grid-cols-3 gap-2">
          {words.map((word, i) => (
            <div key={i} className="flex items-center gap-1.5 bg-muted rounded-lg px-2 py-1.5">
              <span className="text-xs text-muted-foreground w-4 shrink-0">{i + 1}.</span>
              <span className="text-sm font-mono font-medium text-foreground">{word}</span>
            </div>
          ))}
        </div>

        {/* Actions */}
        <div className="flex gap-2">
          <Button variant="outline" className="flex-1 h-9 gap-1.5 text-sm" onClick={handleCopy}>
            {copied ? <CheckCircle2 className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
            {copied ? 'Copied!' : 'Copy'}
          </Button>
          <Button variant="outline" className="flex-1 h-9 gap-1.5 text-sm" onClick={handleDownload}>
            <Download className="w-3.5 h-3.5" />
            Download
          </Button>
        </div>

        <Button
          className="w-full h-10 bg-primary text-primary-foreground hover:bg-primary/90 font-medium"
          onClick={onClose}
        >
          I've saved my recovery phrase
        </Button>
      </div>
    </div>
  );
}

export default function AuthPage() {
  const {
    signInWithUsername, signUpWithUsername, checkUsernameAvailable,
    migrateToNewPassword, generateAndStoreMnemonic, resetPasswordWithMnemonic,
  } = useAuth();
  const navigate = useNavigate();

  const [mode, setMode] = useState<Mode>('login');
  const [username, setUsername] = useState('');

  // Login fields
  const [loginPassword, setLoginPassword] = useState('');
  const [showLoginPassword, setShowLoginPassword] = useState(false);

  // Register fields
  const [regPassword, setRegPassword] = useState('');
  const [regConfirm, setRegConfirm] = useState('');
  const [showRegPassword, setShowRegPassword] = useState(false);
  const [regError, setRegError] = useState('');

  // Migration fields
  const [migratePassword, setMigratePassword] = useState('');
  const [migrateConfirm, setMigrateConfirm] = useState('');
  const [showMigratePassword, setShowMigratePassword] = useState(false);
  const [migrateError, setMigrateError] = useState('');

  // Forgot password fields
  const [forgotMnemonic, setForgotMnemonic] = useState('');
  const [forgotNewPassword, setForgotNewPassword] = useState('');
  const [forgotConfirm, setForgotConfirm] = useState('');
  const [showForgotPassword, setShowForgotPassword] = useState(false);
  const [forgotError, setForgotError] = useState('');
  const [forgotStep, setForgotStep] = useState<'mnemonic' | 'password'>('mnemonic');

  const [loading, setLoading] = useState(false);
  const [usernameError, setUsernameError] = useState('');
  const [showSplash, setShowSplash] = useState(false);
  const [mnemonicToShow, setMnemonicToShow] = useState<string | null>(null);
  const [pendingSplash, setPendingSplash] = useState(false);

  // Usernames are always lowercase (Supabase normalises emails before the DB
  // trigger stores split_part(email,'@',1)). Allow only lowercase so what the
  // user types is exactly what is stored and looked up.
  const validateUsername = (val: string) => /^[a-z0-9_]{3,20}$/.test(val);

  const handleLogin = async () => {
    if (!validateUsername(username)) { toast.error('Invalid username format.'); return; }
    if (!loginPassword) { toast.error('Please enter your password.'); return; }
    setLoading(true);
    try {
      const { error } = await signInWithUsername(username, loginPassword);
      if (error) { toast.error('Invalid username or password.'); return; }
      // Fetch the current authenticated user so we can query by ID (case-safe)
      const { data: { user: currentUser } } = await supabase.auth.getUser();
      if (!currentUser) { toast.error('Session error.'); return; }
      const { data: profile } = await supabase
        .from('profiles')
        .select('password_version')
        .eq('id', currentUser.id)
        .maybeSingle();
      if ((profile?.password_version ?? 0) < 1) {
        setMode('migrate-password');
      } else {
        setShowSplash(true);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleCheckUsername = async () => {
    if (!validateUsername(username)) {
      setUsernameError('Username must be 3–20 characters: letters, numbers, underscore.');
      return;
    }
    setLoading(true);
    setUsernameError('');
    try {
      const available = await checkUsernameAvailable(username);
      if (!available) { setUsernameError('Username is already taken. Please choose another.'); return; }
      setMode('register-password');
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async () => {
    const err = validatePassword(regPassword);
    if (err) { setRegError(err); return; }
    if (regPassword !== regConfirm) { setRegError('Passwords do not match.'); return; }
    setRegError('');
    setLoading(true);
    try {
      const { error } = await signUpWithUsername(username, regPassword);
      if (error) { toast.error(error.message || 'Registration failed.'); return; }
      // Generate and reveal mnemonic for new user
      const { mnemonic, error: mnemonicErr } = await generateAndStoreMnemonic();
      if (mnemonicErr || !mnemonic) { toast.error('Account created but failed to generate recovery phrase.'); setShowSplash(true); return; }
      setPendingSplash(true);
      setMnemonicToShow(mnemonic);
    } finally {
      setLoading(false);
    }
  };

  const handleMigrate = async () => {
    const err = validatePassword(migratePassword);
    if (err) { setMigrateError(err); return; }
    if (migratePassword !== migrateConfirm) { setMigrateError('Passwords do not match.'); return; }
    setMigrateError('');
    setLoading(true);
    try {
      const { error } = await migrateToNewPassword(migratePassword);
      if (error) { toast.error(error.message || 'Migration failed. Please try again.'); return; }
      // Generate and reveal mnemonic for migrated user
      const { mnemonic, error: mnemonicErr } = await generateAndStoreMnemonic();
      if (mnemonicErr || !mnemonic) { toast.success('Password updated.'); setShowSplash(true); return; }
      toast.success('Password updated successfully.');
      setPendingSplash(true);
      setMnemonicToShow(mnemonic);
    } finally {
      setLoading(false);
    }
  };

  const handleForgotVerifyMnemonic = () => {
    const normalized = forgotMnemonic.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!isValidMnemonic(normalized)) {
      setForgotError('Invalid recovery phrase. Please check all 12 words and their order.');
      return;
    }
    setForgotError('');
    setForgotStep('password');
  };

  const handleForgotResetPassword = async () => {
    if (!validateUsername(username)) { setForgotError('Enter a valid username first.'); return; }
    const err = validatePassword(forgotNewPassword);
    if (err) { setForgotError(err); return; }
    if (forgotNewPassword !== forgotConfirm) { setForgotError('Passwords do not match.'); return; }
    setForgotError('');
    setLoading(true);
    try {
      const { error } = await resetPasswordWithMnemonic(username, forgotMnemonic, forgotNewPassword);
      if (error) { setForgotError(error.message || 'Reset failed. Please try again.'); return; }
      toast.success('Password reset successfully. Please sign in with your new password.');
      setMode('login');
      setLoginPassword('');
      setForgotMnemonic('');
      setForgotNewPassword('');
      setForgotConfirm('');
      setForgotStep('mnemonic');
    } finally {
      setLoading(false);
    }
  };

  if (showSplash) return <SplashScreen onComplete={() => navigate('/chat')} />;

  return (
    <>
      {/* Mnemonic reveal modal */}
      {mnemonicToShow && (
        <MnemonicModal
          mnemonic={mnemonicToShow}
          username={username}
          onClose={() => {
            setMnemonicToShow(null);
            if (pendingSplash) { setPendingSplash(false); setShowSplash(true); }
          }}
        />
      )}

      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <div className="w-full max-w-sm space-y-6">
          {/* Logo + brand */}
          <div className="flex flex-col items-center gap-3">
            <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center overflow-hidden">
              <img src={logoUrl} alt="ShadowCrypt" className="w-12 h-12 object-contain" />
            </div>
            <div className="text-center">
              <h1 className="text-2xl font-bold text-foreground tracking-tight">ShadowCrypt</h1>
              <p className="text-sm text-muted-foreground mt-0.5">Zero-knowledge encrypted messaging</p>
            </div>
          </div>

          {/* Card */}
          <div className="bg-card border border-border rounded-2xl p-6 shadow-sm space-y-5">

            {/* ── LOGIN ── */}
            {mode === 'login' && (
              <>
                <div className="space-y-1">
                  <h2 className="text-lg font-semibold text-foreground">Sign in</h2>
                  <p className="text-sm text-muted-foreground">Enter your username and password to continue.</p>
                </div>
                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <Label className="text-sm font-normal text-foreground">Username</Label>
                    <Input value={username} onChange={e => setUsername(e.target.value.trim().toLowerCase())}
                      placeholder="your_username" className="bg-input border-border px-3 h-10 text-sm"
                      onKeyDown={e => e.key === 'Enter' && document.getElementById('login-pwd')?.focus()} />
                  </div>
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <Label className="text-sm font-normal text-foreground">Password</Label>
                      <button type="button" onClick={() => setShowLoginPassword(v => !v)}
                        className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1">
                        {showLoginPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                        {showLoginPassword ? 'Hide' : 'Show'}
                      </button>
                    </div>
                    <Input id="login-pwd" type={showLoginPassword ? 'text' : 'password'}
                      value={loginPassword} onChange={e => setLoginPassword(e.target.value)}
                      placeholder="••••••••" className="bg-input border-border px-3 h-10 text-sm"
                      onKeyDown={e => e.key === 'Enter' && handleLogin()} />
                    <div className="flex justify-end">
                      <button type="button" onClick={() => { setMode('forgot-password'); setForgotStep('mnemonic'); setForgotError(''); }}
                        className="text-xs text-primary hover:underline">
                        Forgot password?
                      </button>
                    </div>
                  </div>
                  <Button className="w-full h-10 bg-primary text-primary-foreground hover:bg-primary/90 font-medium"
                    onClick={handleLogin} disabled={loading}>
                    {loading ? 'Signing in…' : 'Sign In'}
                  </Button>
                </div>
                <div className="text-center">
                  <span className="text-sm text-muted-foreground">New to ShadowCrypt? </span>
                  <button className="text-sm text-primary hover:underline font-medium"
                    onClick={() => { setMode('register-username'); setUsername(''); setLoginPassword(''); }}>
                    Create account
                  </button>
                </div>
              </>
            )}

            {/* ── REGISTER: USERNAME ── */}
            {mode === 'register-username' && (
              <>
                <div className="space-y-1">
                  <h2 className="text-lg font-semibold text-foreground">Create account</h2>
                  <p className="text-sm text-muted-foreground">Choose a unique username (3–20 chars).</p>
                </div>
                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <Label className="text-sm font-normal text-foreground">Username</Label>
                    <Input value={username}
                      onChange={e => { setUsername(e.target.value.trim().toLowerCase()); setUsernameError(''); }}
                      placeholder="choose_a_username" className="bg-input border-border px-3 h-10 text-sm"
                      onKeyDown={e => e.key === 'Enter' && handleCheckUsername()} />
                    {usernameError && (
                      <p className="text-destructive text-xs flex items-center gap-1">
                        <AlertCircle className="w-3 h-3 shrink-0" />{usernameError}
                      </p>
                    )}
                  </div>
                  <Button className="w-full h-10 bg-primary text-primary-foreground hover:bg-primary/90 font-medium"
                    onClick={handleCheckUsername} disabled={loading || !username}>
                    {loading ? 'Checking…' : 'Continue'}
                  </Button>
                </div>
                <button className="text-sm text-muted-foreground hover:text-foreground w-full text-center"
                  onClick={() => setMode('login')}>← Back to sign in</button>
              </>
            )}

            {/* ── REGISTER: PASSWORD ── */}
            {mode === 'register-password' && (
              <>
                <div className="space-y-1">
                  <h2 className="text-lg font-semibold text-foreground">Set your password</h2>
                  <p className="text-sm text-muted-foreground">
                    Create a secure password for <span className="font-medium text-foreground">@{username}</span>.
                  </p>
                </div>
                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <Label className="text-sm font-normal text-foreground">Password</Label>
                      <button type="button" onClick={() => setShowRegPassword(v => !v)}
                        className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1">
                        {showRegPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                        {showRegPassword ? 'Hide' : 'Show'}
                      </button>
                    </div>
                    <Input type={showRegPassword ? 'text' : 'password'}
                      value={regPassword} onChange={e => { setRegPassword(e.target.value); setRegError(''); }}
                      placeholder="••••••••" className="bg-input border-border px-3 h-10 text-sm" />
                    <PasswordRequirements password={regPassword} />
                    <StrengthMeter password={regPassword} />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-sm font-normal text-foreground">Confirm Password</Label>
                    <Input type={showRegPassword ? 'text' : 'password'}
                      value={regConfirm} onChange={e => { setRegConfirm(e.target.value); setRegError(''); }}
                      placeholder="••••••••" className="bg-input border-border px-3 h-10 text-sm"
                      onKeyDown={e => e.key === 'Enter' && handleRegister()} />
                  </div>
                  {regError && (
                    <p className="text-destructive text-xs flex items-center gap-1">
                      <AlertCircle className="w-3 h-3 shrink-0" />{regError}
                    </p>
                  )}
                  <Button className="w-full h-10 bg-primary text-primary-foreground hover:bg-primary/90 font-medium"
                    onClick={handleRegister} disabled={loading}>
                    {loading ? 'Creating account…' : 'Create Account'}
                  </Button>
                </div>
                <button className="text-sm text-muted-foreground hover:text-foreground w-full text-center"
                  onClick={() => setMode('register-username')}>← Back</button>
              </>
            )}

            {/* ── FORGOT PASSWORD ── */}
            {mode === 'forgot-password' && (
              <>
                <div className="space-y-1">
                  <h2 className="text-lg font-semibold text-foreground">Recover your account</h2>
                  <p className="text-sm text-muted-foreground">
                    {forgotStep === 'mnemonic'
                      ? 'Enter your username and 12-word recovery phrase.'
                      : 'Create a new password for your account.'}
                  </p>
                </div>
                <div className="space-y-4">
                  {forgotStep === 'mnemonic' && (
                    <>
                      <div className="space-y-1.5">
                        <Label className="text-sm font-normal text-foreground">Username</Label>
                        <Input value={username} onChange={e => { setUsername(e.target.value.trim().toLowerCase()); setForgotError(''); }}
                          placeholder="your_username" className="bg-input border-border px-3 h-10 text-sm" />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-sm font-normal text-foreground">12-Word Recovery Phrase</Label>
                        <textarea
                          value={forgotMnemonic}
                          onChange={e => { setForgotMnemonic(e.target.value); setForgotError(''); }}
                          placeholder="word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12"
                          rows={3}
                          className="w-full px-3 py-2 text-sm bg-input border border-border rounded-md text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 resize-none"
                        />
                        <p className="text-xs text-muted-foreground">Enter all 12 words separated by spaces.</p>
                      </div>
                    </>
                  )}
                  {forgotStep === 'password' && (
                    <>
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between">
                          <Label className="text-sm font-normal text-foreground">New Password</Label>
                          <button type="button" onClick={() => setShowForgotPassword(v => !v)}
                            className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1">
                            {showForgotPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                            {showForgotPassword ? 'Hide' : 'Show'}
                          </button>
                        </div>
                        <Input type={showForgotPassword ? 'text' : 'password'}
                          value={forgotNewPassword} onChange={e => { setForgotNewPassword(e.target.value); setForgotError(''); }}
                          placeholder="••••••••" className="bg-input border-border px-3 h-10 text-sm" />
                        <PasswordRequirements password={forgotNewPassword} />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-sm font-normal text-foreground">Confirm Password</Label>
                        <Input type={showForgotPassword ? 'text' : 'password'}
                          value={forgotConfirm} onChange={e => { setForgotConfirm(e.target.value); setForgotError(''); }}
                          placeholder="••••••••" className="bg-input border-border px-3 h-10 text-sm"
                          onKeyDown={e => e.key === 'Enter' && handleForgotResetPassword()} />
                      </div>
                    </>
                  )}
                  {forgotError && (
                    <p className="text-destructive text-xs flex items-center gap-1">
                      <AlertCircle className="w-3 h-3 shrink-0" />{forgotError}
                    </p>
                  )}
                  <Button className="w-full h-10 bg-primary text-primary-foreground hover:bg-primary/90 font-medium"
                    onClick={forgotStep === 'mnemonic' ? handleForgotVerifyMnemonic : handleForgotResetPassword}
                    disabled={loading}>
                    {loading ? 'Please wait…' : forgotStep === 'mnemonic' ? 'Verify Recovery Phrase' : 'Reset Password'}
                  </Button>
                </div>
                <button className="text-sm text-muted-foreground hover:text-foreground w-full text-center"
                  onClick={() => { setMode('login'); setForgotStep('mnemonic'); setForgotError(''); }}>
                  ← Back to sign in
                </button>
              </>
            )}

            {/* ── MIGRATE PASSWORD ── */}
            {mode === 'migrate-password' && (
              <>
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-lg bg-amber-500/15 flex items-center justify-center shrink-0">
                      <KeyRound className="w-4 h-4 text-amber-500" />
                    </div>
                    <h2 className="text-base font-semibold text-foreground">Security upgrade required</h2>
                  </div>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    We have shifted from 6-digit pin-based authentication to a 6–20 character-based
                    authentication method. Please create a new password.
                  </p>
                </div>
                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <Label className="text-sm font-normal text-foreground">New Password</Label>
                      <button type="button" onClick={() => setShowMigratePassword(v => !v)}
                        className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1">
                        {showMigratePassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                        {showMigratePassword ? 'Hide' : 'Show'}
                      </button>
                    </div>
                    <Input type={showMigratePassword ? 'text' : 'password'}
                      value={migratePassword} onChange={e => { setMigratePassword(e.target.value); setMigrateError(''); }}
                      placeholder="••••••••" className="bg-input border-border px-3 h-10 text-sm" />
                    <PasswordRequirements password={migratePassword} />
                    <StrengthMeter password={migratePassword} />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-sm font-normal text-foreground">Confirm Password</Label>
                    <Input type={showMigratePassword ? 'text' : 'password'}
                      value={migrateConfirm} onChange={e => { setMigrateConfirm(e.target.value); setMigrateError(''); }}
                      placeholder="••••••••" className="bg-input border-border px-3 h-10 text-sm"
                      onKeyDown={e => e.key === 'Enter' && handleMigrate()} />
                  </div>
                  {migrateError && (
                    <p className="text-destructive text-xs flex items-center gap-1">
                      <AlertCircle className="w-3 h-3 shrink-0" />{migrateError}
                    </p>
                  )}
                  <Button className="w-full h-10 bg-primary text-primary-foreground hover:bg-primary/90 font-medium"
                    onClick={handleMigrate} disabled={loading}>
                    {loading ? 'Updating password…' : 'Set New Password'}
                  </Button>
                </div>
              </>
            )}
          </div>

          {/* E2E note + privacy */}
          <div className="space-y-2">
            <div className="flex items-center gap-2 justify-center text-xs text-muted-foreground">
              <Shield className="w-3.5 h-3.5 text-primary shrink-0" />
              <span>End-to-end encrypted · Zero-knowledge relay · Keys never leave your device</span>
            </div>
            <div className="flex items-center gap-2 justify-center text-xs text-muted-foreground">
              <Lock className="w-3.5 h-3.5 shrink-0" />
              <span>By creating an account you agree to the </span>
              <Link to="/privacy" className="text-primary hover:underline">Privacy Policy</Link>
            </div>
            {mode === 'register-username' && (
              <div className="flex items-center gap-2 justify-center text-xs text-muted-foreground">
                <CheckCircle2 className="w-3.5 h-3.5 text-primary shrink-0" />
                <span>No email or phone required · Pseudonymous by design</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
