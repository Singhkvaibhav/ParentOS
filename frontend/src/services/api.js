// Defaults to a relative path so requests go through Vite's dev proxy
// (see vite.config.js) and stay same-origin from the browser's point of
// view - important now that auth is an httpOnly cookie rather than a
// token this code could attach itself. In production, serve the frontend
// and backend from the same origin (or behind one reverse proxy) for the
// same reason, or the cookie's SameSite setting needs to change (see
// backend/auth/cookieConfig.js).
const API_URL = import.meta.env.VITE_API_URL || "/api";

const CSRF_COOKIE_NAME = "parentos_csrf";
const CSRF_HEADER_NAME = "x-csrf-token";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// The CSRF cookie is deliberately NOT httpOnly (unlike the auth cookie) -
// being readable by this code is the entire mechanism. A malicious
// third-party page can make the browser *send* our cookies, but
// same-origin policy stops it from *reading* them, so it can't produce
// this header. See backend/middleware/csrf.js.
function readCsrfToken() {
  const match = document.cookie.match(new RegExp(`(?:^|; )${CSRF_COOKIE_NAME}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

// On a completely fresh load there may be no CSRF cookie yet (the backend
// issues one on any request). Rather than letting the user's first action
// fail with a confusing 403, make a cheap GET to obtain one first. Only
// happens once - subsequent calls find the cookie already set.
async function ensureCsrfToken() {
  const existing = readCsrfToken();
  if (existing) return existing;
  await fetch(`${API_URL}/health`, { credentials: "include" }).catch(() => {});
  return readCsrfToken();
}

// Access tokens last 15 minutes, so a 401 usually means "expired", not
// "logged out". Without transparent refresh a short access token would
// simply mean a short session, which would be worse than the 30-day token
// it replaced.
//
// The in-flight promise is shared: several requests failing at once must
// trigger ONE refresh, not one each. Concurrent refreshes would race to
// rotate the same token and the loser would be treated as a replay,
// revoking the family and logging the user out - the security mechanism
// firing on its own client.
let refreshInFlight = null;

async function refreshSession() {
  if (!refreshInFlight) {
    refreshInFlight = fetch(`${API_URL}/auth/refresh`, {
      method: "POST",
      headers: { [CSRF_HEADER_NAME]: readCsrfToken() || "" },
      credentials: "include",
    })
      .then((res) => res.ok)
      .catch(() => false)
      .finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
}

export async function apiFetch(path, { method = "GET", body, signal, _retried } = {}) {
  const headers = { "Content-Type": "application/json" };

  if (!SAFE_METHODS.has(method)) {
    const csrfToken = await ensureCsrfToken();
    if (csrfToken) headers[CSRF_HEADER_NAME] = csrfToken;
  }

  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    credentials: "include", // send/receive the httpOnly auth cookie
    signal,
  });
  // One retry only. If the refreshed token also gets a 401, the session is
  // genuinely over and retrying again would loop.
  if (res.status === 401 && !_retried && !path.startsWith("/auth/refresh")) {
    if (await refreshSession()) {
      return apiFetch(path, { method, body, signal, _retried: true });
    }
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || "Request failed.");
    // `code` (and anything else the backend attached - attemptsRemaining,
    // locked, needsVerification) rides along on the thrown Error so
    // callers can act on it without re-parsing the message string. See
    // i18n/errorMessages.js, which translates by `code` rather than by
    // matching the English message text.
    Object.assign(err, data);
    throw err;
  }
  return data;
}

// A request aborted on purpose (e.g. the component unmounted before it
// resolved) throws a DOMException named "AbortError" - callers should check
// this before treating it as a real failure (showing an error toast,
// setting error state, etc.).
export function isAbortError(e) {
  return e && (e.name === "AbortError" || e.code === 20);
}
