import { useState, useEffect, useCallback, useRef } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import CaseDashboardPage from './pages/cases/CaseDashboardPage';
import CasePage from './pages/cases/CasePage';
import LoginPage from './pages/auth/LoginPage';
import RegisterPage from './pages/auth/RegisterPage';
import TermsPage from './pages/TermsPage';
import PrivacyPage from './pages/PrivacyPage';
import OfflineBanner from './components/common/OfflineBanner';
import LockScreen from './components/common/LockScreen';
import { getActiveKey, isEncryptionSetup, isUnlocked, lock, setActiveKey, setupEncryption, unlock, verifyKey } from './services/crypto';
import { forgetSessionKey, rememberSessionKey, restoreSessionKey } from './services/sessionKey';
import { whenBackgroundWorkIdle } from './services/backgroundWork';
import { loadAllReturns, clearReturnCache } from './api/client';
import { useDeductionFinderStore } from './store/deductionFinderStore';
import { preparerSeatActive, useAuthHydrated, useAuthStore } from './store/authStore';
import PreparerPaywallPage from './pages/preparer/PreparerPaywallPage';

type AppState = 'initializing' | 'lock-setup' | 'lock-unlock' | 'unlocked';

const AUTO_LOCK_MS = 15 * 60 * 1000;

export default function PreparerApp() {
  const [appState, setAppState] = useState<AppState>('initializing');
  const [lockError, setLockError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hiddenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const authHydrated = useAuthHydrated();
  const { isAuthenticated, user, fetchMe } = useAuthStore();
  const location = useLocation();

  // A locked screen whose key waits for the local AI's running work (lockScreen).
  const cancelDeferredLock = useRef<(() => void) | null>(null);

  /**
   * The idle and hidden-window locks: the screen locks at once; the key and the
   * decrypted cases are forgotten when the local AI's running work — a batch
   * of documents, a client's reply — has saved (services/backgroundWork).
   */
  const lockScreen = useCallback(() => {
    setAppState('lock-unlock');
    // A reload of the locked screen must ask for the passphrase, even while work saves.
    void forgetSessionKey();
    cancelDeferredLock.current?.();
    cancelDeferredLock.current = whenBackgroundWorkIdle(() => {
      cancelDeferredLock.current = null;
      lock();
      clearReturnCache();
      useDeductionFinderStore.getState().clearDecryptedState?.();
    });
  }, []);

  const handleUnlock = async (passphrase: string): Promise<boolean> => {
    setLockError(null);
    try {
      if (appState === 'lock-setup') {
        await setupEncryption(passphrase);
        await rememberSessionKey(getActiveKey()!);
        await loadAllReturns();
        await useDeductionFinderStore.getState().loadDecrypted?.();
        await useAuthStore.getState().loadDecrypted();
        setAppState('unlocked');
        return true;
      }
      // The screen locked while work was still saving: the cases in memory are current.
      const keyStillHeld = isUnlocked();
      const ok = await unlock(passphrase);
      if (ok && keyStillHeld) {
        cancelDeferredLock.current?.();
        cancelDeferredLock.current = null;
        await rememberSessionKey(getActiveKey()!);
        setAppState('unlocked');
      } else if (ok) {
        // Kept for this browser session, so a reload does not ask again (services/sessionKey).
        await rememberSessionKey(getActiveKey()!);
        await loadAllReturns();
        await useDeductionFinderStore.getState().loadDecrypted?.();
        await useAuthStore.getState().loadDecrypted();
        setAppState('unlocked');
      }
      return ok;
    } catch {
      setLockError('Something went wrong. Please try again.');
      return false;
    }
  };

  useEffect(() => {
    let live = true;
    void (async () => {
      // A reload within an unlocked session: that session's key, checked against the vault.
      if (!isUnlocked() && isEncryptionSetup()) {
        const kept = await restoreSessionKey();
        if (kept && (await verifyKey(kept))) setActiveKey(kept);
      }
      if (!live) return;
      if (isUnlocked()) {
        await loadAllReturns();
        await useDeductionFinderStore.getState().loadDecrypted?.();
        await useAuthStore.getState().loadDecrypted();
        if (live) setAppState('unlocked');
      } else if (isEncryptionSetup()) {
        setAppState('lock-unlock');
      } else {
        setAppState('lock-setup');
      }
    })();
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (appState !== 'unlocked') return;
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden' && isEncryptionSetup()) {
        hiddenTimerRef.current = setTimeout(lockScreen, 30_000);
      } else if (hiddenTimerRef.current) {
        clearTimeout(hiddenTimerRef.current);
        hiddenTimerRef.current = null;
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      if (hiddenTimerRef.current) clearTimeout(hiddenTimerRef.current);
    };
  }, [appState, lockScreen]);

  const resetTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (appState !== 'unlocked') return;
    timerRef.current = setTimeout(lockScreen, AUTO_LOCK_MS);
  }, [appState, lockScreen]);

  useEffect(() => {
    if (appState !== 'unlocked') return;
    const events = ['mousedown', 'keydown', 'touchstart', 'scroll'] as const;
    events.forEach((e) => window.addEventListener(e, resetTimer));
    resetTimer();
    return () => {
      events.forEach((e) => window.removeEventListener(e, resetTimer));
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [appState, resetTimer]);

  useEffect(() => {
    if (appState === 'unlocked') {
      fetchMe();
    }
  }, [appState, fetchMe]);

  const publicPaths = ['/terms', '/privacy', '/preparer/login', '/preparer/register'];
  const isPublicPage = publicPaths.includes(location.pathname);

  if (isPublicPage) {
    return (
      <Routes>
        <Route path="/preparer/login" element={<LoginPage audience="preparer" />} />
        <Route path="/preparer/register" element={<RegisterPage audience="preparer" />} />
        <Route path="/terms" element={<TermsPage />} />
        <Route path="/privacy" element={<PrivacyPage />} />
      </Routes>
    );
  }

  if (appState === 'initializing') {
    return (
      <div className="min-h-screen bg-surface-900 flex items-center justify-center">
        <p className="text-slate-400 animate-pulse">Loading Preparer...</p>
      </div>
    );
  }

  const isLocked = appState === 'lock-setup' || appState === 'lock-unlock';

  const ProtectedRoute = ({ children }: { children: React.ReactNode }) => {
    if (isLocked) {
      return (
        <LockScreen
          mode={appState === 'lock-setup' ? 'setup' : 'unlock'}
          onUnlock={handleUnlock}
          error={lockError}
        />
      );
    }
    if (!authHydrated) {
      return (
        <div className="min-h-screen bg-surface-900 flex items-center justify-center">
          <p className="text-slate-400 animate-pulse">Loading...</p>
        </div>
      );
    }
    if (!isAuthenticated || (user?.role !== 'preparer' && user?.role !== 'admin')) {
      return <Navigate to="/preparer/login" replace />;
    }
    if (!preparerSeatActive(user)) {
      return <PreparerPaywallPage />;
    }
    return <>{children}</>;
  };

  return (
    <>
      <OfflineBanner />
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:bg-HATaxService-orange-500 focus:text-white focus:px-4 focus:py-2 focus:rounded-lg focus:shadow-lg focus:outline-none"
      >
        Skip to main content
      </a>
      <main id="main-content">
        <Routes>
          <Route path="/preparer/login" element={<LoginPage audience="preparer" />} />
          <Route path="/preparer/register" element={<RegisterPage audience="preparer" />} />
          <Route
            path="/preparer"
            element={
              <ProtectedRoute>
                <CaseDashboardPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/preparer/case/:id/:tab?"
            element={
              <ProtectedRoute>
                <CasePage />
              </ProtectedRoute>
            }
          />
          <Route path="/preparer/*" element={<Navigate to="/preparer" replace />} />
          <Route path="/" element={<Navigate to="/preparer" replace />} />
          <Route path="/terms" element={<TermsPage />} />
          <Route path="/privacy" element={<PrivacyPage />} />
          <Route path="*" element={<Navigate to="/preparer" replace />} />
        </Routes>
      </main>
    </>
  );
}
