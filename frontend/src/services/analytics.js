import { apiFetch } from "./api";

export const analyticsService = {
  me: () => apiFetch("/analytics/me"),
  listing: (id) => apiFetch(`/analytics/listings/${id}`),
};
