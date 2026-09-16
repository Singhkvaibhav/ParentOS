const request = require("supertest");
require("../tests/setupEnv"); // safety net if run outside the configured jest setupFiles
const app = require("../server");
const { resetDb } = require("./dbReset");
const { createVerifiedUser, csrfAgent } = require("./helpers");

let plain; // unauthenticated, but CSRF-aware - like a fresh browser

beforeAll(async () => {
  await app.dbReady;
  await resetDb();
  plain = await csrfAgent(app);
});

describe("auth", () => {
  test("signup requires name, email, and a 6+ char password", async () => {
    const res = await plain.post("/api/auth/signup").send({ name: "", email: "", password: "short" });
    expect(res.status).toBe(400);
  });

  test("signup then verify with the dev code sets an httpOnly session cookie", async () => {
    const productAnalytics = require("../services/productAnalyticsService");
    const captureSpy = jest.spyOn(productAnalytics, "capture");

    const { agent, user } = await createVerifiedUser(app, { email: "verifyflow@example.com" });
    expect(user.email).toBe("verifyflow@example.com");
    expect(user.id).toBeDefined();
    // The cookie itself is httpOnly - the real assertion is that the agent
    // (which behaves like a browser, sending cookies automatically) can now
    // reach a protected route without any explicit token/header.
    const me = await agent.get("/api/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.user.id).toBe(user.id);

    // Verification succeeding, not the signup form being submitted, is the
    // authoritative "signed up" funnel event - see productAnalyticsService.js.
    expect(captureSpy).toHaveBeenCalledWith(user.id, "user_signed_up");
    captureSpy.mockRestore();
  });

  test("verify locks out after 5 wrong attempts", async () => {
    const email = "lockout@example.com";
    await plain.post("/api/auth/signup").send({ name: "Lockout", email, password: "testpass123" });
    let last;
    for (let i = 0; i < 5; i++) {
      last = await plain.post("/api/auth/verify").send({ email, code: "000000" });
    }
    expect(last.status).toBe(400);
    const sixth = await plain.post("/api/auth/verify").send({ email, code: "000000" });
    expect(sixth.status).toBe(429);
    expect(sixth.body.locked).toBe(true);
  });

  test("resend-code issues a fresh code that works after a lockout", async () => {
    const email = "resend@example.com";
    await plain.post("/api/auth/signup").send({ name: "Resend", email, password: "testpass123" });
    for (let i = 0; i < 5; i++) {
      await plain.post("/api/auth/verify").send({ email, code: "000000" });
    }
    const resendRes = await plain.post("/api/auth/resend-code").send({ email });
    expect(resendRes.status).toBe(200);
    const newCode = resendRes.body.devCode;
    const verifyRes = await plain.post("/api/auth/verify").send({ email, code: newCode });
    expect(verifyRes.status).toBe(200);
  });

  test("login returns the identical generic error for a nonexistent email and a wrong password (no enumeration)", async () => {
    const { email } = await createVerifiedUser(app, { email: "enumtest@example.com" });

    const wrongPassword = await plain.post("/api/auth/login").send({ email, password: "definitely-wrong" });
    const noSuchAccount = await plain.post("/api/auth/login").send({ email: "nobody-here@example.com", password: "whatever" });

    expect(wrongPassword.status).toBe(401);
    expect(noSuchAccount.status).toBe(401);
    expect(wrongPassword.body.error).toBe(noSuchAccount.body.error);
  });

  test("login sets a cookie and never returns the token in the response body", async () => {
    const { email, password, user } = await createVerifiedUser(app, { email: "loginok@example.com" });
    const loginRes = await plain.post("/api/auth/login").send({ email, password });
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.token).toBeUndefined(); // must never be in the JSON body - only the httpOnly cookie
    expect(loginRes.headers["set-cookie"]?.[0]).toMatch(/HttpOnly/i);

    const profileRes = await request(app).get(`/api/users/${user.id}`);
    expect(profileRes.status).toBe(200);
    expect(profileRes.body.user.email).toBeUndefined();
  });

  test("GET /api/auth/me requires a session", async () => {
    const res = await request(app).get("/api/auth/me");
    expect(res.status).toBe(401);
  });

  test("GET /api/auth/me returns the current user for a valid session", async () => {
    const { agent, user } = await createVerifiedUser(app, { email: "meendpoint@example.com" });
    const res = await agent.get("/api/auth/me");
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(user.id);
  });

  test("logout clears the session - the same agent is then rejected from a protected route", async () => {
    const { agent } = await createVerifiedUser(app, { email: "logouttest@example.com" });
    expect((await agent.get("/api/auth/me")).status).toBe(200);

    const logoutRes = await agent.post("/api/auth/logout");
    expect(logoutRes.status).toBe(200);

    const afterLogout = await agent.get("/api/auth/me");
    expect(afterLogout.status).toBe(401);
  });
});
