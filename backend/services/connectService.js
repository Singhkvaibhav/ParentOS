const { query } = require("../db");
const { getStripe } = require("../stripeClient");

// Sellers need a Stripe Connect account before checkout can route their
// share of a sale directly to them (see transactionsService's
// application_fee_amount / transfer_data). Uses Stripe Express accounts -
// the lightest-weight Connect option, where Stripe hosts identity
// verification and payout setup.

class ConnectError extends Error {
  constructor(status, message, code = null, meta = null) {
    super(message);
    this.status = status;
    this.code = code;
    if (meta) this.meta = meta;
  }
}

// getStripe() throws a plain Error (with a specific message about missing
// config) when Stripe isn't set up - wrap it in our own typed error here so
// the controller can check `instanceof`, the same pattern every other
// service uses, instead of matching on the error's message text (which
// would silently stop working the moment that message gets reworded).
function requireStripe() {
  try {
    return getStripe();
  } catch (e) {
    throw new ConnectError(503, e.message);
  }
}

async function onboard(userId) {
  const stripe = requireStripe();

  const { rows } = await query("SELECT * FROM users WHERE id = $1", [userId]);
  const user = rows[0];
  let accountId = user.stripe_connect_account_id;

  if (!accountId) {
    const account = await stripe.accounts.create({
      type: "express",
      email: user.email,
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
    });
    accountId = account.id;
    await query("UPDATE users SET stripe_connect_account_id = $1 WHERE id = $2", [accountId, userId]);
  }

  const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";
  const accountLink = await stripe.accountLinks.create({
    account: accountId,
    refresh_url: `${frontendUrl}/profile?connect=refresh`,
    return_url: `${frontendUrl}/profile?connect=return`,
    type: "account_onboarding",
  });

  return { onboardingUrl: accountLink.url };
}

async function status(userId) {
  const { rows } = await query("SELECT * FROM users WHERE id = $1", [userId]);
  const user = rows[0];
  if (!user.stripe_connect_account_id) {
    return { connected: false, chargesEnabled: false, payoutsEnabled: false };
  }

  const stripe = requireStripe();
  const account = await stripe.accounts.retrieve(user.stripe_connect_account_id);
  await query(
    "UPDATE users SET connect_charges_enabled = $1, connect_payouts_enabled = $2 WHERE id = $3",
    [!!account.charges_enabled, !!account.payouts_enabled, userId]
  );

  return { connected: true, chargesEnabled: !!account.charges_enabled, payoutsEnabled: !!account.payouts_enabled };
}

// "Ready to receive money": a Connect account exists AND Stripe has
// confirmed both charges and payouts are enabled on it. This is the one
// definition of that concept - used by both checkout's gate
// (transactionsService) and platform-health reporting (analyticsService) -
// so the two can't drift the way the payout-readiness metric once did by
// checking only connect_charges_enabled while checkout also required
// connect_payouts_enabled.
function isPayoutReady(user) {
  return !!(user?.stripe_connect_account_id && user.connect_charges_enabled && user.connect_payouts_enabled);
}

// The same rule as a raw SQL boolean expression, for aggregate queries
// (COUNT(*) FILTER (WHERE ...)) that never materialize a JS user object.
const PAYOUT_READY_SQL = "(stripe_connect_account_id IS NOT NULL AND connect_charges_enabled AND connect_payouts_enabled)";

module.exports = { ConnectError, onboard, status, isPayoutReady, PAYOUT_READY_SQL };
