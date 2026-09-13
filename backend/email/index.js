// Pluggable email sending, same pattern as backend/storage: a real provider
// when configured, a safe local fallback otherwise, so this runs out of the
// box without requiring an email account first.
//
// Uses plain SMTP via nodemailer rather than a vendor-specific SDK, so it
// works with Gmail SMTP, Postmark, SendGrid, AWS SES, or any other provider
// that exposes SMTP credentials - no code changes needed to switch.

const nodemailer = require("nodemailer");
const logger = require("../logger");
const { BRAND } = require("../config");
const i18n = require("../i18n");

// (P1 #6) User-controlled values must never reach an HTML email body
// unescaped. A display name of `<img src=x onerror=...>` or an injected
// link would otherwise render in the recipient's mail client - and unlike
// a web page, there's no CSP to fall back on. Applied to every
// interpolated value, not just the ones that look risky.
function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const SMTP_CONFIGURED = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);

function getTransport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 5000,
  });
}

async function sendWithRetry(mailOptions, attempts = 2) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      await getTransport().sendMail(mailOptions);
      return;
    } catch (e) {
      lastError = e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1000 * (i + 1))); // brief backoff before retrying once
    }
  }
  throw lastError;
}

async function sendVerificationEmail(to, name, code, locale = "en") {
  const subject = i18n.t(locale, "verifySubject");
  const text = i18n.t(locale, "verifyText", { name, code });
  const html = i18n.t(locale, "verifyHtml", { name, code, escape: escapeHtml });

  if (!SMTP_CONFIGURED) {
    // Local dev without email credentials: log instead of silently doing
    // nothing, so it's obvious a "real" send was skipped and why.
    // The body contains the verification code. That's the point in local
    // dev (there's no inbox to check), but it must not silently end up in
    // shipped/retained logs - so it goes to stdout directly as a
    // developer-facing line rather than through the structured logger,
    // and only when SMTP genuinely isn't configured.
    logger.info("email_dev_fallback", { to, subject });
    process.stdout.write(`\n[email:dev-fallback] would have sent to ${to}:\n${text}\n\n`);
    return { sent: false, reason: "smtp-not-configured" };
  }

  try {
    await sendWithRetry({
      from: process.env.SMTP_FROM || `"${BRAND}" <no-reply@uusiksi.example>`,
      to,
      subject,
      text,
      html,
    });
    return { sent: true };
  } catch (e) {
    // Don't let an email provider outage break signup entirely - log it
    // loudly (this needs a human to notice and fix the SMTP config/provider
    // issue). Critically, the caller must surface this to the user - in
    // production there's no devCode fallback, so a silently swallowed
    // failure here would leave someone with an account they can never
    // verify and no idea why.
    logger.error("email_send_failed", { to, err: e });
    return { sent: false, reason: "send-failed", error: e.message };
  }
}

// Generic notification email. Same SMTP path and retry behaviour as
// verification, but a failure here is far less critical - the notification
// is already stored and visible in-app, so email is an enhancement rather
// than the only way the user can find out.
async function sendNotificationEmail(to, subject, body) {
  if (!SMTP_CONFIGURED) {
    logger.info("notification_email_skipped", { to, subject, reason: "smtp-not-configured" });
    return { sent: false, reason: "smtp-not-configured" };
  }

  try {
    await sendWithRetry({
      from: process.env.SMTP_FROM || `"${BRAND}" <no-reply@uusiksi.example>`,
      to,
      subject,
      text: body,
    });
    return { sent: true };
  } catch (e) {
    logger.warn("notification_email_failed", { to, subject, err: e });
    return { sent: false, reason: "send-failed" };
  }
}

module.exports = { sendVerificationEmail, sendNotificationEmail, escapeHtml, usingRealEmail: SMTP_CONFIGURED };
