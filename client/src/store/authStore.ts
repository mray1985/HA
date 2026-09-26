import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export interface User {
  id: number;
  email: string;
  name: string;
  role: string;
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
  fetchMe: () => Promise<void>;
  setUser: (user: User | null) => void;
  setAccessToken: (token: string | null) => void;
  clearError: () => void;
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
          const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ email, password }),
          });

          const data = await res.json();
          if (!res.ok) {
            throw new Error(data.error?.message || 'Login failed');
          }

          set({
            user: data.data.user,
            accessToken: data.data.accessToken,
            isAuthenticated: true,
            isLoading: false,
          });
        } catch (err: any) {
          set({ error: err.message, isLoading: false });
          throw err;
        }
      },

      register: async (email: string, password: string, name: string) => {
        set({ isLoading: true, error: null });
        try {
          const res = await fetch('/api/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ email, password, name }),
          });

          const data = await res.json();
          if (!res.ok) {
            throw new Error(data.error?.message || 'Registration failed');
          }

          set({
            user: data.data.user,
            accessToken: data.data.accessToken,
            isAuthenticated: true,
            isLoading: false,
          });
        } catch (err: any) {
          set({ error: err.message, isLoading: false });
          throw err;
        }
      },

      logout: async () => {
        try {
          await fetch('/api/auth/logout', {
            method: 'POST',
            credentials: 'include',
          });
        } catch {
          // Ignore logout errors
        }
        set({ user: null, accessToken: null, isAuthenticated: false });
      },

      fetchMe: async () => {
        const token = get().accessToken;
        if (!token) {
          set({ isAuthenticated: false, user: null });
          return;
        }

        set({ isLoading: true });
        try {
          const res = await fetch('/api/auth/me', {
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
          set({
            user: data.data.user,
            isAuthenticated: true,
            isLoading: false,
          });
        } catch {
          set({ user: null, accessToken: null, isAuthenticated: false, isLoading: false });
        }
      },

      setUser: (user: User | null) => set({ user, isAuthenticated: !!user }),
      setAccessToken: (token: string | null) => set({ accessToken: token, isAuthenticated: !!token }),
      clearError: () => set({ error: null }),
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