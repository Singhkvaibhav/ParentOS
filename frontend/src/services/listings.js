import { apiFetch } from "./api";

export const listingsService = {
  list: (params = {}, signal) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "")
    ).toString();
    return apiFetch(`/listings${qs ? `?${qs}` : ""}`, { signal });
  },
  get: (id) => apiFetch(`/listings/${id}`),
  mine: (signal) => apiFetch("/users/me/listings", { signal }),
  create: (listing) => apiFetch("/listings", { method: "POST", body: listing }),
  update: (id, patch) => apiFetch(`/listings/${id}`, { method: "PATCH", body: patch }),
  remove: (id) => apiFetch(`/listings/${id}`, { method: "DELETE" }),
  reserve: (id) => apiFetch(`/listings/${id}/reserve`, { method: "POST" }),
  markSold: (id) => apiFetch(`/listings/${id}/sold`, { method: "POST" }),
  relist: (id) => apiFetch(`/listings/${id}/relist`, { method: "POST" }),
};
