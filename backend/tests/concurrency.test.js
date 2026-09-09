const request = require("supertest");
require("../tests/setupEnv");

// AI generation is controllable per-test here so the seller-reply race
// (#5) can be tested deterministically: the test decides exactly when
// generation finishes relative to the seller's reply.
//
// The controllable state lives INSIDE the mock factory (exposed via
// __setBehavior) because jest.mock factories are hoisted above the file's
// own variables and can't close over them.
jest.mock("../ai/controller", () => {
  class AiUnavailableError extends Error {}
  let behavior = { mode: "instant", text: "Mocked auto-reply for tests." };
  return {
    AiUnavailableError,
    __setBehavior: (next) => { behavior = next; },
    getAutoReply: jest.fn(async () => {
      if (behavior.mode === "fail") throw new AiUnavailableError("simulated failure");
      if (behavior.mode === "slow") await new Promise((r) => setTimeout(r, behavior.delayMs));
      return behavior.text;
    }),
  };
});

const mockPaymentIntentsCreate = jest.fn().mockImplementation(async ({ amount, metadata }) => ({
  id: `pi_test_${Math.random().toString(36).slice(2)}`,
  client_secret: "secret_test",
  amount,
  metadata,
}));
const mockRefundsCreate = jest.fn().mockResolvedValue({ id: "re_test" });
jest.mock("stripe", () => {
  return jest.fn().mockImplementation(() => ({
    paymentIntents: { create: mockPaymentIntentsCreate, cancel: jest.fn() },
    refunds: { create: mockRefundsCreate },
    webhooks: { constructEvent: jest.fn().mockImplementation((raw) => JSON.parse(raw.toString())) },
    accounts: { create: jest.fn(), retrieve: jest.fn() },
    accountLinks: { create: jest.fn() },
  }));
});

const app = require("../server");
const { query } = require("../db");
const { resetDb } = require("./dbReset");
const { createVerifiedUser, makeSellerPayoutReady } = require("./helpers");
const transactionsService = require("../services/transactionsService");
const { __setBehavior } = require("../ai/controller");

beforeAll(async () => {
  await app.dbReady;
  await resetDb();
});

beforeEach(() => {
  __setBehavior({ mode: "instant", text: "Mocked auto-reply for tests." });
});

async function createListing(sellerAgent, overrides = {}) {
  const res = await sellerAgent.post("/api/listings").send({
    category: "toys", title: "Concurrency toy", priceCents: 1000, condition: "Good", city: "Helsinki", area: "Kamppi", ...overrides,
  });
  // Checkout refuses to charge a buyer when the seller can't receive
  // payouts, so any listing meant to be buyable needs its seller
  // onboarded - same as reality.
  await makeSellerPayoutReady(res.body.listing.seller_id);
  return res.body.listing;
}

function sendWebhook(eventType, dataObject) {
  return request(app)
    .post("/api/transactions/webhook")
    .set("Content-Type", "application/json")
    .set("stripe-signature", "mocked")
    .send(JSON.stringify({ type: eventType, data: { object: dataObject } }));
}

async function waitFor(conditionFn, { timeout = 3000, interval = 40 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await conditionFn()) return true;
    await new Promise((r) => setTimeout(r, interval));
  }
  return false;
}

describe("state-transition atomicity", () => {
  // (#1) The webhook and the expiry sweep both mutate transaction +
  // listing state and can genuinely run at the same instant. Firing them
  // concurrently must produce ONE coherent outcome, never a half-applied
  // mix (e.g. transaction 'paid' but listing back to 'active').
  test("a payment webhook racing the expiry sweep leaves consistent state", async () => {
    const seller = await createVerifiedUser(app, { email: "raceseller@example.com" });
    const buyer = await createVerifiedUser(app, { email: "racebuyer@example.com" });
    const listing = await createListing(seller.agent);

    const checkoutRes = await buyer.agent.post("/api/transactions/checkout").send({ listingId: listing.id });
    const paymentIntentId = checkoutRes.body.transaction.stripe_payment_intent_id;

    // Backdate the reservation so the sweep considers it expired, making
    // both handlers genuinely eligible to act on the same row at once.
    await query("UPDATE listings SET reserved_at = now() - interval '1 hour' WHERE id = $1", [listing.id]);

    await Promise.all([
      sendWebhook("payment_intent.succeeded", { id: paymentIntentId }),
      transactionsService.releaseExpiredReservations(),
    ]);

    const { rows: txRows } = await query("SELECT status FROM transactions WHERE stripe_payment_intent_id = $1", [paymentIntentId]);
    const { rows: listingRows } = await query("SELECT status, reserved_at FROM listings WHERE id = $1", [listing.id]);
    const txStatus = txRows[0].status;
    const listingStatus = listingRows[0].status;

    // Either the payment won (paid + sold) or the sweep won (expired +
    // active, with the late payment refunded). Both are coherent; a mix
    // like paid+active or expired+sold is the corruption being guarded
    // against.
    const coherent =
      (txStatus === "paid" && listingStatus === "sold") ||
      (["expired", "refunded"].includes(txStatus) && listingStatus === "active");
    expect(coherent).toBe(true);

    // The reserved_at invariant must hold either way (enforced by a CHECK
    // constraint, but assert it explicitly so a failure names this cause).
    expect(listingRows[0].reserved_at).toBeNull();
  });

  // (#4) The unique index makes a duplicate PaymentIntent row impossible
  // at the storage layer, not just unlikely in application code.
  test("two transactions can't share a Stripe PaymentIntent id", async () => {
    const seller = await createVerifiedUser(app, { email: "dupeseller@example.com" });
    const buyer = await createVerifiedUser(app, { email: "dupebuyer@example.com" });
    const listing = await createListing(seller.agent);
    const checkoutRes = await buyer.agent.post("/api/transactions/checkout").send({ listingId: listing.id });
    const t = checkoutRes.body.transaction;

    await expect(
      query(
        `INSERT INTO transactions (listing_id, buyer_id, seller_id, item_amount_cents, delivery_method, delivery_fee_cents, commission_amount_cents, total_amount_cents, status, stripe_payment_intent_id)
         VALUES ($1, $2, $3, 100, 'pickup', 0, 8, 100, 'paid', $4)`,
        [listing.id, buyer.user.id, seller.user.id, t.stripe_payment_intent_id]
      )
    ).rejects.toThrow();
  });

  // (#3) At most one live checkout per listing, enforced by a partial
  // unique index rather than only by the atomic claim in application code.
  test("a listing can't have two pending transactions", async () => {
    const seller = await createVerifiedUser(app, { email: "twopendingseller@example.com" });
    const buyer = await createVerifiedUser(app, { email: "twopendingbuyer@example.com" });
    const listing = await createListing(seller.agent);
    await buyer.agent.post("/api/transactions/checkout").send({ listingId: listing.id });

    await expect(
      query(
        `INSERT INTO transactions (listing_id, buyer_id, seller_id, item_amount_cents, delivery_method, delivery_fee_cents, commission_amount_cents, total_amount_cents, status, stripe_payment_intent_id)
         VALUES ($1, $2, $3, 100, 'pickup', 0, 8, 100, 'pending', 'pi_some_other_id')`,
        [listing.id, buyer.user.id, seller.user.id]
      )
    ).rejects.toThrow();
  });
});

describe("conversation + AI concurrency", () => {
  // (#2) Two messages arriving simultaneously on a listing with no
  // existing conversation must not both try to INSERT one.
  test("concurrent first messages create exactly one conversation", async () => {
    const seller = await createVerifiedUser(app, { email: "convoraceseller@example.com" });
    const buyer = await createVerifiedUser(app, { email: "convoracebuyer@example.com" });
    const listing = await createListing(seller.agent);

    const [r1, r2] = await Promise.all([
      buyer.agent.post("/api/messages/thread").send({ listingId: listing.id, text: "first" }),
      buyer.agent.post("/api/messages/thread").send({ listingId: listing.id, text: "second" }),
    ]);
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);

    const { rows } = await query(
      "SELECT COUNT(*) AS n FROM conversations WHERE listing_id = $1 AND buyer_id = $2",
      [listing.id, buyer.user.id]
    );
    expect(Number(rows[0].n)).toBe(1);
  });

  // (#5) If the seller answers while the AI is still generating, the AI's
  // stand-in reply must be discarded rather than landing after the real
  // answer and contradicting it.
  test("an AI reply generated while the seller replies is discarded", async () => {
    __setBehavior({ mode: "slow", delayMs: 600, text: "AI stand-in answer" });

    const seller = await createVerifiedUser(app, { email: "aiafterseller@example.com" });
    const buyer = await createVerifiedUser(app, { email: "aiafterbuyer@example.com" });
    const listing = await createListing(seller.agent);

    const sendRes = await buyer.agent.post("/api/messages/thread").send({ listingId: listing.id, text: "question?" });
    const conversationId = sendRes.body.conversation.id;

    // Seller answers well before the 600ms AI generation finishes.
    await seller.agent.post(`/api/messages/conversations/${conversationId}/reply`).send({ text: "real seller answer" });

    // Give the in-flight AI generation time to finish and attempt its insert.
    await new Promise((r) => setTimeout(r, 900));

    const { rows } = await query(
      "SELECT COUNT(*) AS n FROM messages WHERE conversation_id = $1 AND sender_type = 'ai'",
      [conversationId]
    );
    expect(Number(rows[0].n)).toBe(0);
  });

  // (#6) A failed generation must release the claim, so the feature isn't
  // permanently disabled for that conversation by one transient blip.
  test("a failed AI generation releases its claim so a later message can retry", async () => {
    __setBehavior({ mode: "fail" });

    const seller = await createVerifiedUser(app, { email: "airetryseller@example.com" });
    const buyer = await createVerifiedUser(app, { email: "airetrybuyer@example.com" });
    const listing = await createListing(seller.agent);

    const sendRes = await buyer.agent.post("/api/messages/thread").send({ listingId: listing.id, text: "first try" });
    const conversationId = sendRes.body.conversation.id;

    const claimReleased = await waitFor(async () => {
      const { rows } = await query("SELECT ai_replied FROM conversations WHERE id = $1", [conversationId]);
      return rows[0].ai_replied === false;
    });
    expect(claimReleased).toBe(true);

    // Now the AI works again - a subsequent message should get a reply,
    // which would be impossible if the failed attempt had left the claim set.
    __setBehavior({ mode: "instant", text: "recovered reply" });
    await buyer.agent.post(`/api/messages/conversations/${conversationId}/reply`).send({ text: "second try" });

    const gotReply = await waitFor(async () => {
      const { rows } = await query(
        "SELECT COUNT(*) AS n FROM messages WHERE conversation_id = $1 AND sender_type = 'ai'",
        [conversationId]
      );
      return Number(rows[0].n) >= 1;
    });
    expect(gotReply).toBe(true);
  });
});
