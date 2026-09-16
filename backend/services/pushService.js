const { query } = require("../db");
const logger = require("../logger");

class PushError extends Error {
  constructor(status, message, code = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// No API key or account needed for Expo's push service at this volume -
// see https://docs.expo.dev/push-notifications/sending-notifications/.
// If this ever needs authenticated (higher-volume) sending, that's an
// Authorization header added here, not a different endpoint.
const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

// Matches both the legacy ExponentPushToken[...] and current
// ExpoPushToken[...] formats the SDK can hand back.
const TOKEN_PATTERN = /^Expo(nent)?PushToken\[.+\]$/;

async function registerToken(userId, token, platform) {
  if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) {
    throw new PushError(400, "That doesn't look like a valid Expo push token.", "invalidPushToken");
  }
  if (platform !== "ios" && platform !== "android") {
    throw new PushError(400, "platform must be 'ios' or 'android'.", "invalidPlatform");
  }
  // Upsert on the token, not (user_id, token): the same physical device
  // can end up registered to a different account after a sign-out/back-in,
  // and a stale row pointing at the previous user would otherwise push
  // this device's notifications to someone who no longer uses it.
  await query(
    `INSERT INTO push_tokens (user_id, token, platform)
     VALUES ($1, $2, $3)
     ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform, last_used_at = now()`,
    [userId, token, platform]
  );
}

async function unregisterToken(userId, token) {
  // Scoped to the caller - a request can only remove its OWN token, not
  // an arbitrary one it happens to know.
  await query("DELETE FROM push_tokens WHERE user_id = $1 AND token = $2", [userId, token]);
}

// Fire-and-forget from every caller's perspective, exactly like email in
// notificationsService.js - a failed push must never fail the marketplace
// action (a message send, a sale) that triggered it.
async function sendPush(userId, { title, body, data = {} }) {
  const { rows } = await query("SELECT token FROM push_tokens WHERE user_id = $1", [userId]);
  if (rows.length === 0) return;

  const messages = rows.map((r) => ({ to: r.token, title, body: body || undefined, data, sound: "default" }));

  let res;
  try {
    res = await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(messages),
    });
  } catch (e) {
    logger.warn("push_send_network_error", { userId, err: e.message });
    return;
  }

  if (!res.ok) {
    logger.warn("push_send_failed", { userId, status: res.status });
    return;
  }

  const { data: results } = await res.json();
  // Expo's response is positional - results[i] answers for messages[i].
  await Promise.all(
    (results || []).map((result, i) => {
      if (result.status === "error" && result.details?.error === "DeviceNotRegistered") {
        // The device uninstalled the app or revoked permission - Expo will
        // never deliver to this token again, so keeping it means paying
        // the same failure on every future notification indefinitely.
        return query("DELETE FROM push_tokens WHERE token = $1", [messages[i].to]).catch(() => {});
      }
      if (result.status === "error") {
        logger.warn("push_message_failed", { userId, error: result.details?.error || result.message });
      }
      return null;
    })
  );
}

module.exports = { PushError, registerToken, unregisterToken, sendPush };
