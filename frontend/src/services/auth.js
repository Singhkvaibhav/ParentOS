import { apiFetch } from "./api";

export const authService = {
  // locale defaults to the browser's current i18n language so verification/
  // reset emails go out in the language the person actually reads.
  signup: (name, email, password, locale) =>
    apiFetch("/auth/signup", { method: "POST", body: { name, email, password, locale } }),
  verify: (email, code) => apiFetch("/auth/verify", { method: "POST", body: { email, code } }),
  login: (email, password) => apiFetch("/auth/login", { method: "POST", body: { email, password } }),
  logout: () => apiFetch("/auth/logout", { method: "POST" }),
  me: (signal) => apiFetch("/auth/me", { signal }),
};
