// Product analytics (funnels, session replay) via PostHog - separate from
// services/analytics.js, which is this app's OWN operational dashboards
// (seller stats, listing views) served back into its own UI. This sends
// usage data to a third party built for understanding behaviour over
// time, which is why it's consent-gated below rather than always-on.
//
// No key configured -> ENABLED is false and every export here is an
// inert no-op, the same "runs out of the box, real provider optional"
// pattern as backend/errorTracking.js and backend/storage.
import posthog from "posthog-js";

const KEY = import.meta.env.VITE_POSTHOG_KEY;
const HOST = import.meta.env.VITE_POSTHOG_HOST || "https://us.i.posthog.com";

export const ENABLED = !!KEY;

if (ENABLED) {
  posthog.init(KEY, {
    api_host: HOST,
    // Don't create a full "person" profile for every anonymous visitor -
    // only once someone is identified (see identify() below). Cheaper and
    // means a browse-and-leave visit isn't tracked as a person at all.
    person_profiles: "identified_only",
    // GDPR/ePrivacy: this is non-essential tracking, so nothing is
    // actually captured until the user accepts the banner (see
    // CookieConsent.jsx) and setConsent(true) below calls opt_in_capturing().
    // PostHog persists the choice itself (localStorage), so a returning
    // visitor who already accepted isn't asked again.
    opt_out_capturing_by_default: true,
    // Session replay: masks every <input>/<textarea> VALUE app-wide (the
    // sell form's price/description, the message composer, profile
    // fields) - see also Inbox.jsx, which pauses recording entirely while
    // open, since already-sent message text renders as plain DOM text
    // that input-masking alone wouldn't cover.
    session_recording: {
      maskAllInputs: true,
    },
  });
}

export function hasConsented() {
  return ENABLED && posthog.has_opted_in_capturing();
}

export function setConsent(accepted) {
  if (!ENABLED) return;
  if (accepted) posthog.opt_in_capturing();
  else posthog.opt_out_capturing();
}

export function hasAnsweredConsent() {
  return ENABLED && (posthog.has_opted_in_capturing() || posthog.has_opted_out_capturing());
}

// distinct_id is the internal numeric id only - never email. Minimizes
// what's sent to a third party by default; add properties here only for
// things genuinely useful to segment by (verified/admin status), not PII.
export function identify(user) {
  if (!ENABLED || !user) return;
  posthog.identify(String(user.id), { verified: user.verified, isAdmin: user.isAdmin });
}

export function resetIdentity() {
  if (ENABLED) posthog.reset();
}

export function track(event, properties) {
  if (ENABLED) posthog.capture(event, properties);
}

export function pauseSessionRecording() {
  if (ENABLED) posthog.stopSessionRecording();
}

export function resumeSessionRecording() {
  if (ENABLED) posthog.startSessionRecording();
}
