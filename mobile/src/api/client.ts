// Thin fetch wrapper around the REAL ParentOS/Uusiksi backend
// (Documents/parentos/backend) - the same API the web frontend talks to.
// One client, used by every screen — this IS the "website and app are both
// just clients on top of the same API" idea from the linking plan, now
// actually true rather than aspirational (this used to point at a bespoke
// SQLite backend that lived in this repo).
//
// Base URL: set EXPO_PUBLIC_API_BASE_URL in .env (see .env.example). Defaults
// to localhost on the backend's default port (see Documents/parentos/backend/
// server.js) with its versioned /api/v1 prefix (backend/config.js's
// API_PREFIX) - an installed app can't all update the moment the backend
// does, so it talks to a specific version rather than "whatever /api
// currently means". Works in the iOS simulator as-is; on a physical device
// or Android emulator you MUST set this to your machine's LAN IP (Android
// emulator: http://10.0.2.2:4000/api/v1).
const BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL || 'http://localhost:4000/api/v1';

export type Tokens = { accessToken: string; refreshToken: string };

let currentTokens: Tokens | null = null;
let onTokensRefreshed: ((tokens: Tokens | null) => void) | null = null;

/** Called once by AuthContext so this module can persist rotated tokens. */
export function registerTokenListener(fn: (tokens: Tokens | null) => void) {
  onTokensRefreshed = fn;
}

export function setTokens(tokens: Tokens | null) {
  currentTokens = tokens;
}

export function getTokens(): Tokens | null {
  return currentTokens;
}

// `code` is the backend's stable machine-readable error identifier (see
// Documents/parentos/backend's XError classes) - `message` is the
// human-readable English fallback. Screens should branch on `code` when
// they need to (e.g. distinguishing "wrong password" from "account
// locked"), the same way the web frontend's translateServerError does.
class ApiError extends Error {
  status: number;
  code?: string;
  body: any;
  constructor(status: number, body: any) {
    super(body?.error || `request_failed_${status}`);
    this.status = status;
    this.code = body?.code;
    this.body = body;
  }
}

async function rawRequest(path: string, options: RequestInit) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, body);
  return body;
}

// Shared by every caller that hits a 401 at once (e.g. several tabs
// refetching on focus right after the access token expires). Refresh tokens
// rotate on use — the backend only accepts a given refresh token once — so
// if each caller independently POSTed to /auth/refresh, only the first
// would succeed and every other one would get a 401 back and read that as
// "session is dead", logging the user out from under a perfectly valid
// session. Instead, the first 401 starts the refresh and every concurrent
// caller awaits that same in-flight promise.
let refreshPromise: Promise<Tokens | null> | null = null;

function refreshTokens(): Promise<Tokens | null> {
  if (!refreshPromise) {
    refreshPromise = (async () => {
      if (!currentTokens) return null;
      try {
        const refreshed = await rawRequest('/auth/mobile/refresh', {
          method: 'POST',
          body: JSON.stringify({ refreshToken: currentTokens.refreshToken }),
        });
        const tokens: Tokens = { accessToken: refreshed.accessToken, refreshToken: refreshed.refreshToken };
        currentTokens = tokens;
        onTokensRefreshed?.(tokens);
        return tokens;
      } catch {
        currentTokens = null;
        onTokensRefreshed?.(null);
        return null;
      } finally {
        refreshPromise = null;
      }
    })();
  }
  return refreshPromise;
}

/**
 * Authenticated request. On a 401 (expired access token), transparently
 * refreshes via /auth/mobile/refresh and retries once — the same
 * rotate-on-use refresh flow the backend's tests exercise for the web
 * cookie flow, just with tokens carried in the body instead of a cookie.
 */
async function request(path: string, options: RequestInit = {}, retry = true): Promise<any> {
  const headers: Record<string, string> = { ...(options.headers as any) };
  if (currentTokens) headers.Authorization = `Bearer ${currentTokens.accessToken}`;

  try {
    return await rawRequest(path, { ...options, headers });
  } catch (err) {
    if (err instanceof ApiError && err.status === 401 && retry && currentTokens) {
      const refreshed = await refreshTokens();
      if (refreshed) {
        return request(path, options, false);
      }
    }
    throw err;
  }
}

export const api = {
  get: (path: string) => request(path, { method: 'GET' }),
  post: (path: string, body?: unknown) => request(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  patch: (path: string, body?: unknown) => request(path, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined }),
  delete: (path: string, body?: unknown) => request(path, { method: 'DELETE', body: body ? JSON.stringify(body) : undefined }),
};

export { ApiError, rawRequest, BASE_URL };
