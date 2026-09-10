import { apiFetch } from "./api";

export const transactionsService = {
  checkout: (listingId, deliveryMethod) => apiFetch("/transactions/checkout", { method: "POST", body: { listingId, deliveryMethod } }),
  mine: () => apiFetch("/transactions/mine"),
  // Asks the BACKEND whether the order settled. Stripe telling the browser
  // the card was accepted and this server recording the order as paid are
  // two different facts, separated by webhook delivery.
  status: (id) => apiFetch(`/transactions/${id}/status`),
  // The buyer confirms the handover actually happened.
  confirmReceipt: (id) => apiFetch(`/transactions/${id}/confirm-receipt`, { method: "POST" }),
  // The seller says they've handed the item over / posted it. These two
  // backend endpoints existed since the lifecycle round but had no client
  // methods, so the 'fulfilled' state was unreachable from the UI - the
  // same "built but not wired up" gap the journey audit found earlier.
  markFulfilled: (id) => apiFetch(`/transactions/${id}/fulfil`, { method: "POST" }),
  // Either party can flag a problem; a seller can be wronged too.
  raiseDispute: (id, reason) => apiFetch(`/transactions/${id}/dispute`, { method: "POST", body: { reason } }),
};
