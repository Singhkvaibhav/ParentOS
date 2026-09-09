const { query } = require("../db");
const { parseId } = require("../utils/validation");
const logger = require("../logger");
const { notify } = require("./notificationsService");

class ModerationError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const VALID_REASONS = new Set(["safety", "prohibited", "misleading", "harassment", "spam", "other"]);
const MAX_DETAIL_LENGTH = 2000;

// --- Reporting -------------------------------------------------------------

// Files a report against exactly one target. The database enforces
// "exactly one" and "no duplicate open report" (migration 005), so those
// aren't re-checked here - but the errors are translated into useful
// messages rather than surfacing as raw constraint violations.
async function createReport(reporterId, { listingId, reportedUserId, conversationId, reason, detail }) {
  const targets = [listingId, reportedUserId, conversationId].filter((t) => t !== undefined && t !== null);
  if (targets.length !== 1) {
    throw new ModerationError(400, "Report exactly one of: listingId, reportedUserId, conversationId.");
  }
  if (!VALID_REASONS.has(reason)) {
    throw new ModerationError(400, `Invalid reason - must be one of: ${[...VALID_REASONS].join(", ")}.`);
  }
  if (detail && String(detail).length > MAX_DETAIL_LENGTH) {
    throw new ModerationError(400, `Detail must be ${MAX_DETAIL_LENGTH} characters or fewer.`);
  }

  const parsed = {
    listingId: listingId != null ? parseId(listingId, "listingId", ModerationError) : null,
    reportedUserId: reportedUserId != null ? parseId(reportedUserId, "reportedUserId", ModerationError) : null,
    conversationId: conversationId != null ? parseId(conversationId, "conversationId", ModerationError) : null,
  };

  if (parsed.reportedUserId === reporterId) {
    throw new ModerationError(400, "You can't report yourself.");
  }

  // Only someone actually in a conversation can report it - otherwise
  // this endpoint would let anyone probe whether a conversation id exists.
  if (parsed.conversationId) {
    const { rows } = await query(
      "SELECT 1 FROM conversations WHERE id = $1 AND (buyer_id = $2 OR seller_id = $2)",
      [parsed.conversationId, reporterId]
    );
    if (!rows[0]) throw new ModerationError(404, "Conversation not found.");
  }

  try {
    const { rows } = await query(
      `INSERT INTO reports (reporter_id, listing_id, reported_user_id, conversation_id, reason, detail)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [reporterId, parsed.listingId, parsed.reportedUserId, parsed.conversationId, reason, detail || null]
    );

    // Reports are a safety signal - log them so a spike is visible in
    // monitoring without having to query the database.
    logger.warn("report_filed", {
      reportId: rows[0].id,
      reporterId,
      reason,
      target: parsed.listingId ? "listing" : parsed.reportedUserId ? "user" : "conversation",
    });

    return rows[0];
  } catch (e) {
    if (e.code === "23505") throw new ModerationError(409, "You've already reported this - it's in the queue."); // unique_violation
    if (e.code === "23503") throw new ModerationError(404, "The thing you're reporting doesn't exist."); // fk_violation
    throw e;
  }
}

// --- Blocking --------------------------------------------------------------

async function blockUser(blockerId, blockedIdInput) {
  const blockedId = parseId(blockedIdInput, "userId", ModerationError);
  if (blockedId === blockerId) throw new ModerationError(400, "You can't block yourself.");

  const { rows } = await query("SELECT id FROM users WHERE id = $1", [blockedId]);
  if (!rows[0]) throw new ModerationError(404, "User not found.");

  await query(
    "INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    [blockerId, blockedId]
  );
}

async function unblockUser(blockerId, blockedId) {
  await query("DELETE FROM blocks WHERE blocker_id = $1 AND blocked_id = $2", [blockerId, blockedId]);
}

async function listBlocks(userId) {
  const { rows } = await query(
    `SELECT users.id, users.name FROM blocks
     JOIN users ON users.id = blocks.blocked_id
     WHERE blocks.blocker_id = $1 ORDER BY blocks.created_at DESC`,
    [userId]
  );
  return rows;
}

// True if EITHER user has blocked the other. Blocking is symmetric in
// effect: if A blocks B, B also shouldn't be able to start a conversation
// with A - otherwise blocking only stops the person who didn't want
// contact in the first place.
async function isBlockedBetween(userA, userB) {
  const { rows } = await query(
    `SELECT 1 FROM blocks
     WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)
     LIMIT 1`,
    [userA, userB]
  );
  return rows.length > 0;
}

// --- Moderator actions -----------------------------------------------------

async function requireAdmin(userId) {
  const { rows } = await query("SELECT is_admin FROM users WHERE id = $1", [userId]);
  if (!rows[0]?.is_admin) throw new ModerationError(403, "Moderator access required.");
}

async function listReports(adminId, { status = "open", limit = 50 } = {}) {
  await requireAdmin(adminId);
  const { rows } = await query(
    `SELECT reports.*, reporter.name AS reporter_name, listings.title AS listing_title
     FROM reports
     JOIN users reporter ON reporter.id = reports.reporter_id
     LEFT JOIN listings ON listings.id = reports.listing_id
     WHERE reports.status = $1
     ORDER BY reports.created_at ASC
     LIMIT $2`,
    [status, Math.min(Number(limit) || 50, 200)]
  );
  return rows;
}

// Takes a listing down. Uses a dedicated moderated_at column rather than
// the seller-facing status, so a seller can't undo a moderation decision
// by relisting (see listingsService's state machine, which refuses to
// touch a moderated listing).
async function takeDownListing(adminId, listingIdInput, reason) {
  await requireAdmin(adminId);
  const listingId = parseId(listingIdInput, "listingId", ModerationError);

  const {
    requestTakedown, drainTasks, ModerationSagaError,
  } = require("./moderationSagaService");

  // Step one is a single database transaction: the listing is hidden AND
  // one refund task is recorded per affected order, atomically. Previously
  // these were separate statements with Stripe calls in between, so a
  // failure could leave a hidden listing with captured money and no record
  // that a refund was owed. Now the obligation is durable the moment the
  // takedown is accepted.
  let requested;
  try {
    requested = await requestTakedown({ listingId, adminId, reason });
  } catch (e) {
    if (e instanceof ModerationSagaError) throw new ModerationError(e.status, e.message);
    throw e;
  }

  logger.warn("listing_taken_down", { listingId, adminId, reason });

  // The seller needs to know their listing was removed and why - silently
  // hiding it would leave them wondering why nobody's contacting them.
  notify({
    userId: requested.listing.seller_id,
    type: "listing_taken_down",
    title: `"${requested.listing.title}" was removed`,
    body: reason || "Removed by a moderator.",
    listingId,
  });

  // Step two talks to Stripe and CAN fail. It is deliberately not allowed
  // to fail the takedown: the unsafe listing is already hidden, which is
  // the safety-critical outcome. Anything unsettled stays recorded as an
  // outstanding task and surfaces in the unsettled queue, rather than
  // being lost the way the old catch-and-continue lost it.
  const drain = await drainTasks({ actionId: requested.action.id });

  return {
    actionId: requested.action.id,
    affectedOrders: requested.taskCount,
    settled: drain.succeeded,
    unsettled: requested.taskCount - drain.succeeded,
  };
}

async function restoreListing(adminId, listingIdInput) {
  await requireAdmin(adminId);
  const listingId = parseId(listingIdInput, "listingId", ModerationError);
  await query("UPDATE listings SET moderated_at = NULL, moderation_reason = NULL WHERE id = $1", [listingId]);
  logger.info("listing_restored", { listingId, adminId });
}

async function resolveReport(adminId, reportIdInput, { status, note }) {
  await requireAdmin(adminId);
  const reportId = parseId(reportIdInput, "reportId", ModerationError);
  if (!["reviewing", "actioned", "dismissed"].includes(status)) {
    throw new ModerationError(400, "Status must be one of: reviewing, actioned, dismissed.");
  }

  const resolvedAt = status === "reviewing" ? null : "now()";
  const { rowCount } = await query(
    `UPDATE reports SET status = $1, moderator_id = $2, moderator_note = $3,
       resolved_at = ${resolvedAt === null ? "NULL" : "now()"}
     WHERE id = $4`,
    [status, adminId, note || null, reportId]
  );
  if (rowCount === 0) throw new ModerationError(404, "Report not found.");

  logger.info("report_resolved", { reportId, adminId, status });
}

module.exports = {
  ModerationError,
  // Exposed so controllers can gate admin-only routes without
  // duplicating the check - it stays in the service either way.
  requireAdminForRequest: requireAdmin,
  createReport,
  blockUser,
  unblockUser,
  listBlocks,
  isBlockedBetween,
  listReports,
  takeDownListing,
  restoreListing,
  resolveReport,
};
