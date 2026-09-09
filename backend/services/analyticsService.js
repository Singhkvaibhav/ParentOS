const { query } = require("../db");
const { parseId } = require("../utils/validation");
const { STATUS, MONEY_CAPTURED, AWAITING_HANDOVER, CONCLUDED, REVERSED, sqlList } = require("../transactionStatus");

class AnalyticsError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Records that a listing was viewed. Fire-and-forget from the caller: a
// browsing request must never fail or slow down because analytics didn't
// write. Self-views are excluded - a seller refreshing their own listing
// would otherwise inflate the number the same seller is trying to read.
async function recordListingView(listingId, viewerId, sellerId) {
  if (viewerId && sellerId && viewerId === sellerId) return;

  await query("INSERT INTO listing_views (listing_id, viewer_id) VALUES ($1, $2)", [listingId, viewerId || null]);
  await query("UPDATE listings SET view_count = view_count + 1 WHERE id = $1", [listingId]);
}

// --- Seller-facing -------------------------------------------------------

// What a seller actually needs to know: is anyone finding this, and do
// they act when they do? Views alone don't distinguish "nobody sees it"
// from "people see it and pass", which need opposite fixes (price/photos
// vs reach).
async function sellerStats(sellerId) {
  const { rows } = await query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'active' AND moderated_at IS NULL) AS active_listings,
       COUNT(*) FILTER (WHERE status = 'sold') AS sold_listings,
       COALESCE(SUM(view_count), 0) AS total_views
     FROM listings WHERE seller_id = $1`,
    [sellerId]
  );

  const { rows: convoRows } = await query(
    `SELECT COUNT(DISTINCT c.id) AS conversations
     FROM conversations c
     JOIN listings l ON l.id = c.listing_id
     WHERE l.seller_id = $1`,
    [sellerId]
  );

  // 'completed' and "money captured" are deliberately reported separately.
  // A paid-but-not-yet-handed-over order is real revenue the seller can
  // see, but it is NOT a concluded sale - conflating them is what made the
  // trust counters wrong, and the same mistake here would tell a seller
  // they'd completed sales they hadn't.
  const { rows: earnRows } = await query(
    `SELECT
       COUNT(*) FILTER (WHERE status IN (${sqlList(CONCLUDED)})) AS completed_sales,
       COUNT(*) FILTER (WHERE status IN (${sqlList(AWAITING_HANDOVER)})) AS awaiting_handover,
       COALESCE(SUM(item_amount_cents - commission_amount_cents)
                FILTER (WHERE status IN (${sqlList(MONEY_CAPTURED)})), 0) AS net_earned_cents
     FROM transactions
     WHERE seller_id = $1`,
    [sellerId]
  );

  const totalViews = Number(rows[0].total_views);
  const completedSales = Number(earnRows[0].completed_sales);

  return {
    activeListings: Number(rows[0].active_listings),
    soldListings: Number(rows[0].sold_listings),
    totalViews,
    conversations: Number(convoRows[0].conversations),
    completedSales,
    awaitingHandover: Number(earnRows[0].awaiting_handover),
    netEarnedCents: Number(earnRows[0].net_earned_cents),
    // Null rather than 0 when there's nothing to divide by - "0%
    // conversion" reads as failure when the truth is "no data yet".
    viewToSaleRate: totalViews > 0 ? Math.round((completedSales / totalViews) * 1000) / 10 : null,
  };
}

async function listingStats(listingId, requesterId) {
  const id = parseId(listingId, "listingId", AnalyticsError);
  const { rows } = await query("SELECT seller_id, view_count FROM listings WHERE id = $1", [id]);
  const listing = rows[0];
  if (!listing) throw new AnalyticsError(404, "Listing not found.");
  // Per-listing performance is the seller's business, not public - it
  // would otherwise let anyone measure a competitor's demand.
  if (listing.seller_id !== requesterId) throw new AnalyticsError(403, "Not your listing.");

  const { rows: recent } = await query(
    `SELECT COUNT(*) AS views_last_7_days
     FROM listing_views WHERE listing_id = $1 AND viewed_at > now() - interval '7 days'`,
    [id]
  );
  const { rows: convo } = await query(
    "SELECT COUNT(*) AS conversations FROM conversations WHERE listing_id = $1",
    [id]
  );

  return {
    totalViews: Number(listing.view_count),
    viewsLast7Days: Number(recent[0].views_last_7_days),
    conversations: Number(convo[0].conversations),
  };
}

// --- Platform-facing (admin) --------------------------------------------

async function requireAdmin(userId) {
  const { rows } = await query("SELECT is_admin FROM users WHERE id = $1", [userId]);
  if (!rows[0]?.is_admin) throw new AnalyticsError(403, "Moderator access required.");
}

// Marketplace health. The metrics are chosen to answer "is this working?"
// rather than to look impressive - liquidity (do listings sell?), the
// supply/demand balance, and whether trust mechanisms are being used.
async function platformStats(adminId) {
  await requireAdmin(adminId);

  const [users, listings, transactions, engagement, moderation] = await Promise.all([
    query(`SELECT
             COUNT(*) AS total,
             COUNT(*) FILTER (WHERE verified) AS verified,
             COUNT(*) FILTER (WHERE created_at > now() - interval '30 days') AS new_last_30_days,
             COUNT(*) FILTER (WHERE connect_charges_enabled) AS payout_ready
           FROM users`),
    query(`SELECT
             COUNT(*) AS total,
             COUNT(*) FILTER (WHERE status = 'active' AND moderated_at IS NULL) AS active,
             COUNT(*) FILTER (WHERE status = 'sold') AS sold,
             COUNT(*) FILTER (WHERE moderated_at IS NOT NULL) AS taken_down,
             COALESCE(SUM(view_count), 0) AS total_views
           FROM listings`),
    query(`SELECT
             COUNT(*) FILTER (WHERE status IN (${sqlList(CONCLUDED)})) AS completed,
             COUNT(*) FILTER (WHERE status IN (${sqlList(AWAITING_HANDOVER)})) AS in_progress,
             COUNT(*) FILTER (WHERE status = '${STATUS.DISPUTED}') AS disputed,
             COUNT(*) FILTER (WHERE status = '${STATUS.EXPIRED}') AS expired,
             COUNT(*) FILTER (WHERE status IN (${sqlList(REVERSED)})) AS failed,
             -- Revenue counts captured money (paid onwards, excluding
             -- refunds), which is a different question from how many
             -- deals concluded - hence the separate counts above.
             COALESCE(SUM(total_amount_cents) FILTER (WHERE status IN (${sqlList(MONEY_CAPTURED)})), 0) AS gross_cents,
             COALESCE(SUM(commission_amount_cents) FILTER (WHERE status IN (${sqlList(MONEY_CAPTURED)})), 0) AS commission_cents
           FROM transactions`),
    query(`SELECT
             (SELECT COUNT(*) FROM conversations) AS conversations,
             (SELECT COUNT(*) FROM messages) AS messages,
             (SELECT COUNT(*) FROM reviews) AS reviews`),
    query(`SELECT
             COUNT(*) FILTER (WHERE status = 'open') AS open_reports,
             COUNT(*) FILTER (WHERE status = 'actioned') AS actioned_reports
           FROM reports`),
  ]);

  const listingTotals = listings.rows[0];
  const txTotals = transactions.rows[0];
  const activeListings = Number(listingTotals.active);
  const soldListings = Number(listingTotals.sold);

  return {
    users: {
      total: Number(users.rows[0].total),
      verified: Number(users.rows[0].verified),
      newLast30Days: Number(users.rows[0].new_last_30_days),
      payoutReady: Number(users.rows[0].payout_ready),
    },
    listings: {
      total: Number(listingTotals.total),
      active: activeListings,
      sold: soldListings,
      takenDown: Number(listingTotals.taken_down),
      totalViews: Number(listingTotals.total_views),
      // The core marketplace question: of everything ever listed, what
      // fraction actually found a buyer? A marketplace where nothing
      // sells has a supply problem dressed up as growth.
      sellThroughRate:
        activeListings + soldListings > 0
          ? Math.round((soldListings / (activeListings + soldListings)) * 1000) / 10
          : null,
    },
    transactions: {
      completed: Number(txTotals.completed),
      inProgress: Number(txTotals.in_progress),
      disputed: Number(txTotals.disputed),
      expired: Number(txTotals.expired),
      failed: Number(txTotals.failed),
      grossCents: Number(txTotals.gross_cents),
      commissionCents: Number(txTotals.commission_cents),
    },
    engagement: {
      conversations: Number(engagement.rows[0].conversations),
      messages: Number(engagement.rows[0].messages),
      reviews: Number(engagement.rows[0].reviews),
    },
    moderation: {
      openReports: Number(moderation.rows[0].open_reports),
      actionedReports: Number(moderation.rows[0].actioned_reports),
    },
  };
}

module.exports = { AnalyticsError, recordListingView, sellerStats, listingStats, platformStats };
