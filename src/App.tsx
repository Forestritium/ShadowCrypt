import React, { Suspense, lazy } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from '@/components/ui/sonner';
import { AuthProvider } from '@/contexts/AuthContext';
import { ThemeProvider } from '@/contexts/ThemeContext';
import AuthPage from '@/pages/AuthPage';
import { usePWAInstall } from '@/hooks/usePWAInstall';
import { Download, X, Loader2 } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useEffect } from 'react';
import { syncPushIdentityKey } from '@/lib/pushService';

const ChatPage = lazy(() => import('@/pages/ChatPage'));
const AddContactPage = lazy(() => import('@/pages/AddContactPage'));
const SettingsPage = lazy(() => import('@/pages/SettingsPage'));
const LinkedDevicesPage = lazy(() => import('@/pages/LinkedDevicesPage'));
const NotificationSettingsPage = lazy(() => import('@/pages/NotificationSettingsPage'));
const ThemesPage = lazy(() => import('@/pages/ThemesPage'));
const WaveformSettingsPage = lazy(() => import('@/pages/WaveformSettingsPage'));
const TroubleshootingPage = lazy(() => import('@/pages/TroubleshootingPage'));
const SafetyNumberPage = lazy(() => import('@/pages/SafetyNumberPage'));
const PrivacyPolicyPage = lazy(() => import('@/pages/PrivacyPolicyPage'));
const SecurityWhitepaperPage = lazy(() => import('@/pages/SecurityWhitepaperPage'));

const DocsHomePage = lazy(() => import('@/pages/DocsHomePage'));
const LicensePage = lazy(() => import('@/pages/LicensePage'));

function AuthInitializing() {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-4">
        <Loader2 className="w-10 h-10 animate-spin text-primary" />
        <p className="text-sm text-muted-foreground">Unlocking SylvaCrypt…</p>
      </div>
    </div>
  );
}

function PWAInstallBanner() {
  const { showBanner, install, dismiss } = usePWAInstall();
  if (!showBanner) return null;
  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 bg-card border border-border rounded-2xl shadow-lg px-4 py-3 max-w-sm w-[calc(100%-2rem)] animate-in slide-in-from-bottom-4 duration-300">
      <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
        <Download className="w-4 h-4 text-primary" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-foreground">Install SylvaCrypt</p>
        <p className="text-xs text-muted-foreground">Add to home screen for the best experience</p>
      </div>
      <button onClick={install} className="text-xs font-semibold text-primary hover:text-primary/80 shrink-0 px-2 py-1 rounded-lg hover:bg-primary/10 transition-colors">
        Install
      </button>
      <button onClick={dismiss} className="text-muted-foreground hover:text-foreground shrink-0" aria-label="Dismiss">
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

const App: React.FC = () => {
  return (
    <ThemeProvider>
      <Router>
        <AuthProvider>
          <AppRoutes />
        </AuthProvider>
      </Router>
    </ThemeProvider>
  );
};

function PageLoader() {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-4">
        <Loader2 className="w-10 h-10 animate-spin text-primary" />
        <p className="text-sm text-muted-foreground">Loading SylvaCrypt…</p>
      </div>
    </div>
  );
}

function AppRoutes() {
  const { loading, user } = useAuth();

  useEffect(() => {
    if (user?.id) {
      syncPushIdentityKey(user.id).catch(() => {});
    }
  }, [user?.id]);

  if (loading) return <AuthInitializing />;

  return (
    <Suspense fallback={<PageLoader />}>
      <Routes>
        <Route path="/auth" element={<AuthPage />} />
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/add-contact" element={<AddContactPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/linked-devices" element={<LinkedDevicesPage />} />
        <Route path="/settings/notifications" element={<NotificationSettingsPage />} />
        <Route path="/settings/themes" element={<ThemesPage />} />
        <Route path="/settings/waveform" element={<WaveformSettingsPage />} />
        <Route path="/docs" element={<DocsHomePage />} />
        <Route path="/docs/security-whitepaper" element={<SecurityWhitepaperPage />} />
        <Route path="/docs/troubleshooting" element={<TroubleshootingPage />} />
        <Route path="/docs/license" element={<LicensePage />} />
        
        <Route path="/safety-number/:contactId" element={<SafetyNumberPage />} />
        <Route path="/privacy" element={<PrivacyPolicyPage />} />
        
        {/* Legacy redirect for settings links */}
        <Route path="/settings/security-whitepaper" element={<Navigate to="/docs/security-whitepaper" replace />} />
        <Route path="/settings/troubleshooting" element={<Navigate to="/docs/troubleshooting" replace />} />
        <Route path="/" element={<Navigate to="/auth" replace />} />
        <Route path="*" element={<Navigate to="/auth" replace />} />
      </Routes>
      <Toaster position="top-right" richColors closeButton />
      <PWAInstallBanner />
    </Suspense>
  );
}

export default App;
