-- Migration 001: initial schema (PostgreSQL).
-- This is the full schema as of the point migrations were introduced -
-- there's no real prior deployed version to preserve compatibility with,
-- so the migration history is baselined here. Every future schema change
-- is a new numbered file in this directory (see backend/migrate.js), never
-- an edit to this one.
--
-- Everyone (buyer or seller) is a row in `users`; listings, conversations,
-- messages, favorites, reviews and transactions all reference users by id.
--
-- ON DELETE behaviour is set explicitly everywhere below rather than left
-- implicit. There's no "delete my account" feature yet, so none of this
-- changes current runtime behaviour - it's precautionary, and RESTRICT in
-- particular will need revisiting (probably in favour of a soft-delete or
-- anonymization approach) once real account deletion is actually built.

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  verified BOOLEAN NOT NULL DEFAULT false,
  verification_code TEXT,
  verification_expires_at TIMESTAMPTZ,
  verification_attempts INTEGER NOT NULL DEFAULT 0,
  stripe_connect_account_id TEXT,
  connect_charges_enabled BOOLEAN NOT NULL DEFAULT false,
  connect_payouts_enabled BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS listings (
  id SERIAL PRIMARY KEY,
  seller_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents > 0), -- integer cents, never a float - see transactionsService.js
  size_or_age TEXT,
  condition TEXT NOT NULL,
  city TEXT NOT NULL,
  area TEXT NOT NULL,
  pincode TEXT NOT NULL,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  description TEXT,
  photo_url TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'reserved', 'sold')),
  reserved_at TIMESTAMPTZ,  -- set when claimed for checkout; a periodic sweep releases stale reservations (see jobs/releaseExpiredReservations.js)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conversations (
  id SERIAL PRIMARY KEY,
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE RESTRICT,
  buyer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  seller_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  seller_replied BOOLEAN NOT NULL DEFAULT false,
  ai_replied BOOLEAN NOT NULL DEFAULT false, -- permanent per conversation: at most one AI-generated reply while waiting for the real seller, not just a lock against exact-instant overlap
  buyer_last_read_at TIMESTAMPTZ,
  seller_last_read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(listing_id, buyer_id)
);

-- Messages are their own table now (previously an embedded JSONB array on
-- conversations). Each INSERT is independent and row-level, so concurrent
-- writes to the same conversation no longer involve any read-modify-write
-- step at all - there's nothing to race over.
CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id INTEGER REFERENCES users(id) ON DELETE SET NULL, -- NULL for AI-authored messages
  sender_type TEXT NOT NULL CHECK (sender_type IN ('buyer', 'seller', 'ai')),
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS favorites (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, listing_id)
);

CREATE TABLE IF NOT EXISTS reviews (
  id SERIAL PRIMARY KEY,
  reviewer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reviewee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE RESTRICT,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(reviewer_id, reviewee_id, listing_id)
);

CREATE TABLE IF NOT EXISTS transactions (
  id SERIAL PRIMARY KEY,
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE RESTRICT,
  buyer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  seller_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  item_amount_cents INTEGER NOT NULL,
  delivery_method TEXT NOT NULL DEFAULT 'pickup',
  delivery_fee_cents INTEGER NOT NULL DEFAULT 0,
  commission_amount_cents INTEGER NOT NULL,
  total_amount_cents INTEGER NOT NULL, -- always item + delivery, in integer cents - no float arithmetic anywhere in this table
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'completed', 'cancelled', 'refunded', 'expired')),
  stripe_payment_intent_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_transactions_buyer ON transactions(buyer_id);
CREATE INDEX IF NOT EXISTS idx_transactions_seller ON transactions(seller_id);
CREATE INDEX IF NOT EXISTS idx_transactions_listing ON transactions(listing_id);
CREATE INDEX IF NOT EXISTS idx_listings_category ON listings(category);
CREATE INDEX IF NOT EXISTS idx_listings_latlng ON listings(lat, lng);
CREATE INDEX IF NOT EXISTS idx_listings_seller ON listings(seller_id);
CREATE INDEX IF NOT EXISTS idx_listings_reserved_at ON listings(reserved_at) WHERE status = 'reserved';
CREATE INDEX IF NOT EXISTS idx_conversations_seller ON conversations(seller_id);
CREATE INDEX IF NOT EXISTS idx_conversations_buyer ON conversations(buyer_id);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_favorites_user ON favorites(user_id);
CREATE INDEX IF NOT EXISTS idx_reviews_reviewee ON reviews(reviewee_id);
