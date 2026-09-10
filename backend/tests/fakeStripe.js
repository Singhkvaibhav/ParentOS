// A minimal fake of the Stripe API, for end-to-end testing without network
// access to Stripe.
//
// The point is that the REAL Stripe SDK talks to this. It builds the
// requests, applies its pinned API version, sets headers, form-encodes
// bodies, honours idempotency keys and parses responses - all of which a
// Jest module mock skips entirely. Wiring bugs (wrong field names, a
// response shape the SDK can't parse, a missing parameter) show up here and
// are invisible to a mock.
//
// It is NOT a Stripe simulator. It implements only the endpoints this
// application calls, and it is not a substitute for running against real
// Stripe test keys - which remains the only way to catch a wrong API
// version, bad key permissions, or a mismatched webhook secret.
const http = require("http");
const crypto = require("crypto");

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString("hex")}`;
}

function parseForm(body) {
  // Stripe's SDK sends application/x-www-form-urlencoded with bracketed
  // keys (metadata[listingId]). Only the flat values are needed here.
  const out = {};
  for (const [k, v] of new URLSearchParams(body)) out[k] = v;
  return out;
}

function createFakeStripe() {
  const paymentIntents = new Map();
  const refunds = new Map();
  // Keyed by Idempotency-Key header, so a replayed request returns the
  // original object exactly as Stripe would - which is what makes the
  // retry-safety tests meaningful rather than assumed.
  const idempotency = new Map();
  const calls = [];

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const form = parseForm(body);
      const key = req.headers["idempotency-key"];
      calls.push({ method: req.method, path: req.url, idempotencyKey: key });

      const send = (status, payload) => {
        const json = JSON.stringify(payload);
        res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(json) });
        res.end(json);
      };

      // Replay protection, mirroring Stripe's own behaviour.
      if (key && idempotency.has(key)) return send(200, idempotency.get(key));

      const remember = (payload) => {
        if (key) idempotency.set(key, payload);
        return payload;
      };

      // --- PaymentIntents ---
      if (req.method === "POST" && req.url === "/v1/payment_intents") {
        const pi = {
          id: id("pi"),
          object: "payment_intent",
          status: "requires_payment_method",
          amount: Number(form.amount),
          currency: form.currency || "eur",
          client_secret: `${id("pi")}_secret_${crypto.randomBytes(6).toString("hex")}`,
          amount_refunded: 0,
        };
        paymentIntents.set(pi.id, pi);
        return send(200, remember(pi));
      }

      const piMatch = /^\/v1\/payment_intents\/([^/?]+)(\/cancel)?/.exec(req.url);
      if (piMatch) {
        const pi = paymentIntents.get(piMatch[1]);
        if (!pi) {
          return send(404, {
            error: { type: "invalid_request_error", code: "resource_missing", message: "No such payment_intent" },
          });
        }
        if (piMatch[2] === "/cancel") {
          pi.status = "canceled";
          return send(200, remember(pi));
        }
        return send(200, pi);
      }

      if (req.method === "GET" && req.url.startsWith("/v1/payment_intents")) {
        return send(200, { object: "list", data: [...paymentIntents.values()] });
      }

      // --- Refunds ---
      if (req.method === "POST" && req.url === "/v1/refunds") {
        const pi = paymentIntents.get(form.payment_intent);
        const refund = {
          id: id("re"), object: "refund",
          payment_intent: form.payment_intent,
          amount: pi ? pi.amount : 0,
          status: "succeeded",
        };
        if (pi) pi.amount_refunded = pi.amount;
        refunds.set(refund.id, refund);
        return send(200, remember(refund));
      }

      // --- Connect ---
      if (req.method === "POST" && req.url === "/v1/accounts") {
        return send(200, remember({ id: id("acct"), object: "account", charges_enabled: false, payouts_enabled: false }));
      }
      if (req.method === "GET" && req.url.startsWith("/v1/accounts/")) {
        return send(200, { id: req.url.split("/")[3], object: "account", charges_enabled: true, payouts_enabled: true });
      }
      if (req.method === "POST" && req.url === "/v1/account_links") {
        return send(200, remember({ object: "account_link", url: "https://connect.stripe.test/onboard" }));
      }

      send(404, { error: { type: "invalid_request_error", message: `fake stripe: unhandled ${req.method} ${req.url}` } });
    });
  });

  return {
    server,
    listen: () => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port))),
    close: () => new Promise((resolve) => server.close(resolve)),
    // Marks a PaymentIntent paid, as confirming a card would.
    succeed: (paymentIntentId) => {
      const pi = paymentIntents.get(paymentIntentId);
      if (pi) pi.status = "succeeded";
      return pi;
    },
    paymentIntents,
    calls,
  };
}

module.exports = { createFakeStripe };
