'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api, setAccessToken as setApiAccessToken, refreshAccessToken, setOnTokenRefreshed } from '../lib/api';
import type { CurrentUser } from '../lib/types';

interface SessionContextValue {
  user: CurrentUser | null;
  /** Exposed so consumers that need to authenticate their own connection
   * (Socket.io — presence, chat) can do so, including right after a
   * silent session restore, not just right after an explicit login. */
  accessToken: string | null;
  isLoading: boolean;
  login: (user: CurrentUser, accessToken: string) => void;
  logout: () => Promise<void>;
  /** Merges a partial profile change (avatarUrl/accentColor from the settings page) into the current user, without a round-trip back to /me. */
  updateUser: (patch: Partial<CurrentUser>) => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // Exchanges the httpOnly refresh cookie (if any) for a fresh access
    // token and restores `user`. Runs once per full page load — this is
    // what lets a hard refresh, or opening /admin or /shared directly in a
    // new tab, land the person in an already-logged-in state instead of
    // bouncing them back to the login form every time. Also restores
    // `accessToken` itself (see the field's doc comment above) — without
    // this, anything relying on it (Socket.io presence/chat) silently
    // never connected after a plain page refresh, only right after an
    // explicit login.
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' });
        if (!res.ok) return;
        const { accessToken: token } = (await res.json()) as { accessToken: string };
        setApiAccessToken(token);
        const me = await api.me();
        if (!cancelled) {
          setUser(me);
          setAccessToken(token);
        }
      } catch {
        // No valid session (no cookie, expired, etc.) — stay logged out.
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Keeps this component's own `accessToken` state in sync no matter
  // which mechanism actually refreshed it underneath — the proactive
  // timer just below, or request()'s own reactive retry-on-401 in
  // api.ts (a safety net for when this timer gets throttled, e.g. a
  // backgrounded tab, or a request happens to be in flight right as the
  // token expires).
  useEffect(() => {
    setOnTokenRefreshed((token) => setAccessToken(token));
    return () => setOnTokenRefreshed(null);
  }, []);

  // Proactively refreshes well before the access token's own 15-minute
  // lifetime runs out, so a session sitting open and in use doesn't hit
  // a stretch of failed requests waiting on the reactive retry to catch
  // up — that path still works (see above), this just means it
  // shouldn't normally be needed at all. Only runs once actually logged
  // in; nothing to keep refreshing before that.
  useEffect(() => {
    if (!user) return;
    const interval = setInterval(
      () => {
        void refreshAccessToken();
      },
      12 * 60 * 1000,
    );
    return () => clearInterval(interval);
  }, [user]);

  const login = useCallback((u: CurrentUser, token: string) => {
    setApiAccessToken(token);
    setUser(u);
    setAccessToken(token);
  }, []);

  const logout = useCallback(async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }).catch(() => undefined);
    setApiAccessToken(null);
    setUser(null);
    setAccessToken(null);
  }, []);

  const updateUser = useCallback((patch: Partial<CurrentUser>) => {
    setUser((prev) => (prev ? { ...prev, ...patch } : prev));
  }, []);

  return <SessionContext.Provider value={{ user, accessToken, isLoading, login, logout, updateUser }}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used within SessionProvider');
  return ctx;
}
