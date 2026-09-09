// Single source of truth for marketplace configuration.
//
// These values were previously scattered across services - the delivery
// fee and commission in transactionsService, the category/condition
// vocabularies and field limits in listingsService, and the category and
// condition lists duplicated *again* in frontend/src/constants.js. That
// duplication is the real risk: adding a category in one place and not
// the other silently creates listings no filter can match (exactly the
// class of bug the field-validation round found).
//
// Env-overridable values read process.env here and only here, so there's
// one place to look for "what can be tuned per environment".

const MARKETPLACE = {
  // Money is integer cents everywhere past the API boundary - see the
  // "Eighth round" section of the README.
  deliveryFeeCents: Number(process.env.DELIVERY_FEE_CENTS || 500),
  commissionPercent: Number(process.env.COMMISSION_PERCENT || 8),

  // How long a checkout may hold a listing before the sweep releases it.
  reservationTtlMinutes: Number(process.env.RESERVATION_TTL_MINUTES || 30),

  // price_cents is an INTEGER column; anything near 2^31 overflows. This
  // cap (100,000 EUR) is far above any plausible secondhand children's
  // item while staying comfortably inside the column's range.
  maxPriceCents: Number(process.env.MAX_PRICE_CENTS || 10_000_000),
};

// The listing vocabularies. Kept in sync with frontend/src/constants.js -
// see the note there; the frontend can't import this file directly
// (separate build, separate package), so the API validates against these
// and the frontend renders from its own copy.
const CATEGORIES = ["clothes", "accessories", "toys"];
const CONDITIONS = ["New with tags", "Like new", "Good", "Well loved"];

// CORS origins, resolved in ONE place.
//
// This was previously split: server.js read ALLOWED_ORIGINS while
// configCheck.js validated CORS_ORIGINS. In production that combination is
// silently dangerous - you set CORS_ORIGINS, validation passes, and the
// server ignores it and falls back to the localhost default, so the real
// frontend is CORS-blocked while the config check reports everything fine.
//
// CORS_ORIGINS is canonical (it's what the deployment docs and production
// validation use). ALLOWED_ORIGINS is still accepted so existing local
// .env files keep working, but it's the fallback, not the other way round.
const LOCAL_DEV_ORIGIN = "http://localhost:5173";

function resolveCorsOrigins() {
  const raw = process.env.CORS_ORIGINS || process.env.ALLOWED_ORIGINS || "";
  const origins = raw.split(",").map((o) => o.trim()).filter(Boolean);

  return {
    origins: origins.length > 0 ? origins : [LOCAL_DEV_ORIGIN],
    // Whether we fell back to the dev default. Production must refuse to
    // start in that state rather than serve a frontend it will then block.
    usingDefault: origins.length === 0,
    // Which variable supplied the value, so a deprecation warning can name
    // the right one.
    source: process.env.CORS_ORIGINS ? "CORS_ORIGINS"
          : process.env.ALLOWED_ORIGINS ? "ALLOWED_ORIGINS"
          : "default",
  };
}

const LIMITS = {
  // (P1 #3) Messages were unbounded - a single 300KB message would be
  // stored, re-sent in every thread fetch, and fed to the AI as prompt
  // input. Generous for real conversation, far below anything abusive.
  messageLength: 2000,
  titleLength: 140,
  descriptionLength: 4000,
  sizeOrAgeLength: 80,
  // Pagination
  defaultPageSize: 20,
  maxPageSize: 100,
};

module.exports = {
  resolveCorsOrigins,
  LOCAL_DEV_ORIGIN,
  MARKETPLACE,
  CATEGORIES,
  CONDITIONS,
  LIMITS,
  // Sets are what the validators actually want; build them once here
  // rather than in each caller.
  CATEGORY_SET: new Set(CATEGORIES),
  CONDITION_SET: new Set(CONDITIONS),
};
