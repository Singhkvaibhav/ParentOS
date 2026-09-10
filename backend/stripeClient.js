// Shared Stripe client - used by both the checkout/webhook flow and Connect
// onboarding, so there's one place that decides whether Stripe is
// configured at all.
const logger = require("./logger");

function getStripe() {
  const Stripe = require("stripe");
  if (!process.env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY.includes("your_key_here")) {
    throw new Error("Stripe isn't configured yet - set STRIPE_SECRET_KEY in backend/.env (see README).");
  }

  const options = {};

  // Lets the SDK be pointed at a local stub (stripe-mock, or the fake used
  // by the end-to-end script) instead of api.stripe.com.
  //
  // The value of doing this rather than mocking the `stripe` module in
  // Jest: the real SDK still builds the requests, signs them, applies its
  // API version and parses the responses. A module mock skips all of that,
  // which is exactly where wiring bugs live.
  if (process.env.STRIPE_API_HOST) {
    // Sending live traffic to a non-Stripe host would mean payments going
    // nowhere while the app reports success, so this is refused outright
    // in production rather than merely warned about.
    if (process.env.NODE_ENV === "production") {
      throw new Error("STRIPE_API_HOST is set in production - refusing to send payment traffic to a non-Stripe host.");
    }
    options.host = process.env.STRIPE_API_HOST;
    options.port = Number(process.env.STRIPE_API_PORT || 443);
    options.protocol = process.env.STRIPE_API_PROTOCOL || "https";
    logger.warn("stripe_api_host_overridden", {
      host: options.host, port: options.port,
      note: "Not talking to real Stripe - test/dev only.",
    });
  }

  return new Stripe(process.env.STRIPE_SECRET_KEY, options);
}

module.exports = { getStripe };
