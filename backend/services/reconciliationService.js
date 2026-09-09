const { query } = require("../db");
const { getStripe } = require("../stripeClient");
const { parseId } = require("../utils/validation");
const { STATUS } = require("../transactionStatus");
const logger = require("../logger");

class ReconciliationError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// (#9) Compares what Stripe believes against what the database believes.
//
// Webhooks are at-least-once, not exactly-once: they can be delayed,
// dropped during a redeploy, or rejected by a failed signature check.
// Without reconciliation, a missed webhook is invisible until a customer
// complains that they paid and got nothing.
//
// Deliberately read-only. It flags discrepancies for a human rather than
// auto-correcting them, because both directions of error can be caused by
// something this process can't see (a manual Stripe dashboard refund, a
// dispute, a partial capture). Silently "fixing" a mismatch by trusting
// one side could turn a reporting problem into a money problem.

// Stripe statuses that mean the money is actually captured.
const STRIPE_SUCCEEDED = "succeeded";
const STRIPE_TERMINAL_FAILURES = new Set(["canceled", "requires_payment_method"]);

async function recordIssue({
  transactionId, paymentIntentId, issueType,
  dbStatus, stripeStatus, dbAmountCents, stripeAmountCents, detail,
}) {
  // A repeat sighting of an unresolved issue bumps last_seen_at rather
  // than inserting a duplicate - re-reporting every pass would bury new
  // problems, and the age of a discrepancy is itself useful information.
  const { rows } = await query(
    `INSERT INTO reconciliation_issues
       (transaction_id, stripe_payment_intent_id, issue_type, db_status, stripe_status,
        db_amount_cents, stripe_amount_cents, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (transaction_id, issue_type) WHERE status = 'open'
     DO UPDATE SET last_seen_at = now()
     RETURNING id, (xmax = 0) AS is_new`,
    [transactionId, paymentIntentId, issueType, dbStatus, stripeStatus, dbAmountCents, stripeAmountCents, detail || null]
  );
  return rows[0];
}

// Checks one transaction against Stripe. Returns an issue type, or null
// when the two systems agree.
function classify(transaction, paymentIntent) {
  const dbStatus = transaction.status;
  const stripeStatus = paymentIntent.status;

  // Money captured at Stripe, but the order never settled here. This is
  // the one that hurts a buyer: they've been charged, the listing
  // reservation expires, and they receive nothing.
  if (stripeStatus === STRIPE_SUCCEEDED && dbStatus === STATUS.PENDING) {
    return "stripe_succeeded_db_pending";
  }

  // The order settled here but the payment did not succeed. This one hurts
  // the seller: they may hand over an item for money that never arrived.
  if (
    STRIPE_TERMINAL_FAILURES.has(stripeStatus) &&
    [STATUS.PAID, STATUS.FULFILLED, STATUS.COMPLETED].includes(dbStatus)
  ) {
    return "stripe_failed_db_paid";
  }

  // Refunded at Stripe (often from the dashboard, which produces no
  // webhook this app listens for) while the order still looks live.
  const refunded = paymentIntent.latest_charge?.refunded === true || Number(paymentIntent.amount_refunded || 0) > 0;
  if (refunded && [STATUS.PAID, STATUS.FULFILLED, STATUS.COMPLETED].includes(dbStatus)) {
    return "stripe_refunded_db_active";
  }

  // The two systems disagree on the amount. Checked only where money was
  // actually captured; a pending intent can legitimately differ if the
  // order was rebuilt.
  if (
    stripeStatus === STRIPE_SUCCEEDED &&
    Number(paymentIntent.amount) !== Number(transaction.total_amount_cents)
  ) {
    return "amount_mismatch";
  }

  return null;
}

// Runs a full pass. Scoped to transactions that could plausibly be wrong
// rather than the entire history: terminal states like 'expired' or
// 'cancelled' with no PaymentIntent have nothing to reconcile against, and
// scanning everything forever would make the job slower every week.
async function runReconciliation({ lookbackDays = 30, limit = 500 } = {}) {
  const { rows: runRows } = await query(
    "INSERT INTO reconciliation_runs DEFAULT VALUES RETURNING id"
  );
  const runId = runRows[0].id;

  let stripe;
  try {
    stripe = getStripe();
  } catch (e) {
    await query(
      "UPDATE reconciliation_runs SET finished_at = now(), error = $1 WHERE id = $2",
      ["Stripe is not configured", runId]
    );
    throw new ReconciliationError(503, "Stripe isn't configured, so reconciliation can't run.");
  }

  const { rows: transactions } = await query(
    `SELECT * FROM transactions
     WHERE stripe_payment_intent_id IS NOT NULL
       AND created_at > now() - ($1 || ' days')::interval
       AND status <> 'expired'
     ORDER BY created_at DESC
     LIMIT $2`,
    [String(lookbackDays), limit]
  );

  let checked = 0;
  let issuesFound = 0;

  for (const transaction of transactions) {
    checked += 1;
    let paymentIntent;

    try {
      paymentIntent = await stripe.paymentIntents.retrieve(transaction.stripe_payment_intent_id);
    } catch (e) {
      // A PaymentIntent the database references but Stripe doesn't know
      // about is itself a discrepancy worth surfacing - it usually means
      // test and live keys were mixed, which is worth catching early.
      if (e?.statusCode === 404 || e?.code === "resource_missing") {
        const result = await recordIssue({
          transactionId: transaction.id,
          paymentIntentId: transaction.stripe_payment_intent_id,
          issueType: "stripe_missing",
          dbStatus: transaction.status,
          stripeStatus: null,
          dbAmountCents: transaction.total_amount_cents,
          stripeAmountCents: null,
          detail: "Stripe has no PaymentIntent with this id.",
        });
        if (result?.is_new) issuesFound += 1;
        continue;
      }
      // A transient Stripe error shouldn't abort the whole pass and leave
      // the rest unchecked.
      logger.warn("reconciliation_stripe_fetch_failed", { transactionId: transaction.id, err: e });
      continue;
    }

    const issueType = classify(transaction, paymentIntent);
    if (!issueType) continue;

    const result = await recordIssue({
      transactionId: transaction.id,
      paymentIntentId: transaction.stripe_payment_intent_id,
      issueType,
      dbStatus: transaction.status,
      stripeStatus: paymentIntent.status,
      dbAmountCents: transaction.total_amount_cents,
      stripeAmountCents: paymentIntent.amount ?? null,
    });
    if (result?.is_new) issuesFound += 1;

    logger.warn("reconciliation_discrepancy", {
      transactionId: transaction.id,
      issueType,
      dbStatus: transaction.status,
      stripeStatus: paymentIntent.status,
    });
  }

  await query(
    `UPDATE reconciliation_runs
     SET finished_at = now(), transactions_checked = $1, issues_found = $2
     WHERE id = $3`,
    [checked, issuesFound, runId]
  );

  return { runId, checked, issuesFound };
}

// --- Admin surface --------------------------------------------------------

async function requireAdmin(userId) {
  const { rows } = await query("SELECT is_admin FROM users WHERE id = $1", [userId]);
  if (!rows[0]?.is_admin) throw new ReconciliationError(403, "Moderator access required.");
}

async function listIssues(adminId, { status = "open" } = {}) {
  await requireAdmin(adminId);
  const { rows } = await query(
    `SELECT * FROM reconciliation_issues WHERE status = $1 ORDER BY first_seen_at ASC LIMIT 200`,
    [status]
  );

  // The last run matters as much as the issues: an empty list means
  // "nothing wrong" only if reconciliation actually ran recently.
  const { rows: lastRun } = await query(
    "SELECT * FROM reconciliation_runs ORDER BY id DESC LIMIT 1"
  );

  return { issues: rows, lastRun: lastRun[0] || null };
}

async function resolveIssue(adminId, issueIdInput, { status, note }) {
  await requireAdmin(adminId);
  const issueId = parseId(issueIdInput, "issueId", ReconciliationError);
  if (!["resolved", "ignored"].includes(status)) {
    throw new ReconciliationError(400, "Status must be 'resolved' or 'ignored'.");
  }

  const { rowCount } = await query(
    `UPDATE reconciliation_issues
     SET status = $1, resolved_by = $2, resolution_note = $3, resolved_at = now()
     WHERE id = $4 AND status = 'open'`,
    [status, adminId, note || null, issueId]
  );
  if (rowCount === 0) throw new ReconciliationError(404, "Issue not found, or already resolved.");

  logger.info("reconciliation_issue_resolved", { issueId, adminId, status });
}

async function triggerRun(adminId) {
  await requireAdmin(adminId);
  return runReconciliation();
}

module.exports = {
  ReconciliationError,
  runReconciliation,
  listIssues,
  resolveIssue,
  triggerRun,
  classify,
};
