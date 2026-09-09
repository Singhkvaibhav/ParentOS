// Error tracking, deliberately behind a tiny interface.
//
// No SDK is bundled. Adding @sentry/node (or a competitor) means taking on
// a large dependency that monkey-patches core modules, and the choice of
// vendor shouldn't be baked into every call site. Instead error reporting
// goes through this one module, so swapping in a real SDK later is a
// single-file change.
//
// A no-op when unconfigured, so development and tests are unaffected.
const logger = require("./logger");

const DSN = process.env.ERROR_TRACKING_DSN || "";
const ENABLED = !!DSN;
const RELEASE = process.env.RELEASE_SHA || "unknown";

// Same redaction concern as the logger: an exception's context can carry
// request bodies, and a request body can carry a password.
const SENSITIVE = /password|token|secret|authorization|cookie|verification_code/i;

function scrub(obj, depth = 0) {
  if (depth > 4 || obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map((v) => scrub(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = SENSITIVE.test(k) ? "[redacted]" : scrub(v, depth + 1);
  }
  return out;
}

async function captureException(err, context = {}) {
  // Always log locally, whether or not a tracker is configured - the log
  // is the thing that definitely exists during an incident.
  logger.error("exception_captured", { err, ...scrub(context) });

  if (!ENABLED) return;

  try {
    // Sentry's store endpoint accepts a plain JSON envelope, so a minimal
    // client needs no SDK. Fire-and-forget with a short timeout: error
    // reporting must never delay or fail a request.
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 2000).unref?.();

    await fetch(DSN, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        release: RELEASE,
        environment: process.env.NODE_ENV || "development",
        message: err?.message,
        stack: err?.stack,
        extra: scrub(context),
        timestamp: new Date().toISOString(),
      }),
    });
  } catch (e) {
    // A tracker being down must not become a second incident.
    logger.warn("error_tracking_delivery_failed", { err: e });
  }
}

module.exports = { captureException, isEnabled: () => ENABLED };
