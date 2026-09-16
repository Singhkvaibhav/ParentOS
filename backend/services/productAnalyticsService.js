// Product analytics (funnels, feature usage over time) via PostHog -
// deliberately separate from services/analyticsService.js, which serves
// operational dashboards (seller stats, platform totals) back into the
// app's own UI. This module answers a different question ("where do
// people drop off between signing up and their first sale?"), sent to a
// third party built for that, not computed from our own database.
//
// Same pattern as errorTracking.js: a no-op when unconfigured, so
// development and tests are unaffected, and nothing here can ever be a
// reason a marketplace action fails or waits.
//
// This is the SERVER side of a client/server split, not the whole system:
// early funnel steps (viewed a listing, started checkout) are captured
// client-side (frontend/src/productAnalytics.js) since they happen before
// or without a guaranteed server round-trip worth instrumenting. The one
// event captured here instead of there is the money-final one - a
// checkout actually settling - because that fact is only ever confirmed
// by Stripe's webhook reaching this server, and a client-side "payment
// succeeded" event would fire (or fail to) based on whether the buyer's
// tab was still open, not on what actually happened to their money.
const logger = require("../logger");

const API_KEY = process.env.POSTHOG_API_KEY || "";
const HOST = process.env.POSTHOG_HOST || "https://us.i.posthog.com";
const ENABLED = !!API_KEY;

let client = null;
function getClient() {
  if (!ENABLED) return null;
  if (!client) {
    const { PostHog } = require("posthog-node");
    client = new PostHog(API_KEY, { host: HOST });
  }
  return client;
}

// Fire-and-forget from every caller's perspective, exactly like
// notificationsService.js's notify() - a marketplace action must never
// fail, or even wait, on an analytics call.
function capture(distinctId, event, properties = {}) {
  const c = getClient();
  if (!c) return;
  try {
    c.capture({ distinctId: String(distinctId), event, properties });
  } catch (e) {
    // Field named analyticsEvent, not event - logger.js's own `event`
    // parameter is the log line's event name (here,
    // "product_analytics_capture_failed"), and a same-named field in the
    // context object silently overwrites it via the later object spread.
    logger.warn("product_analytics_capture_failed", { analyticsEvent: event, err: e.message });
  }
}

// Called from server.js's graceful shutdown - posthog-node batches events
// in memory and flushes on an interval, so exiting without this can drop
// whatever was captured in the last few seconds before a deploy.
async function shutdown() {
  if (client) await client.shutdown().catch(() => {});
}

module.exports = { capture, shutdown, ENABLED };
