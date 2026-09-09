// Shared Stripe client - used by both the checkout/webhook flow and Connect
// onboarding, so there's one place that decides whether Stripe is
// configured at all.
function getStripe() {
  const Stripe = require("stripe");
  if (!process.env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY.includes("your_key_here")) {
    throw new Error("Stripe isn't configured yet - set STRIPE_SECRET_KEY in backend/.env (see README).");
  }
  return new Stripe(process.env.STRIPE_SECRET_KEY);
}

module.exports = { getStripe };
