import { useState, useEffect, useCallback, useRef } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import PreparerDashboardPage from './pages/preparer/PreparerDashboardPage';
import PreparerClientPage from './pages/preparer/PreparerClientPage';
import PreparerWizardPage from './pages/preparer/PreparerWizardPage';
import PledgePage from './pages/PledgePage';
import TermsPage from './pages/TermsPage';
import PrivacyPage from './pages/PrivacyPage';
import OfflineBanner from './components/common/OfflineBanner';
import LockScreen from './components/common/LockScreen';
import { isEncryptionSetup, isUnlocked, setupEncryption, unlock, lock } from './services/crypto';
import { loadAllReturns, clearReturnCache } from './api/client';
import { useAISettingsStore } from './store/aiSettingsStore';
import { useDeductionFinderStore } from './store/deductionFinderStore';

type AppState = 'initializing' | 'lock-setup' | 'lock-unlock' | 'unlocked';

const AUTO_LOCK_MS = 15 * 60 * 1000;

export default function PreparerApp() {
  const [appState, setAppState] = useState<AppState>('initializing');
  const [lockError, setLockError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (isUnlocked()) {
      loadAllReturns()
        .then(() => useAISettingsStore.getState().loadApiKey())
        .then(() => useDeductionFinderStore.getState().loadDecrypted?.())
        .then(() => setAppState('unlocked'));
    } else if (isEncryptionSetup()) {
      setAppState('lock-unlock');
    } else {
      setAppState('lock-setup');
    }
  }, []);

  useEffect(() => {
    if (appState !== 'unlocked') return;
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden' && isEncryptionSetup()) {
        hiddenTimerRef.current = setTimeout(() => {
          lock();
          clearReturnCache();
          useAISettingsStore.getState().clearDecryptedKey();
          useDeductionFinderStore.getState().clearDecryptedState?.();
          setAppState('lock-unlock');
        }, 30_000);
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
  }, [appState]);

  const hiddenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resetTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (appState !== 'unlocked') return;
    timerRef.current = setTimeout(() => {
      lock();
      clearReturnCache();
      useAISettingsStore.getState().clearDecryptedKey();
      useDeductionFinderStore.getState().clearDecryptedState?.();
      setAppState('lock-unlock');
    }, AUTO_LOCK_MS);
  }, [appState]);

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

  const handleUnlock = async (passphrase: string): Promise<boolean> => {
    setLockError(null);
    try {
      if (appState === 'lock-setup') {
        await setupEncryption(passphrase);
        await loadAllReturns();
        await useAISettingsStore.getState().loadApiKey();
        await useDeductionFinderStore.getState().loadDecrypted?.();
        setAppState('unlocked');
        return true;
      }
      const ok = await unlock(passphrase);
      if (ok) {
        await loadAllReturns();
        await useAISettingsStore.getState().loadApiKey();
        await useDeductionFinderStore.getState().loadDecrypted?.();
        setAppState('unlocked');
      }
      return ok;
    } catch {
      setLockError('Something went wrong. Please try again.');
      return false;
    }
  };

  const location = useLocation();
  const publicPaths = ['/pledge', '/terms', '/privacy'];
  const isPublicPage = publicPaths.includes(location.pathname);

  if (isPublicPage) {
    return (
      <Routes>
        <Route path="/pledge" element={<PledgePage />} />
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

  return (
    <>
      <OfflineBanner />
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:bg-telos-orange-500 focus:text-white focus:px-4 focus:py-2 focus:rounded-lg focus:shadow-lg focus:outline-none"
      >
        Skip to main content
      </a>
      <main id="main-content">
        <Routes>
          <Route path="/preparer" element={
            isLocked
              ? <PreparerDashboardPage lockMode={appState === 'lock-setup' ? 'setup' : 'unlock'} onUnlock={handleUnlock} lockError={lockError} />
              : <PreparerDashboardPage />
          } />
          <Route path="/preparer/clients" element={isLocked ? <Navigate to="/preparer" replace /> : <PreparerDashboardPage />} />
          <Route path="/preparer/client/:id" element={isLocked ? <Navigate to="/preparer" replace /> : <PreparerClientPage />} />
          <Route path="/preparer/return/:id/*" element={isLocked ? <Navigate to="/preparer" replace /> : <PreparerWizardPage />} />
          <Route path="/preparer/*" element={<Navigate to="/preparer" replace />} />
          <Route path="/" element={<Navigate to="/preparer" replace />} />
          <Route path="/pledge" element={<PledgePage />} />
          <Route path="/terms" element={<TermsPage />} />
          <Route path="/privacy" element={<PrivacyPage />} />
          <Route path="*" element={<Navigate to="/preparer" replace />} />
        </Routes>
      </main>
    </>
  );
}