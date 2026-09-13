import { createContext, useContext, useEffect, useState, useCallback } from "react";
import i18n from "../../../i18n";
import { authService } from "../../../services/auth";
import { isAbortError } from "../../../services/api";

const AuthContext = createContext(null);

// Session state now lives entirely in an httpOnly cookie the browser
// manages automatically - there's no token for this code to see, store, or
// attach to requests (see services/api.js's credentials: "include" and
// backend/auth/cookieConfig.js). On mount, the only way to know if we're
// logged in is to ask the server via /auth/me and see whether the cookie
// (if any) was valid.
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    async function loadUser() {
      try {
        const { user } = await authService.me(controller.signal);
        setUser(user);
      } catch (e) {
        if (!isAbortError(e)) setUser(null); // no valid cookie, or it expired - just means logged out
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    loadUser();
    return () => controller.abort();
  }, []);

  const signup = useCallback(
    (name, email, password) => authService.signup(name, email, password, i18n.resolvedLanguage),
    []
  );
  const verify = useCallback(async (email, code) => {
    const { user } = await authService.verify(email, code);
    setUser(user);
  }, []);
  const login = useCallback(async (email, password) => {
    const { user } = await authService.login(email, password);
    setUser(user);
  }, []);
  const logout = useCallback(async () => {
    await authService.logout(); // clears the httpOnly cookie server-side - required now, not just a local state reset
    setUser(null);
  }, []);

  const value = { user, loading, signup, verify, login, logout };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
