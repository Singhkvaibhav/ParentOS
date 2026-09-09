import { apiFetch } from "./api";

export const moderationService = {
  // Moderator-only. The backend enforces the admin check in the service
  // layer, so a non-admin calling these just gets a 403.
  listReports: (status = "open") => apiFetch(`/moderation/reports?status=${status}`),
  resolveReport: (id, status, note) =>
    apiFetch(`/moderation/reports/${id}/resolve`, { method: "POST", body: { status, note } }),
  takeDownListing: (id, reason) =>
    apiFetch(`/moderation/listings/${id}/takedown`, { method: "POST", body: { reason } }),
  restoreListing: (id) => apiFetch(`/moderation/listings/${id}/restore`, { method: "POST" }),

  report: (payload) => apiFetch("/moderation/reports", { method: "POST", body: payload }),
  block: (userId) => apiFetch("/moderation/blocks", { method: "POST", body: { userId } }),
  unblock: (userId) => apiFetch(`/moderation/blocks/${userId}`, { method: "DELETE" }),
  listBlocks: () => apiFetch("/moderation/blocks"),
};
