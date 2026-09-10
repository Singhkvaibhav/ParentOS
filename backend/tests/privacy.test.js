require("../tests/setupEnv");

jest.mock("../ai/controller", () => ({
  AiUnavailableError: class extends Error {},
  getAutoReply: jest.fn().mockResolvedValue("Mocked."),
}));

const mockPaymentIntentsCreate = jest.fn().mockImplementation(async ({ amount, metadata }) => ({
  id: `pi_priv_${Math.random().toString(36).slice(2)}`, client_secret: "s", amount, metadata,
}));
jest.mock("stripe", () => jest.fn().mockImplementation(() => ({
  paymentIntents: { create: mockPaymentIntentsCreate, cancel: jest.fn() },
  refunds: { create: jest.fn() },
  webhooks: { constructEvent: jest.fn().mockImplementation((raw) => JSON.parse(raw.toString())) },
  accounts: { create: jest.fn(), retrieve: jest.fn() },
  accountLinks: { create: jest.fn() },
})));

const request = require("supertest");
const app = require("../server");
const { query } = require("../db");
const { resetDb } = require("./dbReset");
const { createVerifiedUser, makeSellerPayoutReady } = require("./helpers");

beforeAll(async () => {
  await app.dbReady;
  await resetDb();
});

async function listingFor(agent, overrides = {}) {
  const res = await agent.post("/api/listings").send({
    category: "toys", title: "Privacy toy", priceCents: 1200,
    condition: "Good", city: "Helsinki", area: "Kamppi", ...overrides,
  });
  await makeSellerPayoutReady(res.body.listing.seller_id);
  return res.body.listing;
}

async function completedSale(sellerAgent, buyerAgent, listingId) {
  const checkout = await buyerAgent.post("/api/transactions/checkout").send({ listingId });
  await request(app).post("/api/transactions/webhook")
    .set("Content-Type", "application/json").set("stripe-signature", "m")
    .send(JSON.stringify({
      type: "payment_intent.succeeded",
      data: { object: { id: checkout.body.transaction.stripe_payment_intent_id } },
    }));
  await buyerAgent.post(`/api/transactions/${checkout.body.transaction.id}/confirm-receipt`);
  return checkout.body.transaction.id;
}

// GDPR Article 15 / 20.
describe("data export", () => {
  test("requires authentication", async () => {
    expect((await request(app).get("/api/privacy/export")).status).toBe(401);
  });

  test("returns the user's data as a downloadable file", async () => {
    const user = await createVerifiedUser(app, { email: "exportme@example.com" });
    await listingFor(user.agent, { title: "Exportable item" });

    const res = await user.agent.get("/api/privacy/export");
    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toContain("attachment");

    const data = JSON.parse(res.text);
    expect(data.profile.email).toBe("exportme@example.com");
    expect(data.listings.some((l) => l.title === "Exportable item")).toBe(true);
    // The export should say what it deliberately leaves out, so an omission
    // isn't mistaken for a bug.
    expect(data.scope.excluded).toBeTruthy();
  });

  // Article 15 gives access to YOUR data. The other side of a conversation
  // is someone else's personal data - handing it over would satisfy one
  // request by breaching another person's privacy.
  test("excludes messages written by the other party", async () => {
    const seller = await createVerifiedUser(app, { email: "exportseller@example.com" });
    const buyer = await createVerifiedUser(app, { email: "exportbuyer@example.com" });
    const listing = await listingFor(seller.agent);

    const thread = await buyer.agent.post("/api/messages/thread").send({
      listingId: listing.id, text: "BUYER_SECRET_TEXT",
    });
    await seller.agent.post(`/api/messages/conversations/${thread.body.conversation.id}/reply`)
      .send({ text: "SELLER_SECRET_TEXT" });

    const buyerExport = JSON.parse((await buyer.agent.get("/api/privacy/export")).text);
    const texts = buyerExport.messagesYouSent.map((m) => m.text);
    expect(texts).toContain("BUYER_SECRET_TEXT");
    expect(texts).not.toContain("SELLER_SECRET_TEXT");
  });
});

// GDPR Article 17, with Article 17(3)(b) retention.
describe("account deletion", () => {
  test("refuses while an order is still in progress", async () => {
    const seller = await createVerifiedUser(app, { email: "blockedseller@example.com" });
    const buyer = await createVerifiedUser(app, { email: "blockedbuyer@example.com" });
    const listing = await listingFor(seller.agent);

    // Paid but not confirmed - deleting now would leave the buyer with no
    // counterparty and no recourse.
    const checkout = await buyer.agent.post("/api/transactions/checkout").send({ listingId: listing.id });
    await request(app).post("/api/transactions/webhook")
      .set("Content-Type", "application/json").set("stripe-signature", "m")
      .send(JSON.stringify({
        type: "payment_intent.succeeded",
        data: { object: { id: checkout.body.transaction.stripe_payment_intent_id } },
      }));

    const status = await seller.agent.get("/api/privacy/deletion-status");
    expect(status.body.blockers.length).toBeGreaterThan(0);

    const res = await seller.agent.post("/api/privacy/delete-account")
      .send({ confirmEmail: "blockedseller@example.com" });
    expect(res.status).toBe(409);
  });

  test("requires the user to type their own email", async () => {
    const user = await createVerifiedUser(app, { email: "confirmdel@example.com" });
    const res = await user.agent.post("/api/privacy/delete-account").send({ confirmEmail: "wrong@example.com" });
    expect(res.status).toBe(400);
  });

  test("anonymizes the user but keeps the transaction record", async () => {
    const seller = await createVerifiedUser(app, { email: "delseller@example.com" });
    const buyer = await createVerifiedUser(app, { email: "delbuyer@example.com" });
    const listing = await listingFor(seller.agent, { title: "Sold before deletion" });
    const transactionId = await completedSale(seller.agent, buyer.agent, listing.id);

    const res = await buyer.agent.post("/api/privacy/delete-account")
      .send({ confirmEmail: "delbuyer@example.com" });
    expect(res.status).toBe(200);

    // The financial record survives - statutory accounting retention.
    const tx = await query("SELECT id, buyer_id, total_amount_cents FROM transactions WHERE id = $1", [transactionId]);
    expect(tx.rows).toHaveLength(1);
    expect(tx.rows[0].total_amount_cents).toBeGreaterThan(0);

    // But it no longer points at a person.
    const user = await query("SELECT name, email, deleted_at, password_hash FROM users WHERE id = $1", [tx.rows[0].buyer_id]);
    expect(user.rows[0].name).toBe("Deleted user");
    expect(user.rows[0].email).toMatch(/@deleted\.invalid$/);
    expect(user.rows[0].deleted_at).not.toBeNull();
    expect(user.rows[0].password_hash).toBe("");
  });

  test("message content is erased but the thread stays coherent for the other party", async () => {
    const seller = await createVerifiedUser(app, { email: "msgdelseller@example.com" });
    const buyer = await createVerifiedUser(app, { email: "msgdelbuyer@example.com" });
    const listing = await listingFor(seller.agent);
    const thread = await buyer.agent.post("/api/messages/thread").send({
      listingId: listing.id, text: "PLEASE_ERASE_ME",
    });

    await buyer.agent.post("/api/privacy/delete-account").send({ confirmEmail: "msgdelbuyer@example.com" });

    const { rows } = await query(
      "SELECT text FROM messages WHERE conversation_id = $1 AND sender_id = $2",
      [thread.body.conversation.id, buyer.user.id]
    );
    expect(rows[0].text).toBe("[deleted]");
    // The row survives so the seller's thread isn't full of gaps.
    expect(rows).toHaveLength(1);
  });

  test("a deleted account can't log back in", async () => {
    const { csrfAgent } = require("./helpers");
    const user = await createVerifiedUser(app, { email: "nologin@example.com" });
    await user.agent.post("/api/privacy/delete-account").send({ confirmEmail: "nologin@example.com" });

    const agent = await csrfAgent(app);
    const res = await agent.post("/api/auth/login").send({ email: "nologin@example.com", password: "testpass123" });
    expect(res.status).toBe(401);
  });

  test("the released email address can be reused by a genuinely new signup", async () => {
    const { csrfAgent } = require("./helpers");
    const email = "reusable@example.com";
    const user = await createVerifiedUser(app, { email });
    await user.agent.post("/api/privacy/delete-account").send({ confirmEmail: email });

    // The old row keeps a rewritten address, so the UNIQUE constraint no
    // longer blocks the real address being registered again.
    const agent = await csrfAgent(app);
    const signup = await agent.post("/api/auth/signup").send({
      name: "New Person", email, password: "testpass123",
    });
    expect(signup.status).toBe(200);
  });

  test("reviews written by the deleted user survive - they're about someone else", async () => {
    const seller = await createVerifiedUser(app, { email: "revsurvseller@example.com" });
    const buyer = await createVerifiedUser(app, { email: "revsurvbuyer@example.com" });
    const listing = await listingFor(seller.agent);
    await completedSale(seller.agent, buyer.agent, listing.id);
    await buyer.agent.post("/api/reviews").send({
      revieweeId: seller.user.id, listingId: listing.id, rating: 5, comment: "Great",
    });

    await buyer.agent.post("/api/privacy/delete-account").send({ confirmEmail: "revsurvbuyer@example.com" });

    const { rows } = await query("SELECT rating FROM reviews WHERE reviewee_id = $1", [seller.user.id]);
    // The seller's rating is other users' information about them; erasing
    // it would let anyone delete unfavourable reviews by deleting their account.
    expect(rows).toHaveLength(1);
    expect(rows[0].rating).toBe(5);
  });
});

// This case was the gap: the existing deletion tests only ever deleted
// BUYERS, so nothing exercised a seller with a retained sold listing - and
// that path failed outright, because city/area/pincode are NOT NULL and
// the anonymization set area to NULL. Any seller who had sold anything
// could not delete their account at all.
describe("deleting a seller who has sold something", () => {
  test("succeeds, rather than aborting on a NOT NULL constraint", async () => {
    const seller = await createVerifiedUser(app, { email: "solddelete@example.com" });
    const buyer = await createVerifiedUser(app, { email: "solddeletebuyer@example.com" });
    const listing = await listingFor(seller.agent, { title: "Sold before deletion" });
    await completedSale(seller.agent, buyer.agent, listing.id);

    const res = await seller.agent.post("/api/privacy/delete-account")
      .send({ confirmEmail: "solddelete@example.com" });
    expect(res.status).toBe(200);
  });

  test("the retained listing keeps no location data", async () => {
    const seller = await createVerifiedUser(app, { email: "locdelete@example.com" });
    const buyer = await createVerifiedUser(app, { email: "locdeletebuyer@example.com" });
    const listing = await listingFor(seller.agent, { title: "Located item" });
    await completedSale(seller.agent, buyer.agent, listing.id);

    await seller.agent.post("/api/privacy/delete-account").send({ confirmEmail: "locdelete@example.com" });

    const { rows } = await query(
      "SELECT title, city, area, pincode, lat, lng, description, photo_url FROM listings WHERE id = $1",
      [listing.id]
    );
    // The row survives as the transaction's reference, but a deleted user's
    // neighbourhood and postcode must not survive with it.
    expect(rows).toHaveLength(1);
    expect(rows[0].city).toBe("[removed]");
    expect(rows[0].area).toBe("[removed]");
    expect(rows[0].pincode).toBe("[removed]");
    expect(rows[0].lat).toBeNull();
    expect(rows[0].lng).toBeNull();
    expect(rows[0].description).toBeNull();
    expect(rows[0].photo_url).toBeNull();
  });

  test("no listing anywhere retains location data for a deleted user", async () => {
    // The invariant, checked across everything this suite has deleted.
    const { rows } = await query(`
      SELECT l.id FROM listings l
      JOIN users u ON u.id = l.seller_id
      WHERE u.deleted_at IS NOT NULL
        AND (l.city <> '[removed]' OR l.area <> '[removed]' OR l.lat IS NOT NULL)
    `);
    expect(rows).toEqual([]);
  });
});
