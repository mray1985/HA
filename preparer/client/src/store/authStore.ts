import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { getActiveKey, encrypt as encryptStr, decrypt as decryptStr } from '../services/crypto';

function apiUrl(path: string): string {
  const base = (import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, '');
  return `${base}${path}`;
}

/** The accounts HA Tax Preparer signs in: preparers, and admins who manage their accounts. */
function isPreparerAccount(role: string): boolean {
  return role === 'preparer' || role === 'admin';
}

const NOT_A_PREPARER = 'This account is not a preparer account.';

export interface User {
  id: number;
  email: string;
  name: string;
  role: string;
  subscriptionStatus?: string;
  subscriptionUntil?: string | null;
}

export function preparerSeatActive(user: User | null): boolean {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.role !== 'preparer') return false;
  if (user.subscriptionStatus !== 'active' || !user.subscriptionUntil) return false;
  return new Date(user.subscriptionUntil).getTime() > Date.now();
}

interface AuthState {
  user: User | null;
  accessToken: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;

  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name: string) => Promise<void>;
  logout: () => Promise<void>;
  activateSeason: () => Promise<void>;
  fetchMe: () => Promise<void>;
  setUser: (user: User | null) => void;
  setAccessToken: (token: string | null) => void;
  clearError: () => void;
  /** Restore the encrypted auth blob after the vault is unlocked. */
  loadDecrypted: () => Promise<void>;
}

interface PersistedAuth {
  user: User | null;
  accessToken: string | null;
  isAuthenticated: boolean;
}

const AUTH_ENC_KEY = 'hatax-auth-enc';

async function encryptAuthState(state: PersistedAuth): Promise<string | null> {
  const key = getActiveKey();
  if (!key) return null;
  try {
    const payload = JSON.stringify({
      user: state.user,
      accessToken: state.accessToken,
      isAuthenticated: state.isAuthenticated,
    });
    return await encryptStr(payload, key);
  } catch {
    return null;
  }
}

async function decryptAuthState(enc: string): Promise<PersistedAuth | null> {
  const key = getActiveKey();
  if (!key) return null;
  try {
    const payload = JSON.parse(await decryptStr(enc, key));
    return {
      user: payload.user || null,
      accessToken: payload.accessToken || null,
      isAuthenticated: Boolean(payload.isAuthenticated),
    };
  } catch {
    return null;
  }
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      accessToken: null,
      isAuthenticated: false,
      isLoading: false,
      error: null,

      login: async (email: string, password: string) => {
        set({ isLoading: true, error: null });
        try {
          const res = await fetch(apiUrl('/api/auth/login'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ email, password }),
          });

          const data = await res.json();
          if (!res.ok) {
            throw new Error(data.error?.message || 'Login failed');
          }

          if (!isPreparerAccount(data.data.user.role)) {
            await fetch(apiUrl('/api/auth/logout'), { method: 'POST', credentials: 'include' });
            set({ user: null, accessToken: null, isAuthenticated: false, error: NOT_A_PREPARER, isLoading: false });
            throw new Error(NOT_A_PREPARER);
          }

          const newState = {
            user: data.data.user,
            accessToken: data.data.accessToken,
            isAuthenticated: true,
            isLoading: false,
          };

          // Encrypt and store if vault is unlocked
          const enc = await encryptAuthState(newState);
          if (enc) {
            localStorage.setItem(AUTH_ENC_KEY, enc);
          }

          set(newState);
        } catch (err: any) {
          set({ error: err.message, isLoading: false, user: null, accessToken: null, isAuthenticated: false });
          throw err;
        }
      },

      register: async (email: string, password: string, name: string) => {
        set({ isLoading: true, error: null });
        try {
          const res = await fetch(apiUrl('/api/auth/register'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ email, password, name }),
          });

          const data = await res.json();
          if (!res.ok) {
            throw new Error(data.error?.message || 'Registration failed');
          }

          const newState = {
            user: data.data.user,
            accessToken: data.data.accessToken,
            isAuthenticated: true,
            isLoading: false,
          };

          // Encrypt and store if vault is unlocked
          const enc = await encryptAuthState(newState);
          if (enc) {
            localStorage.setItem(AUTH_ENC_KEY, enc);
          }

          set(newState);
        } catch (err: any) {
          set({ error: err.message, isLoading: false });
          throw err;
        }
      },

      activateSeason: async () => {
        const token = get().accessToken;
        set({ isLoading: true, error: null });
        try {
          const res = await fetch(apiUrl('/api/auth/subscription/activate'), {
            method: 'POST',
            headers: token ? { Authorization: `Bearer ${token}` } : {},
            credentials: 'include',
          });
          const data = await res.json();
          if (!res.ok) {
            throw new Error(data.error?.message || 'Could not start the season');
          }
          const next = {
            user: data.data.user,
            accessToken: get().accessToken,
            isAuthenticated: true,
          };
          const enc = await encryptAuthState(next);
          if (enc) localStorage.setItem(AUTH_ENC_KEY, enc);
          set({ ...next, isLoading: false });
        } catch (err: any) {
          set({ error: err.message, isLoading: false });
          throw err;
        }
      },

      logout: async () => {
        try {
          await fetch(apiUrl('/api/auth/logout'), {
            method: 'POST',
            credentials: 'include',
          });
        } catch {
          // Ignore logout errors
        }
        set({ user: null, accessToken: null, isAuthenticated: false });
        // Clear encrypted storage on logout
        localStorage.removeItem(AUTH_ENC_KEY);
      },

      fetchMe: async () => {
        const token = get().accessToken;
        if (!token) {
          set({ isAuthenticated: false, user: null });
          return;
        }

        set({ isLoading: true });
        try {
          const res = await fetch(apiUrl('/api/auth/me'), {
            headers: {
              Authorization: `Bearer ${token}`,
            },
            credentials: 'include',
          });

          if (!res.ok) {
            set({ user: null, accessToken: null, isAuthenticated: false, isLoading: false });
            return;
          }

          const data = await res.json();
          const persisted: PersistedAuth = {
            user: data.data.user,
            accessToken: get().accessToken,
            isAuthenticated: true,
          };

          // Encrypt and store if vault is unlocked
          const enc = await encryptAuthState(persisted);
          if (enc) {
            localStorage.setItem(AUTH_ENC_KEY, enc);
          }

          set({ ...persisted, isLoading: false });
        } catch {
          set({ user: null, accessToken: null, isAuthenticated: false, isLoading: false });
        }
      },

      setUser: (user: User | null) => set({ user, isAuthenticated: !!user }),

      setAccessToken: (token: string | null) => set({ accessToken: token, isAuthenticated: !!token }),

      clearError: () => set({ error: null }),

      loadDecrypted: async () => {
        const enc = localStorage.getItem(AUTH_ENC_KEY);
        if (!enc) return;
        const decrypted = await decryptAuthState(enc);
        if (!decrypted) return;
        set({
          user: decrypted.user,
          accessToken: decrypted.accessToken,
          isAuthenticated: decrypted.isAuthenticated,
        });
      },
    }),
    {
      name: 'hatax-auth',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        user: state.user,
        accessToken: state.accessToken,
        isAuthenticated: state.isAuthenticated,
      }),
    }
  )
);

export function useAuthHydrated(): boolean {
  const [hydrated, setHydrated] = useState(() => useAuthStore.persist.hasHydrated());
  useEffect(() => {
    if (useAuthStore.persist.hasHydrated()) setHydrated(true);
    return useAuthStore.persist.onFinishHydration(() => setHydrated(true));
  }, []);
  return hydrated;
}