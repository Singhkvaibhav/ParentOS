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

export async function apiFetch(path, { method = "GET", body, signal } = {}) {
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
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed.");
  return data;
}

// A request aborted on purpose (e.g. the component unmounted before it
// resolved) throws a DOMException named "AbortError" - callers should check
// this before treating it as a real failure (showing an error toast,
// setting error state, etc.).
export function isAbortError(e) {
  return e && (e.name === "AbortError" || e.code === 20);
}
