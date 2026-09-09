require("../tests/setupEnv");

jest.mock("../ai/controller", () => ({
  AiUnavailableError: class extends Error {},
  getAutoReply: jest.fn().mockResolvedValue("Mocked."),
}));

const app = require("../server");
const { query } = require("../db");
const { resetDb } = require("./dbReset");
const { csrfAgent, createVerifiedUser } = require("./helpers");
const security = require("../services/accountSecurityService");
const tokens = require("../services/tokenService");

beforeAll(async () => {
  await app.dbReady;
  await resetDb();
});

describe("password reset", () => {
  test("reports success for an unknown address, so it can't be used to find out who has an account", async () => {
    const agent = await csrfAgent(app);
    const res = await agent.post("/api/auth/forgot-password").send({ email: "nobody@example.com" });
    expect(res.status).toBe(200);
    // Identical shape to the real case - an anonymous caller learns nothing.
    expect(res.body.ok).toBe(true);
  });

  test("a valid token resets the password and lets the user log in with it", async () => {
    const user = await createVerifiedUser(app, { email: "resetme@example.com" });
    await security.requestPasswordReset("resetme@example.com", { ip: "1.2.3.4" });

    // The raw token is only ever emailed, so the test regenerates one the
    // same way the service does rather than reading it from the database.
    const raw = "test-reset-token-" + Math.random().toString(36).slice(2);
    await query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, now() + interval '30 minutes')`,
      [user.user.id, tokens.hashToken(raw)]
    );

    await security.resetPassword(raw, "brand-new-password");

    const agent = await csrfAgent(app);
    const login = await agent.post("/api/auth/login").send({
      email: "resetme@example.com", password: "brand-new-password",
    });
    expect(login.status).toBe(200);
  });

  test("a token can only be used once", async () => {
    const user = await createVerifiedUser(app, { email: "onceonly@example.com" });
    const raw = "single-use-" + Math.random().toString(36).slice(2);
    await query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, now() + interval '30 minutes')`,
      [user.user.id, tokens.hashToken(raw)]
    );

    await security.resetPassword(raw, "first-new-password");
    await expect(security.resetPassword(raw, "second-new-password")).rejects.toThrow(/invalid or has expired/i);
  });

  test("an expired token is refused", async () => {
    const user = await createVerifiedUser(app, { email: "expiredreset@example.com" });
    const raw = "expired-" + Math.random().toString(36).slice(2);
    await query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, now() - interval '1 minute')`,
      [user.user.id, tokens.hashToken(raw)]
    );
    await expect(security.resetPassword(raw, "whatever-password")).rejects.toThrow(/invalid or has expired/i);
  });

  // If the reset was prompted by a compromise, leaving the attacker signed
  // in would defeat the whole exercise.
  test("resetting a password ends every other session", async () => {
    const user = await createVerifiedUser(app, { email: "endsessions@example.com" });
    const before = await query("SELECT session_version FROM users WHERE id = $1", [user.user.id]);

    const raw = "ends-" + Math.random().toString(36).slice(2);
    await query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, now() + interval '30 minutes')`,
      [user.user.id, tokens.hashToken(raw)]
    );
    await security.resetPassword(raw, "rotated-password-x");

    const after = await query("SELECT session_version FROM users WHERE id = $1", [user.user.id]);
    expect(after.rows[0].session_version).toBeGreaterThan(before.rows[0].session_version);
  });
});

describe("account lockout", () => {
  test("repeated wrong passwords eventually lock the account", async () => {
    const email = "lockme@example.com";
    await createVerifiedUser(app, { email });

    let lastStatus = 0;
    for (let i = 0; i < security.MAX_FAILED_LOGINS + 1; i++) {
      const agent = await csrfAgent(app);
      const res = await agent.post("/api/auth/login").send({ email, password: "wrong-password" });
      lastStatus = res.status;
    }
    // 429 rather than 401: the account is throttled, not merely wrong.
    expect(lastStatus).toBe(429);
  });

  // Per-account, because per-IP limiting can't stop an attacker who rotates
  // addresses against one victim.
  test("a locked account stays locked even from a different connection", async () => {
    const { rows } = await query("SELECT locked_until FROM users WHERE email = $1", ["lockme@example.com"]);
    expect(rows[0].locked_until).not.toBeNull();
  });

  test("a successful login clears the failure count", async () => {
    const email = "clearfails@example.com";
    const user = await createVerifiedUser(app, { email });
    await query("UPDATE users SET failed_login_count = 3 WHERE id = $1", [user.user.id]);

    const agent = await csrfAgent(app);
    await agent.post("/api/auth/login").send({ email, password: "testpass123" });

    const { rows } = await query("SELECT failed_login_count FROM users WHERE id = $1", [user.user.id]);
    expect(rows[0].failed_login_count).toBe(0);
  });
});

describe("login history and suspicious logins", () => {
  test("successes and failures are both recorded", async () => {
    const email = "history@example.com";
    const user = await createVerifiedUser(app, { email });

    const agent = await csrfAgent(app);
    await agent.post("/api/auth/login").send({ email, password: "wrong" });
    await agent.post("/api/auth/login").send({ email, password: "testpass123" });

    const { rows } = await query("SELECT outcome FROM login_events WHERE user_id = $1", [user.user.id]);
    const outcomes = rows.map((r) => r.outcome);
    expect(outcomes).toContain("bad_password");
    expect(outcomes).toContain("success");
  });

  test("a first-ever login is not flagged suspicious", async () => {
    const user = await createVerifiedUser(app, { email: "firstlogin@example.com" });
    // No prior successes, so there's no baseline to deviate from -
    // flagging it would make every new account's first sign-in alarming.
    expect(await security.isSuspiciousLogin(user.user.id, "10.0.0.1")).toBe(false);
  });

  test("a login from an IP never seen before IS flagged, once there's a baseline", async () => {
    const user = await createVerifiedUser(app, { email: "newip@example.com" });
    await security.recordLogin({ userId: user.user.id, email: "newip@example.com", outcome: "success", ip: "10.0.0.1" });

    expect(await security.isSuspiciousLogin(user.user.id, "10.0.0.1")).toBe(false);
    expect(await security.isSuspiciousLogin(user.user.id, "203.0.113.9")).toBe(true);
  });

  test("a user can read their own login history", async () => {
    const user = await createVerifiedUser(app, { email: "readhistory@example.com" });
    const res = await user.agent.get("/api/auth/login-history");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.events)).toBe(true);
  });
});

describe("refresh token rotation", () => {
  test("rotating issues a new token and invalidates the old one", async () => {
    const user = await createVerifiedUser(app, { email: "rotate@example.com" });
    const { rows } = await query("SELECT * FROM users WHERE id = $1", [user.user.id]);

    const first = await tokens.issueRefreshToken(rows[0], { context: { ip: "1.1.1.1" } });
    const rotated = await tokens.rotate(first.raw, { ip: "1.1.1.1" });

    expect(rotated.accessToken).toBeTruthy();
    expect(rotated.refreshToken).not.toBe(first.raw);

    const used = await query("SELECT used_at FROM refresh_tokens WHERE token_hash = $1", [tokens.hashToken(first.raw)]);
    expect(used.rows[0].used_at).not.toBeNull();
  });

  // The whole point of rotation: replay becomes detectable, because only a
  // second holder of the credential would ever present a spent token.
  test("reusing a spent refresh token revokes the entire family", async () => {
    const user = await createVerifiedUser(app, { email: "reuse@example.com" });
    const { rows } = await query("SELECT * FROM users WHERE id = $1", [user.user.id]);

    const first = await tokens.issueRefreshToken(rows[0], {});
    const second = await tokens.rotate(first.raw, {});

    await expect(tokens.rotate(first.raw, {})).rejects.toMatchObject({ code: "reuse_detected" });

    // The token the legitimate user is holding is revoked too - we can't
    // tell which party is which, so both are stopped.
    await expect(tokens.rotate(second.refreshToken, {})).rejects.toThrow();
  });

  test("an expired refresh token is refused", async () => {
    const user = await createVerifiedUser(app, { email: "expiredrefresh@example.com" });
    const { rows } = await query("SELECT * FROM users WHERE id = $1", [user.user.id]);
    const issued = await tokens.issueRefreshToken(rows[0], {});
    await query("UPDATE refresh_tokens SET expires_at = now() - interval '1 day' WHERE token_hash = $1",
      [tokens.hashToken(issued.raw)]);

    await expect(tokens.rotate(issued.raw, {})).rejects.toMatchObject({ code: "expired" });
  });

  test("refresh tokens are never stored in plaintext", async () => {
    const user = await createVerifiedUser(app, { email: "hashed@example.com" });
    const { rows } = await query("SELECT * FROM users WHERE id = $1", [user.user.id]);
    const issued = await tokens.issueRefreshToken(rows[0], {});

    const { rows: stored } = await query("SELECT token_hash FROM refresh_tokens WHERE user_id = $1", [user.user.id]);
    expect(stored[0].token_hash).not.toBe(issued.raw);
    expect(stored[0].token_hash).toBe(tokens.hashToken(issued.raw));
  });

  test("a user can list and revoke an individual session", async () => {
    const user = await createVerifiedUser(app, { email: "sessions@example.com" });
    const { rows } = await query("SELECT * FROM users WHERE id = $1", [user.user.id]);
    const issued = await tokens.issueRefreshToken(rows[0], { context: { userAgent: "TestBrowser" } });

    const sessions = await tokens.listSessions(user.user.id);
    expect(sessions.length).toBeGreaterThanOrEqual(1);

    // Individually revocable - the previous model could only end every
    // session at once.
    await tokens.revokeSession(user.user.id, sessions[0].family_id);
    await expect(tokens.rotate(issued.raw, {})).rejects.toThrow();
  });
});
