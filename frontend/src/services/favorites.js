import { apiFetch } from "./api";

export const favoritesService = {
  list: (signal) => apiFetch("/favorites", { signal }),
  add: (listingId) => apiFetch("/favorites", { method: "POST", body: { listingId } }),
  remove: (listingId) => apiFetch(`/favorites/${listingId}`, { method: "DELETE" }),
};
