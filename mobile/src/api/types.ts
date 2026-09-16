// Mirrors the JSON shapes the REAL ParentOS/Uusiksi backend returns
// (Documents/parentos/backend) - not the bespoke SQLite backend that used
// to live in this repo. Two things changed almost everywhere as a result:
// ids are numbers (Postgres SERIAL), not cuid strings, and most objects
// carry the backend's snake_case DB columns directly rather than a
// hand-picked camelCase projection - that's just what that API sends.

export type User = {
  id: number;
  name: string;
  email: string;
  verified: boolean;
  isAdmin: boolean;
};

// From GET /api/v1/meta/config (backend/config.js) - the one place that
// decides what a valid category/condition/subcategory is, so the app
// renders from this rather than a hardcoded copy of its own.
export type MarketplaceConfig = {
  categories: string[];
  conditions: string[];
  subcategories: Record<string, string[]>;
  deliveryFeeCents: number;
  maxPriceCents: number;
  limits: { titleLength: number; descriptionLength: number; sizeOrAgeLength: number };
};

export type Listing = {
  id: number;
  seller_id: number;
  category: string;
  subcategory: string | null;
  title: string;
  price_cents: number;
  size_or_age: string;
  condition: string;
  city: string;
  area: string;
  pincode: string;
  description: string;
  photo_url: string | null;
  // ~400px variant for grid rendering - null on listings created before it
  // existed, or if generating one failed; fall back to photo_url then.
  photo_thumb_url: string | null;
  status: 'active' | 'reserved' | 'sold';
  created_at: string;
  seller_name: string;
  seller_verified: boolean;
  distanceKm?: number | null;
};

export type Transaction = {
  id: number;
  listing_id: number;
  buyer_id: number;
  seller_id: number;
  listingTitle: string;
  role: 'buyer' | 'seller';
  status: 'pending' | 'paid' | 'fulfilled' | 'completed' | 'cancelled' | 'expired' | 'refunded' | 'disputed';
  delivery_method: 'pickup' | 'delivery';
  total_amount_cents: number;
  item_amount_cents: number;
  delivery_fee_cents: number;
  commission_amount_cents: number;
  created_at: string;
};

// A conversation summary, as returned by GET /api/v1/messages/conversations -
// no per-participant-id addressing the way the old schema had it (buyer/
// seller are fixed roles per conversation, not two arbitrary participants).
export type ConversationSummary = {
  id: number;
  listingId: number;
  listingTitle: string;
  otherPartyName: string;
  role: 'buyer' | 'seller';
  unreadCount: number;
  lastMessage: string | null;
};

export type Message = {
  id: number;
  senderId: number | null; // null for an AI-authored auto-reply
  senderType: 'buyer' | 'seller' | 'ai';
  text: string;
  createdAt: string;
};

// GET /api/v1/messages/conversations/:id/messages - a page of a single
// conversation's history, newest-first cursor going backward in time.
export type MessagePage = {
  messages: Message[];
  hasMore: boolean;
  nextCursor: number | null;
};

// The full conversation object returned by reply/getThread/sendBuyerMessage/
// markRead - a superset of ConversationSummary that also carries the loaded
// message page for that conversation.
export type Conversation = {
  id: number;
  listingId: number;
  buyerId: number;
  sellerId: number;
  buyerName?: string;
  sellerName?: string;
  sellerReplied: boolean;
  created_at: string;
  messages: Message[];
  hasMoreMessages: boolean;
  messagesCursor: number | null;
  role?: 'buyer' | 'seller';
  unreadCount?: number;
};

export type ConnectStatus = {
  connected: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
};

// POST /api/v1/transactions/checkout - a Stripe PaymentIntent client secret,
// not a finished purchase. Actually paying it needs Stripe's SDK/Elements,
// which this app doesn't embed (see endpoints.ts) - so today the app only
// ever reads `transaction` off this for display, never `clientSecret`.
export type CheckoutResult = {
  transaction: Transaction;
  clientSecret: string;
  publishableKey?: string;
};

export type OnboardResult = { onboardingUrl: string };
