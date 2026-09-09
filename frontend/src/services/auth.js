import { apiFetch } from "./api";

export const authService = {
  signup: (name, email, password) => apiFetch("/auth/signup", { method: "POST", body: { name, email, password } }),
  verify: (email, code) => apiFetch("/auth/verify", { method: "POST", body: { email, code } }),
  login: (email, password) => apiFetch("/auth/login", { method: "POST", body: { email, password } }),
  logout: () => apiFetch("/auth/logout", { method: "POST" }),
  me: (signal) => apiFetch("/auth/me", { signal }),
};
