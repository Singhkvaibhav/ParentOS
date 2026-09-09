import { apiFetch } from "./api";

export const notificationsService = {
  list: () => apiFetch("/notifications"),
  markRead: (id) => apiFetch(`/notifications/${id}/read`, { method: "POST" }),
  markAllRead: () => apiFetch("/notifications/read-all", { method: "POST" }),
  setEmailPreference: (enabled) => apiFetch("/notifications/email-preference", { method: "POST", body: { enabled } }),
};
