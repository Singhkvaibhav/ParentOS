const { query } = require("../db");
const { CONCLUDED, sqlList } = require("../transactionStatus");

// Trust signals shown to buyers deciding whether to deal with someone.
//
// A deliberate choice here: this exposes *component signals* (rating,
// completed sales, account age, verification) rather than reducing them to
// a single opaque score. A "87% trusted" number invites the questions
// "why?" and "how do I raise it?", neither of which we could answer
// honestly - and a wrong single number is worse than several honest facts.
//
// The one derived value is a coarse `level`, used only to decide whether
// to show a badge at all. It's intentionally hard to game: it needs real
// completed transactions, not just a filled-in profile.

const MIN_RATING_COUNT_TO_DISPLAY = 3; // below this, an average is noise - one bad day shouldn't read as "2.0 stars"

// Derives a coarse badge level. Thresholds are judgement calls, not
// science - they're set so a badge means something a buyer can rely on
// rather than something every new account gets automatically.
function deriveLevel({ completedSales, ratingCount, averageRating, verified }) {
  if (!verified) return "unverified";
  if (completedSales >= 10 && ratingCount >= 5 && averageRating >= 4.5) return "established";
  if (completedSales >= 3 && ratingCount >= 1 && averageRating >= 4.0) return "trusted";
  if (completedSales >= 1) return "active";
  return "new";
}

function summarize(user) {
  const ratingCount = Number(user.rating_count || 0);
  const ratingSum = Number(user.rating_sum || 0);

  // Only show an average once there's enough of it to mean something -
  // "5.0 from 1 review" reads as far stronger evidence than it is.
  const averageRating =
    ratingCount >= MIN_RATING_COUNT_TO_DISPLAY
      ? Math.round((ratingSum / ratingCount) * 10) / 10
      : null;

  const completedSales = Number(user.completed_sales_count || 0);
  const completedPurchases = Number(user.completed_purchases_count || 0);

  return {
    verified: !!user.verified,
    memberSince: user.created_at,
    completedSales,
    completedPurchases,
    ratingCount,
    averageRating,
    // Present even when averageRating is withheld, so the UI can say
    // "2 reviews" without implying a score.
    hasEnoughReviewsToRate: ratingCount >= MIN_RATING_COUNT_TO_DISPLAY,
    level: deriveLevel({
      completedSales,
      ratingCount,
      averageRating: ratingCount > 0 ? ratingSum / ratingCount : 0,
      verified: !!user.verified,
    }),
  };
}

// Recomputes a user's cached review aggregates from source. Called after a
// review is written - cheap because reviews are rare relative to reads,
// and recomputing from source means a bug in incremental updates can't
// leave the cache permanently wrong.
async function refreshRatingAggregates(userId) {
  await query(
    `UPDATE users SET
       rating_sum = COALESCE((SELECT SUM(rating) FROM reviews WHERE reviewee_id = $1), 0),
       rating_count = COALESCE((SELECT COUNT(*) FROM reviews WHERE reviewee_id = $1), 0)
     WHERE id = $1`,
    [userId]
  );
}

// Recomputes both parties' transaction counters from source.
//
// These count only status = 'completed' - i.e. the buyer confirmed they
// actually received the item. They deliberately do NOT count 'paid'.
// Payment succeeding means money changed hands, not that the deal
// concluded: a seller can take payment and never hand anything over. The
// counters feed the public trust badge, so counting 'paid' would let a
// seller look established on the strength of sales that never completed -
// exactly the case a buyer checks the badge to avoid.
//
// Recomputed from source rather than incremented, for the same reason as
// refreshRatingAggregates: it's idempotent and self-healing. A completed
// order that is later disputed and refunded correctly drops back out of
// the count, which an increment-only counter could never undo. Completions
// are rare relative to profile reads, and both queries hit an index on the
// transactions table, so the cost is not on any hot path.
async function refreshTransactionCounters(userId, tx = query) {
  await tx(
    `UPDATE users SET
       completed_sales_count = COALESCE((
         SELECT COUNT(*) FROM transactions WHERE seller_id = $1 AND status IN (${sqlList(CONCLUDED)})
       ), 0),
       completed_purchases_count = COALESCE((
         SELECT COUNT(*) FROM transactions WHERE buyer_id = $1 AND status IN (${sqlList(CONCLUDED)})
       ), 0)
     WHERE id = $1`,
    [userId]
  );
}

module.exports = { summarize, refreshRatingAggregates, refreshTransactionCounters, MIN_RATING_COUNT_TO_DISPLAY };
