// Translated copy for account-security emails (verification, password
// reset, suspicious login). Deliberately narrow in scope: API error/
// validation messages stay English on the wire (see frontend/src/i18n/
// errorMessages.js, which translates the known ones for display) rather
// than threading a locale through every service and its tests for a
// wording change - emails are the one place where a user has no other
// chance to see the message in their own language.
const { BRAND } = require("./config");

const SUPPORTED_LOCALES = new Set(["en", "fi"]);

function normalizeLocale(locale) {
  return SUPPORTED_LOCALES.has(locale) ? locale : "en";
}

const STRINGS = {
  en: {
    verifySubject: () => `Verify your ${BRAND} account`,
    verifyText: ({ name, code }) =>
      `Hi ${name},\n\nYour verification code is: ${code}\n\nThis code expires in 15 minutes.\n\n- ${BRAND}`,
    verifyHtml: ({ name, code, escape }) =>
      `<p>Hi ${escape(name)},</p><p>Your verification code is:</p><h2 style="letter-spacing:0.2em">${escape(code)}</h2><p>This code expires in 15 minutes.</p>`,
    resetSubject: () => `Reset your ${BRAND} password`,
    resetText: ({ name, link, ttlMinutes }) =>
      `Hi ${name},\n\nSomeone asked to reset your password. This link works once and expires in ${ttlMinutes} minutes:\n\n${link}\n\nIf this wasn't you, you can ignore this email - your password hasn't changed.\n\n- ${BRAND}`,
    passwordChangedSubject: () => `Your ${BRAND} password was changed`,
    passwordChangedText: ({ name }) =>
      `Hi ${name},\n\nYour password was just changed and all other devices were signed out.\n\nIf this wasn't you, reset your password immediately and contact us.\n\n- ${BRAND}`,
    suspiciousLoginSubject: () => `New sign-in to your ${BRAND} account`,
    suspiciousLoginText: ({ name, ip, userAgent }) =>
      `Hi ${name},\n\nYour account was just signed in to from a device or location we haven't seen before.\n\nIP: ${ip || "unknown"}\nDevice: ${userAgent || "unknown"}\n\nIf this was you, nothing to do. If not, reset your password and sign out all devices from your profile.\n\n- ${BRAND}`,
  },
  fi: {
    verifySubject: () => `Vahvista ${BRAND}-tilisi`,
    verifyText: ({ name, code }) =>
      `Hei ${name},\n\nVahvistuskoodisi on: ${code}\n\nKoodi vanhenee 15 minuutissa.\n\n- ${BRAND}`,
    verifyHtml: ({ name, code, escape }) =>
      `<p>Hei ${escape(name)},</p><p>Vahvistuskoodisi on:</p><h2 style="letter-spacing:0.2em">${escape(code)}</h2><p>Koodi vanhenee 15 minuutissa.</p>`,
    resetSubject: () => `Vaihda ${BRAND}-salasanasi`,
    resetText: ({ name, link, ttlMinutes }) =>
      `Hei ${name},\n\nJoku pyysi salasanasi vaihtamista. Tämä linkki toimii kerran ja vanhenee ${ttlMinutes} minuutissa:\n\n${link}\n\nJos tämä et ollut sinä, voit jättää tämän viestin huomiotta - salasanaasi ei ole muutettu.\n\n- ${BRAND}`,
    passwordChangedSubject: () => `${BRAND}-salasanasi vaihdettiin`,
    passwordChangedText: ({ name }) =>
      `Hei ${name},\n\nSalasanasi vaihdettiin juuri ja kaikki muut laitteet kirjattiin ulos.\n\nJos tämä et ollut sinä, vaihda salasanasi välittömästi ja ota meihin yhteyttä.\n\n- ${BRAND}`,
    suspiciousLoginSubject: () => `Uusi kirjautuminen ${BRAND}-tilillesi`,
    suspiciousLoginText: ({ name, ip, userAgent }) =>
      `Hei ${name},\n\nTilillesi kirjauduttiin juuri laitteelta tai sijainnista, jota emme ole nähneet aiemmin.\n\nIP: ${ip || "tuntematon"}\nLaite: ${userAgent || "tuntematon"}\n\nJos tämä olit sinä, ei toimenpiteitä tarvita. Jos et, vaihda salasanasi ja kirjaudu ulos kaikilta laitteilta profiilistasi.\n\n- ${BRAND}`,
  },
};

// Returns the translated string for `key` (one of the functions above),
// called with `vars` plus the shared `escape` helper. Falls back to
// English for an unsupported locale rather than throwing - a bad/legacy
// locale value must never block an email that carries a verification code
// or a password-reset link.
function t(locale, key, vars = {}) {
  const table = STRINGS[normalizeLocale(locale)];
  return table[key](vars);
}

module.exports = { t, normalizeLocale, SUPPORTED_LOCALES };
