const request = require("supertest");
require("../tests/setupEnv");
const app = require("../server");
const { query } = require("../db");
const { resetDb } = require("./dbReset");
const { createVerifiedUser, csrfAgent } = require("./helpers");
const { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } = require("../middleware/csrf");

beforeAll(async () => {
  await app.dbReady;
  await resetDb();
});

// P1 #9. The auth cookie is attached by the browser automatically, so
// without CSRF protection a third-party page could trigger authenticated
// state changes. SameSite=Lax helps but shouldn't be the only layer.
describe("CSRF protection", () => {
  test("a state-changing request with no CSRF token is rejected", async () => {
    const res = await request(app).post("/api/auth/login").send({ email: "x@example.com", password: "y" });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/csrf/i);
  });

  test("a state-changing request with a WRONG CSRF token is rejected", async () => {
    const agent = request.agent(app);
    await agent.get("/api/health"); // picks up the real cookie
    const res = await agent
      .post("/api/auth/login")
      .set(CSRF_HEADER_NAME, "not-the-right-token")
      .send({ email: "x@example.com", password: "y" });
    expect(res.status).toBe(403);
  });

  test("a matching cookie+header pair is accepted", async () => {
    const { email, password } = await createVerifiedUser(app, { email: "csrfok@example.com" });
    const agent = await csrfAgent(app);
    const res = await agent.post("/api/auth/login").send({ email, password });
    expect(res.status).toBe(200);
  });

  test("safe methods (GET) don't require a CSRF token", async () => {
    const res = await request(app).get("/api/listings");
    expect(res.status).toBe(200);
  });

  test("the CSRF cookie is readable by JS (not httpOnly) - that's the mechanism", async () => {
    const res = await request(app).get("/api/health");
    const csrfCookie = (res.headers["set-cookie"] || []).find((c) => c.startsWith(`${CSRF_COOKIE_NAME}=`));
    expect(csrfCookie).toBeDefined();
    expect(csrfCookie).not.toMatch(/HttpOnly/i);
  });

  test("the Stripe webhook is exempt - it's server-to-server, authenticated by signature", async () => {
    // No CSRF token supplied. It should get *past* CSRF and fail on
    // signature verification instead (400), not be blocked as 403.
    const res = await request(app)
      .post("/api/transactions/webhook")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ type: "payment_intent.succeeded", data: { object: { id: "pi_x" } } }));
    expect(res.status).not.toBe(403);
  });
});

// P1 #8. JWTs are stateless: without a version check, a token stays valid
// for its full 30-day life no matter what happens to the account.
describe("session revocation", () => {
  test("bumping session_version invalidates an existing session", async () => {
    const { agent, user } = await createVerifiedUser(app, { email: "revoke@example.com" });

    expect((await agent.get("/api/auth/me")).status).toBe(200);

    // Simulates any server-side revocation (password change, "log out
    // everywhere" from another device, admin action).
    await query("UPDATE users SET session_version = session_version + 1 WHERE id = $1", [user.id]);

    const after = await agent.get("/api/auth/me");
    expect(after.status).toBe(401);
  });

  test("logout-everywhere ends other sessions but keeps the current one working", async () => {
    const { email, password } = await createVerifiedUser(app, { email: "logouteverywhere@example.com" });

    // Two independent logins = two devices holding separate tokens.
    const deviceA = await csrfAgent(app);
    await deviceA.post("/api/auth/login").send({ email, password });
    const deviceB = await csrfAgent(app);
    await deviceB.post("/api/auth/login").send({ email, password });

    expect((await deviceA.get("/api/auth/me")).status).toBe(200);
    expect((await deviceB.get("/api/auth/me")).status).toBe(200);

    const res = await deviceA.post("/api/auth/logout-everywhere");
    expect(res.status).toBe(200);

    // Device A got a fresh token in the response and stays signed in;
    // device B's older token is now invalid.
    expect((await deviceA.get("/api/auth/me")).status).toBe(200);
    expect((await deviceB.get("/api/auth/me")).status).toBe(401);
  });

  test("logout-everywhere requires authentication", async () => {
    const agent = await csrfAgent(app);
    const res = await agent.post("/api/auth/logout-everywhere");
    expect(res.status).toBe(401);
  });
});
