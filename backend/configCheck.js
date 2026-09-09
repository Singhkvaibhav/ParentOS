// Validates configuration at startup and refuses to boot on anything
// unsafe in production.
//
// The failure this prevents is specific and common: an app deploys with a
// default or missing secret and works perfectly, because nothing exercises
// the secret until someone attacks it. A JWT secret left at a development
// default doesn't break any test - it just means anyone who reads the
// repository can mint valid sessions.
//
// So the checks run at boot and hard-exit rather than warning. A process
// that won't start is a loud, immediate, fixable problem; a process that
// starts insecurely is a silent one discovered later by someone else.
const logger = require("./logger");

const isProduction = process.env.NODE_ENV === "production";

// Values that are fine locally and must never survive to production.
const KNOWN_INSECURE_VALUES = new Set([
  "dev-secret",
  "development",
  "changeme",
  "secret",
  "test",
  "postgres://postgres:postgres@localhost:5432/parentos",
]);

const MIN_SECRET_LENGTH = 32;

function check() {
  const errors = [];
  const warnings = [];

  const require_ = (name, { minLength = 0 } = {}) => {
    const value = process.env[name];
    if (!value) {
      errors.push(`${name} is not set.`);
      return;
    }
    if (KNOWN_INSECURE_VALUES.has(value.toLowerCase())) {
      errors.push(`${name} is set to a well-known development value.`);
    }
    if (minLength && value.length < minLength) {
      errors.push(`${name} is shorter than ${minLength} characters - too short to be a real secret.`);
    }
  };

  // --- Always required, in every environment ---
  if (!process.env.DATABASE_URL) errors.push("DATABASE_URL is not set.");
  if (!process.env.JWT_SECRET) errors.push("JWT_SECRET is not set.");

  if (!isProduction) {
    // Locally, a weak secret is acceptable; an absent one is not, because
    // the failure it produces (invalid tokens) is confusing to debug.
    return { errors, warnings, ok: errors.length === 0 };
  }

  // --- Production-only ---
  require_("JWT_SECRET", { minLength: MIN_SECRET_LENGTH });
  require_("DATABASE_URL");

  // Cookies are the whole auth mechanism; without TLS they travel in
  // clear text and SameSite protections are far weaker.
  if (process.env.COOKIE_SECURE === "false") {
    errors.push("COOKIE_SECURE must not be false in production - session cookies would be sent over plain HTTP.");
  }

  // An open CORS origin combined with credentialed cookies is a CSRF hole
  // that no amount of token checking fully closes.
  // Checks the RESOLVED value, not the raw variable. Validating a variable
  // the server doesn't read is worse than not validating at all: it reports
  // success while the server quietly serves a different configuration.
  const { resolveCorsOrigins } = require("./config");
  const cors = resolveCorsOrigins();
  const origins = cors.origins.join(",");

  if (cors.usingDefault) {
    errors.push("CORS_ORIGINS is not set - the API would fall back to the localhost dev origin and block your real frontend.");
  } else if (cors.source === "ALLOWED_ORIGINS") {
    warnings.push("ALLOWED_ORIGINS is deprecated - rename it to CORS_ORIGINS.");
  }

  if (cors.usingDefault) {
    // Already reported above; skip the shape checks on a default value.
  } else if (origins.includes("*")) {
    errors.push("CORS_ORIGINS contains a wildcard, which is unsafe with credentialed cookies.");
  } else if (origins.split(",").some((o) => o.trim().startsWith("http://"))) {
    errors.push("CORS_ORIGINS contains a plain-http origin.");
  }

  // Stripe: live money needs live keys, and mixing test/live is a classic
  // deploy mistake that reconciliation would later flag as 'stripe_missing'.
  if (!process.env.STRIPE_SECRET_KEY) {
    errors.push("STRIPE_SECRET_KEY is not set - checkout would fail for every buyer.");
  } else if (process.env.STRIPE_SECRET_KEY.startsWith("sk_test_")) {
    warnings.push("STRIPE_SECRET_KEY is a TEST key - no real payments will be taken.");
  }
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    // Without this, webhook signatures can't be verified, so either
    // payments never settle or forged webhooks are accepted.
    errors.push("STRIPE_WEBHOOK_SECRET is not set - payment webhooks cannot be verified.");
  }

  // Email: verification codes are how accounts are created at all.
  if (!process.env.SMTP_HOST) {
    errors.push("SMTP_HOST is not set - verification emails would only be written to logs, so nobody could sign up.");
  }

  // Object storage. Local disk is fine for development and wrong for
  // production for reasons that only show up once it's too late: container
  // filesystems are ephemeral, so every deploy silently deletes every
  // uploaded photo, and a second instance can't see the first one's files.
  if (!process.env.S3_BUCKET) {
    errors.push(
      "S3_BUCKET is not set - uploads would go to local disk, which is wiped on every deploy and invisible to other instances. Configure S3, R2 or another S3-compatible store."
    );
  } else {
    for (const key of ["S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]) {
      if (!process.env[key]) errors.push(`${key} is not set, but S3_BUCKET is - uploads would fail.`);
    }
    // Region is required by AWS; S3-compatible providers (R2, B2) use a
    // custom endpoint instead, so one or the other must be present.
    if (!process.env.S3_REGION && !process.env.S3_ENDPOINT) {
      errors.push("Set S3_REGION (AWS) or S3_ENDPOINT (R2/B2/other S3-compatible provider).");
    }
  }

  // Background jobs. Without Redis the app still works - it falls back to
  // in-process execution - but a restart loses queued AI replies and image
  // processing, so it's a warning rather than an error.
  if (!process.env.REDIS_URL) {
    warnings.push("REDIS_URL is not set - background jobs run in-process and are lost if the server restarts.");
  }

  // Where reset links and notification emails point. Defaults to
  // localhost, which would send every user a dead link.
  if (!process.env.FRONTEND_URL) {
    errors.push("FRONTEND_URL is not set - password reset and notification emails would link to localhost.");
  } else if (process.env.FRONTEND_URL.startsWith("http://")) {
    errors.push("FRONTEND_URL is plain http - password reset links would be sent over an unencrypted connection.");
  }

  // Images on local disk disappear on every container restart or redeploy.
  if (!process.env.S3_BUCKET) {
    warnings.push("No S3_BUCKET - uploads go to local disk, which does not survive a redeploy.");
  }

  if (!process.env.REDIS_URL) {
    warnings.push("No REDIS_URL - background jobs run in-process and are lost on restart; rate limits are per-instance.");
  }

  return { errors, warnings, ok: errors.length === 0 };
}

// Called from server.js before anything binds a port.
function assertValidConfig() {
  const { errors, warnings, ok } = check();

  for (const warning of warnings) logger.warn("config_warning", { detail: warning });

  if (!ok) {
    for (const error of errors) logger.error("config_invalid", { detail: error });
    logger.error("startup_aborted", {
      reason: "Configuration is not safe to run. Fix the errors above.",
      errorCount: errors.length,
    });
    // Hard exit: booting with bad config is worse than not booting.
    process.exit(1);
  }

  return { warnings };
}

module.exports = { assertValidConfig, check };
