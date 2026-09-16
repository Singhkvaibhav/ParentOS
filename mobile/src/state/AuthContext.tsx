import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { auth as authApi } from '../api/endpoints';
import { registerTokenListener, setTokens, getTokens, type Tokens } from '../api/client';
import { registerForPushNotifications, unregisterPushNotifications } from '../notifications';
import type { User } from '../api/types';

const STORAGE_KEY = 'uusiki.auth.v1';

type Session = { user: User; accessToken: string; refreshToken: string };

type AuthState = {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  // Used by VerifyScreen once /auth/mobile/verify succeeds - verification
  // and login both end with the same {user, accessToken, refreshToken}
  // shape, so both just hand it to this rather than duplicating the
  // token-persist-then-setUser dance login does below.
  applySession: (session: Session) => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  // Persist whatever token pair the api client is currently holding —
  // including ones it rotated to on our behalf after a 401.
  useEffect(() => {
    registerTokenListener((tokens) => {
      if (tokens) AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(tokens));
      else AsyncStorage.removeItem(STORAGE_KEY);
    });
  }, []);

  // On launch, restore a saved session (this is the "app picks up a login
  // that started elsewhere" behavior, once the session was persisted here).
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        if (raw) {
          const tokens: Tokens = JSON.parse(raw);
          setTokens(tokens);
          const { user: me } = await authApi.me();
          setUser(me);
          // Re-registers on every launch, not just first login - the OS
          // can rotate a device's push token at any time, and this is the
          // only point in the app guaranteed to run once a session is
          // confirmed live.
          registerForPushNotifications();
        }
      } catch {
        setTokens(null);
        setUser(null);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const applySession = async ({ user: sessionUser, accessToken, refreshToken }: Session) => {
    setTokens({ accessToken, refreshToken });
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ accessToken, refreshToken }));
    setUser(sessionUser);
    registerForPushNotifications();
  };

  const login = async (email: string, password: string) => {
    await applySession(await authApi.login(email, password));
  };

  const logout = async () => {
    // Before clearing the session - unregisterPushNotifications tells the
    // backend to forget this device's token, an authenticated request that
    // needs the very tokens about to be wiped below.
    await unregisterPushNotifications().catch(() => {});

    // Revoke server-side too - a token merely forgotten on-device is still
    // a working credential if it was ever copied off it.
    const tokens = getTokens();
    if (tokens) {
      try {
        await authApi.logout(tokens.refreshToken);
      } catch {
        // Best-effort: if the backend is unreachable there's nothing more
        // useful to do than still sign the device out locally.
      }
    }
    setTokens(null);
    await AsyncStorage.removeItem(STORAGE_KEY);
    setUser(null);
  };

  const refreshUser = async () => {
    const { user: me } = await authApi.me();
    setUser(me);
  };

  const value = useMemo(() => ({ user, loading, login, applySession, logout, refreshUser }), [user, loading]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
