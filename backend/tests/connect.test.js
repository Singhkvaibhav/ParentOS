const request = require("supertest");
require("../tests/setupEnv");

const mockAccountsCreate = jest.fn().mockResolvedValue({ id: "acct_test_123" });
const mockAccountsRetrieve = jest.fn().mockResolvedValue({ id: "acct_test_123", charges_enabled: true, payouts_enabled: false });
const mockAccountLinksCreate = jest.fn().mockResolvedValue({ url: "https://connect.stripe.com/fake-onboarding-link" });

jest.mock("stripe", () => {
  return jest.fn().mockImplementation(() => ({
    paymentIntents: { create: jest.fn() },
    refunds: { create: jest.fn() },
    webhooks: { constructEvent: jest.fn() },
    accounts: { create: mockAccountsCreate, retrieve: mockAccountsRetrieve },
    accountLinks: { create: mockAccountLinksCreate },
  }));
});

const app = require("../server");
const { query } = require("../db");
const { resetDb } = require("./dbReset");
const { createVerifiedUser, csrfAgent } = require("./helpers");

beforeAll(async () => {
  await app.dbReady;
  await resetDb();
});

describe("connect (seller payouts)", () => {
  test("requires auth", async () => {
    expect((await (await csrfAgent(app)).post("/api/v1/connect/onboard")).status).toBe(401);
    expect((await request(app).get("/api/v1/connect/status")).status).toBe(401);
  });

  test("status defaults to not connected for a new user", async () => {
    const { agent } = await createVerifiedUser(app, { email: "connectnew@example.com" });
    const res = await agent.get("/api/v1/connect/status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ connected: false, chargesEnabled: false, payoutsEnabled: false });
  });

  test("onboard creates a Stripe Express account (once) and returns a hosted onboarding URL", async () => {
    const { agent, user } = await createVerifiedUser(app, { email: "connectonboard@example.com" });

    const res = await agent.post("/api/v1/connect/onboard");
    expect(res.status).toBe(200);
    expect(res.body.onboardingUrl).toBe("https://connect.stripe.com/fake-onboarding-link");
    expect(mockAccountsCreate).toHaveBeenCalledWith(expect.objectContaining({ type: "express", email: user.email }));

    const { rows } = await query("SELECT stripe_connect_account_id FROM users WHERE id = $1", [user.id]);
    expect(rows[0].stripe_connect_account_id).toBe("acct_test_123");

    // Onboarding again for the same user must NOT create a second Stripe
    // account - it should reuse the one already on file.
    mockAccountsCreate.mockClear();
    await agent.post("/api/v1/connect/onboard");
    expect(mockAccountsCreate).not.toHaveBeenCalled();
  });

  test("status reflects and caches Stripe's account state once connected", async () => {
    const { agent } = await createVerifiedUser(app, { email: "connectstatus@example.com" });
    await agent.post("/api/v1/connect/onboard");

    const res = await agent.get("/api/v1/connect/status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ connected: true, chargesEnabled: true, payoutsEnabled: false });
  });
});
