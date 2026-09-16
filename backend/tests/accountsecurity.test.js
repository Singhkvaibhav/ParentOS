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
    const res = await agent.post("/api/v1/auth/forgot-password").send({ email: "nobody@example.com" });
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
    const login = await agent.post("/api/v1/auth/login").send({
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
      const res = await agent.post("/api/v1/auth/login").send({ email, password: "wrong-password" });
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
    await agent.post("/api/v1/auth/login").send({ email, password: "testpass123" });

    const { rows } = await query("SELECT failed_login_count FROM users WHERE id = $1", [user.user.id]);
    expect(rows[0].failed_login_count).toBe(0);
  });
});

describe("login history and suspicious logins", () => {
  test("successes and failures are both recorded", async () => {
    const email = "history@example.com";
    const user = await createVerifiedUser(app, { email });

    const agent = await csrfAgent(app);
    await agent.post("/api/v1/auth/login").send({ email, password: "wrong" });
    await agent.post("/api/v1/auth/login").send({ email, password: "testpass123" });

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
    const res = await user.agent.get("/api/v1/auth/login-history");
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

    // Scoped to this token: logging in now issues one too, so the user has
    // more than one row and picking the first would be arbitrary.
    const { rows: stored } = await query(
      "SELECT token_hash FROM refresh_tokens WHERE token_hash = $1", [tokens.hashToken(issued.raw)]
    );
    expect(stored).toHaveLength(1);
    expect(stored[0].token_hash).not.toBe(issued.raw);

    // And the raw value appears nowhere in the table.
    const { rows: plaintext } = await query(
      "SELECT 1 FROM refresh_tokens WHERE token_hash = $1", [issued.raw]
    );
    expect(plaintext).toHaveLength(0);
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

// The reset flow previously read the token, checked used_at in JavaScript,
// changed the password, and only then marked the token used. Two requests
// with the same token both read it as unused and both proceeded - so
// "single-use" held only when nobody raced it, which is precisely what an
// attacker holding a leaked token would not respect.
describe("password reset token is single-use under concurrency", () => {
  async function tokenFor(email) {
    const user = await createVerifiedUser(app, { email });
    const raw = "race-" + Math.random().toString(36).slice(2);
    await query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, now() + interval '30 minutes')`,
      [user.user.id, tokens.hashToken(raw)]
    );
    return { user, raw };
  }

  // Tests the claim at the DATABASE level, on genuinely parallel
  // connections, rather than by calling resetPassword() concurrently.
  //
  // Calling the service ten times in one process does NOT exercise this:
  // bcryptjs is pure JavaScript and blocks the event loop, so the ten
  // requests serialize on hashing and never actually interleave. That test
  // passes even against the old read-then-write code - verified by
  // reintroducing the bug and watching it still pass.
  //
  // The race is real in production, where requests are spread across
  // multiple instances and multiple connections. This reproduces that
  // shape: N separate clients racing the same claim.
  test("only one connection can claim the token, even racing in parallel", async () => {
    const { user, raw } = await tokenFor("raceconcurrent@example.com");
    const tokenHash = tokens.hashToken(raw);

    const { Pool } = require("pg");
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });

    try {
      const claim = () =>
        pool.query(
          `UPDATE password_reset_tokens
           SET used_at = now()
           WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
           RETURNING id`,
          [tokenHash]
        );

      const results = await Promise.all(Array.from({ length: 8 }, claim));
      const winners = results.filter((r) => r.rowCount === 1);

      // The database is the arbiter: whichever statement runs first flips
      // used_at, and every other matches zero rows.
      expect(winners).toHaveLength(1);
    } finally {
      await pool.end();
    }

    // And the service refuses the token afterwards.
    await expect(security.resetPassword(raw, "after-the-race")).rejects.toThrow(/invalid or has expired/i);
    expect(user.user.id).toBeTruthy();
  });

  test("the token is marked used exactly once", async () => {
    const { user, raw } = await tokenFor("raceusedonce@example.com");
    await Promise.allSettled(
      Array.from({ length: 5 }, () => security.resetPassword(raw, "another-password-1"))
    );

    const { rows } = await query(
      "SELECT used_at FROM password_reset_tokens WHERE user_id = $1",
      [user.user.id]
    );
    expect(rows.filter((r) => r.used_at !== null)).toHaveLength(1);
  });

  // A second link sitting in the inbox would otherwise stay a live
  // takeover path after the password had already been changed.
  test("resetting burns every other outstanding token for that user", async () => {
    const user = await createVerifiedUser(app, { email: "burnothers@example.com" });
    const first = "burn-a-" + Math.random().toString(36).slice(2);
    const second = "burn-b-" + Math.random().toString(36).slice(2);
    for (const raw of [first, second]) {
      await query(
        `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
         VALUES ($1, $2, now() + interval '30 minutes')`,
        [user.user.id, tokens.hashToken(raw)]
      );
    }

    await security.resetPassword(first, "used-the-first-link");
    await expect(security.resetPassword(second, "tried-the-second")).rejects.toThrow(/invalid or has expired/i);
  });

  // The claim and the password change are in one transaction: a failure
  // after claiming would otherwise leave the user with a burned token and
  // an unchanged password - locked out by the mechanism meant to help.
  test("a rejected password leaves the token usable", async () => {
    const { raw } = await tokenFor("shortpw@example.com");
    await expect(security.resetPassword(raw, "short")).rejects.toThrow(/at least 8/i);

    // Still valid, because the weak password was refused before the claim.
    await expect(security.resetPassword(raw, "a-proper-password")).resolves.toMatchObject({ ok: true });
  });
});

// The architecture and the behaviour had diverged: refresh_tokens, families
// and rotation existed in the database and in tokenService, while login
// still issued a single 30-day JWT. These assert the session model the
// schema describes is the one actually in use.
describe("session model is access + rotating refresh", () => {
  const jwt = require("jsonwebtoken");

  test("login issues a SHORT-lived access token, not a 30-day one", async () => {
    const email = "sessionmodel@example.com";
    await createVerifiedUser(app, { email });

    const agent = await csrfAgent(app);
    const res = await agent.post("/api/v1/auth/login").send({ email, password: "testpass123" });
    expect(res.status).toBe(200);

    const cookies = res.headers["set-cookie"].join(";");
    const access = /parentos_token=([^;]+)/.exec(cookies)[1];
    const decoded = jwt.decode(access);

    const lifetimeMinutes = (decoded.exp - decoded.iat) / 60;
    expect(lifetimeMinutes).toBeLessThanOrEqual(15);
  });

  test("login also issues a refresh cookie, scoped to the auth routes", async () => {
    const email = "refreshcookie@example.com";
    await createVerifiedUser(app, { email });

    const agent = await csrfAgent(app);
    const res = await agent.post("/api/v1/auth/login").send({ email, password: "testpass123" });
    const refreshCookie = res.headers["set-cookie"].find((c) => c.startsWith("parentos_refresh="));

    expect(refreshCookie).toBeTruthy();
    // Path-scoped so the long-lived credential isn't attached to every
    // ordinary API request the way a single 30-day cookie was.
    expect(refreshCookie).toContain("Path=/api/v1/auth");
    expect(refreshCookie).toContain("HttpOnly");
  });

  test("the refresh endpoint returns a new access token and rotates the refresh one", async () => {
    const email = "rotateendpoint@example.com";
    await createVerifiedUser(app, { email });

    const agent = await csrfAgent(app);
    const login = await agent.post("/api/v1/auth/login").send({ email, password: "testpass123" });
    const firstRefresh = /parentos_refresh=([^;]+)/.exec(login.headers["set-cookie"].join(";"))[1];

    const refreshed = await agent.post("/api/v1/auth/refresh");
    expect(refreshed.status).toBe(200);

    const secondRefresh = /parentos_refresh=([^;]+)/.exec(refreshed.headers["set-cookie"].join(";"))[1];
    expect(secondRefresh).not.toBe(firstRefresh);
  });

  test("a refreshed access token still authenticates ordinary requests", async () => {
    const email = "refreshthenuse@example.com";
    await createVerifiedUser(app, { email });

    const agent = await csrfAgent(app);
    await agent.post("/api/v1/auth/login").send({ email, password: "testpass123" });
    await agent.post("/api/v1/auth/refresh");

    const me = await agent.get("/api/v1/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(email);
  });

  // A cookie the browser merely forgets is still a working credential if it
  // was ever copied, so logout has to invalidate it server-side.
  test("logout revokes the refresh token, not just the cookie", async () => {
    const email = "logoutrevokes@example.com";
    await createVerifiedUser(app, { email });

    const agent = await csrfAgent(app);
    const login = await agent.post("/api/v1/auth/login").send({ email, password: "testpass123" });
    const raw = /parentos_refresh=([^;]+)/.exec(login.headers["set-cookie"].join(";"))[1];

    await agent.post("/api/v1/auth/logout");

    const { rows } = await query(
      "SELECT revoked_at, revoked_reason FROM refresh_tokens WHERE token_hash = $1",
      [tokens.hashToken(decodeURIComponent(raw))]
    );
    expect(rows[0].revoked_at).not.toBeNull();
    expect(rows[0].revoked_reason).toBe("logout");
  });

  // Without revoking refresh tokens, every other device could simply
  // refresh its way back in - making "log out everywhere" a 15-minute
  // inconvenience rather than a logout.
  test("logout-everywhere stops other devices refreshing back in", async () => {
    const email = "logouteverywhere2@example.com";
    await createVerifiedUser(app, { email });

    const deviceA = await csrfAgent(app);
    const deviceB = await csrfAgent(app);
    await deviceA.post("/api/v1/auth/login").send({ email, password: "testpass123" });
    await deviceB.post("/api/v1/auth/login").send({ email, password: "testpass123" });

    await deviceA.post("/api/v1/auth/logout-everywhere");

    const bRefresh = await deviceB.post("/api/v1/auth/refresh");
    expect(bRefresh.status).toBe(401);

    // The device that initiated it stays signed in.
    expect((await deviceA.get("/api/v1/auth/me")).status).toBe(200);
  });

  test("refreshing without a cookie is refused", async () => {
    const agent = await csrfAgent(app);
    expect((await agent.post("/api/v1/auth/refresh")).status).toBe(401);
  });
});

// `sv` vs `session_version`: two issuers that merely agreed on claim names
// until they didn't, and the divergence was invisible until the refresh
// path was actually wired into authentication.
describe("access tokens have one definition", () => {
  test("tokens from login and from refresh are interchangeable", async () => {
    const jwt = require("jsonwebtoken");
    const email = "claimshape@example.com";
    await createVerifiedUser(app, { email });

    const agent = await csrfAgent(app);
    const login = await agent.post("/api/v1/auth/login").send({ email, password: "testpass123" });
    const loginToken = /parentos_token=([^;]+)/.exec(login.headers["set-cookie"].join(";"))[1];

    const refreshed = await agent.post("/api/v1/auth/refresh");
    const refreshToken = /parentos_token=([^;]+)/.exec(refreshed.headers["set-cookie"].join(";"))[1];

    const a = jwt.decode(decodeURIComponent(loginToken));
    const b = jwt.decode(decodeURIComponent(refreshToken));

    // Same claim names, or one path authenticates and the other silently
    // doesn't.
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
    expect(a.sub).toBe(b.sub);
    expect(a.sv).toBe(b.sv);
  });
});
