import { apiFetch } from "./api";

export const reviewsService = {
  listForUser: (userId) => apiFetch(`/reviews/user/${userId}`),
  create: (revieweeId, listingId, rating, comment) =>
    apiFetch("/reviews", { method: "POST", body: { revieweeId, listingId, rating, comment } }),
};
