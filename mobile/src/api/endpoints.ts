import { api } from './client';
import type {
  CheckoutResult,
  Conversation,
  ConversationSummary,
  ConnectStatus,
  Listing,
  MarketplaceConfig,
  MessagePage,
  OnboardResult,
  Transaction,
  User,
} from './types';

// --- auth ------------------------------------------------------------
//
// These hit the /api/v1/auth/mobile/* routes - same signup/login/verify/reset
// logic as the web app (services/authService.js), just returning tokens in
// the JSON body instead of setting httpOnly cookies (see client.ts and
// backend/middleware/requireAuth.js for why).
type CodeIssued = { message: string; warning: 'email-send-failed' | null; devCode: string | null };
export const auth = {
  signup: (name: string, email: string, password: string) =>
    api.post('/auth/mobile/signup', { name, email, password }) as Promise<CodeIssued>,
  resendCode: (email: string) =>
    api.post('/auth/mobile/resend-code', { email }) as Promise<CodeIssued>,
  verify: (email: string, code: string) =>
    api.post('/auth/mobile/verify', { email, code }) as Promise<{ user: User; accessToken: string; refreshToken: string }>,
  login: (email: string, password: string) =>
    api.post('/auth/mobile/login', { email, password }) as Promise<{ user: User; accessToken: string; refreshToken: string }>,
  me: () => api.get('/auth/me') as Promise<{ user: User }>,
  logout: (refreshToken: string) => api.post('/auth/mobile/logout', { refreshToken }) as Promise<{ ok: boolean }>,
  forgotPassword: (email: string) => api.post('/auth/mobile/forgot-password', { email }) as Promise<{ ok: boolean }>,
  resetPassword: (token: string, password: string) =>
    api.post('/auth/mobile/reset-password', { token, password }) as Promise<{ ok: boolean }>,
};

// --- marketplace config ------------------------------------------------
//
// GET /api/v1/meta/config - the single source of truth for category/condition/
// subcategory ids and marketplace limits, same one the web frontend renders
// its filters and Sell form from. See backend/config.js.
export const meta = {
  config: () => api.get('/meta/config') as Promise<MarketplaceConfig>,
};

// --- listings ------------------------------------------------------------
export const listings = {
  feed: (params: { category?: string; subcategory?: string; condition?: string; q?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.category && params.category !== 'all') qs.set('category', params.category);
    if (params.subcategory && params.subcategory !== 'all') qs.set('subcategory', params.subcategory);
    if (params.condition && params.condition !== 'all') qs.set('condition', params.condition);
    if (params.q) qs.set('q', params.q);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return api.get(`/listings${suffix}`) as Promise<{ listings: Listing[] }>;
  },
  get: (id: number) => api.get(`/listings/${id}`) as Promise<{ listing: Listing }>,
  mine: () => api.get('/users/me/listings') as Promise<{ listings: Listing[] }>,
  create: (data: {
    category: string;
    subcategory?: string | null;
    title: string;
    priceCents: number;
    sizeOrAge: string;
    condition: string;
    city: string;
    area: string;
    description: string;
    photoUrl?: string | null;
  }) => api.post('/listings', data) as Promise<{ listing: Listing }>,
  remove: (id: number) => api.delete(`/listings/${id}`) as Promise<{ ok: boolean }>,
  reserve: (id: number) => api.post(`/listings/${id}/reserve`) as Promise<{ listing: Listing }>,
  markSold: (id: number) => api.post(`/listings/${id}/sold`) as Promise<{ listing: Listing }>,
  relist: (id: number) => api.post(`/listings/${id}/relist`) as Promise<{ listing: Listing }>,
};

// --- transactions (orders) ------------------------------------------------
//
// checkout() only ever gets used for its `transaction` field here - actually
// paying the returned clientSecret needs Stripe's SDK/Elements, which this
// app doesn't embed (no native dev client, would break Expo Go). "Buy now"
// in the UI is an honest "finish this purchase on the web" prompt rather
// than silently creating an order nobody can pay for from the app.
export const transactions = {
  mine: () => api.get('/transactions/mine') as Promise<{ transactions: Transaction[] }>,
  checkout: (listingId: number, deliveryMethod: 'pickup' | 'delivery' = 'pickup') =>
    api.post('/transactions/checkout', { listingId, deliveryMethod }) as Promise<CheckoutResult>,
  confirmReceipt: (id: number) => api.post(`/transactions/${id}/confirm-receipt`) as Promise<{ transaction: Transaction }>,
  markFulfilled: (id: number) => api.post(`/transactions/${id}/fulfil`) as Promise<{ transaction: Transaction }>,
  raiseDispute: (id: number, reason: string) =>
    api.post(`/transactions/${id}/dispute`, { reason }) as Promise<{ transaction: Transaction }>,
};

// --- messages --------------------------------------------------------
export const messages = {
  conversations: () => api.get('/messages/conversations') as Promise<{ conversations: ConversationSummary[]; totalUnread: number }>,
  listMessages: (conversationId: number, cursor?: number) => {
    const suffix = cursor ? `?cursor=${cursor}` : '';
    return api.get(`/messages/conversations/${conversationId}/messages${suffix}`) as Promise<MessagePage>;
  },
  reply: (conversationId: number, text: string) =>
    api.post(`/messages/conversations/${conversationId}/reply`, { text }) as Promise<{ conversation: Conversation }>,
  markRead: (conversationId: number) =>
    api.post(`/messages/conversations/${conversationId}/read`) as Promise<{ conversation: Conversation }>,
  // Listing-scoped: "my conversation about this listing" from a listing's
  // detail screen - starts one on first send if none exists yet.
  getThread: (listingId: number) =>
    api.get(`/messages/thread?listingId=${listingId}`) as Promise<{ conversation: Conversation | null }>,
  sendBuyerMessage: (listingId: number, text: string) =>
    api.post('/messages/thread', { listingId, text }) as Promise<{ conversation: Conversation }>,
};

// --- account / Connect payouts --------------------------------------
//
// No fabricated linked-apps/shared-facts endpoints here - those never
// existed on the real backend. connectStripe opens the real hosted Stripe
// onboarding flow in a browser (see AccountScreen) rather than pretending
// to run it in-app.
export const account = {
  connectStatus: () => api.get('/connect/status') as Promise<ConnectStatus>,
  connectOnboard: () => api.post('/connect/onboard') as Promise<OnboardResult>,
};

// See src/notifications.ts - registered once permission is granted and an
// Expo push token exists, unregistered on logout so a signed-out device
// stops receiving another account's notifications.
export const notifications = {
  registerPushToken: (token: string, platform: 'ios' | 'android') =>
    api.post('/notifications/push-token', { token, platform }) as Promise<{ ok: boolean }>,
  unregisterPushToken: (token: string) =>
    api.delete('/notifications/push-token', { token }) as Promise<{ ok: boolean }>,
};
