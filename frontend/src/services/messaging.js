import { apiFetch } from "./api";

export const messagingService = {
  // Listing-scoped: find/start "my conversation about this listing".
  getThread: (listingId) => apiFetch(`/messages/thread?listingId=${listingId}`),
  sendBuyerMessage: (listingId, text) => apiFetch("/messages/thread", { method: "POST", body: { listingId, text } }),

  // Unified inbox - conversations the user is in, as buyer or seller.
  getConversations: () => apiFetch("/messages/conversations"),
  // Paged history for one conversation. The inbox no longer carries full
  // message arrays - it would have re-sent every message in every thread
  // on each poll.
  getMessages: (conversationId, { cursor, limit } = {}) => {
    const qs = new URLSearchParams();
    if (cursor) qs.set("cursor", cursor);
    if (limit) qs.set("limit", limit);
    const suffix = qs.toString() ? `?${qs}` : "";
    return apiFetch(`/messages/conversations/${conversationId}/messages${suffix}`);
  },
  reply: (conversationId, text) => apiFetch(`/messages/conversations/${conversationId}/reply`, { method: "POST", body: { text } }),
  markRead: (conversationId) => apiFetch(`/messages/conversations/${conversationId}/read`, { method: "POST" }),
};
