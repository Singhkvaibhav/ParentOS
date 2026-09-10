require("dotenv").config();

// Fail fast at boot rather than 500ing on the first login: JWT_SECRET is
// used on every signed-in request, so a missing or clearly-default value
// here is a startup-time bug, not a runtime one.
const PLACEHOLDER_SECRET = "change-this-to-a-long-random-string";
if (!process.env.JWT_SECRET) {
  // Deliberately console, not the logger: this fires before anything is
  // wired up, and its only job is to be readable by a human at a terminal
  // who has just run the server and needs to know why it stopped.
  console.error("Missing required environment variable: JWT_SECRET. Copy .env.example to .env and set it.");
  process.exit(1);
}
if (process.env.NODE_ENV === "production" && process.env.JWT_SECRET === PLACEHOLDER_SECRET) {
  console.error("JWT_SECRET is still the example placeholder value - set a real secret before running in production.");
  process.exit(1);
}

const path = require("path");
const express = require("express");
const helmet = require("helmet");
require("express-async-errors"); // must load after express, before routes are defined -
// patches Express so a rejected promise in an async handler (e.g. the
// Anthropic call, a DB error) reaches the error middleware below instead of
// hanging the request forever (a plain Express 4 gap).
const cors = require("cors");
const cookieParser = require("cookie-parser");
const { issueCsrfToken, requireCsrfToken, CSRF_HEADER_NAME } = require("./middleware/csrf");
const requestLogger = require("./middleware/requestLogger");
const { resolveCorsOrigins } = require("./config");
const { assertValidConfig } = require("./configCheck");
const { captureException } = require("./errorTracking");
const logger = require("./logger");
const { pool, initDb } = require("./db");

const authRoutes = require("./auth/routes");
const listingsRoutes = require("./listings/routes");
const usersRoutes = require("./users/routes");
const messagesRoutes = require("./messages/routes");
const favoritesRoutes = require("./favorites/routes");
const reviewsRoutes = require("./reviews/routes");
const imagesRoutes = require("./images/routes");
const transactionsRoutes = require("./transactions/routes");
const transactionsController = require("./transactions/controller");
const transactionsService = require("./services/transactionsService");
const connectRoutes = require("./connect/routes");
const metaRoutes = require("./meta/routes");
const moderationRoutes = require("./moderation/routes");
const notificationsRoutes = require("./notifications/routes");
const analyticsRoutes = require("./analytics/routes");
const reconciliationRoutes = require("./reconciliation/routes");
const privacyRoutes = require("./privacy/routes");

const app = express();

// Behind a reverse proxy, every request arrives from the proxy's address.
// Without this, req.ip is the nginx container's IP for ALL traffic, which
// quietly breaks four things that assume it identifies a client:
//
//   - per-IP rate limits become one shared bucket for the entire user
//     population, so the first few failed logins anywhere lock out
//     everyone
//   - login history records the proxy instead of the user
//   - suspicious-login detection compares proxy IP to proxy IP and never
//     fires
//   - password-reset requests are all attributed to the same address
//
// The value is a HOP COUNT, not a boolean. `1` means "trust exactly one
// proxy in front of me" - the nginx in docker-compose.yml. Setting `true`
// would trust the whole X-Forwarded-For chain, letting a client spoof its
// own IP by sending the header itself and walk straight through the rate
// limits this is meant to fix. If a CDN or load balancer is added in
// front, this number must go up to match, and no further.
//
// Only in production: in development there is no proxy, and trusting a
// header nobody sets would be the same spoofing hole with no upside.
if (process.env.NODE_ENV === "production") {
  app.set("trust proxy", Number(process.env.TRUSTED_PROXY_HOPS || 1));
}
// First in the chain so even requests rejected later (CORS, CSRF, bad
// body) still produce a log line with timing and status.
// Security headers. These cost nothing and close a category of attacks
// the app is otherwise wide open to - clickjacking, MIME sniffing,
// referrer leakage of listing URLs to third parties.
//
// CSP is set explicitly rather than using helmet's default, because the
// default forbids the things this app genuinely needs (Stripe's iframe
// for card entry, uploaded images) and a CSP that breaks checkout would
// just get switched off.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      // Stripe.js must load from Stripe and runs its card form in an iframe.
      scriptSrc: ["'self'", "https://js.stripe.com"],
      frameSrc: ["'self'", "https://js.stripe.com", "https://hooks.stripe.com"],
      connectSrc: ["'self'", "https://api.stripe.com"],
      // Listing photos are served from this origin, but data: URIs are
      // used for previews before upload completes.
      imgSrc: ["'self'", "data:", "blob:"],
      styleSrc: ["'self'", "'unsafe-inline'"], // the SPA injects styles at runtime
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"], // nobody may frame us - clickjacking
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
  // Don't leak the full listing URL (which identifies an item and a
  // seller) to third-party sites the user clicks through to.
  referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  // HSTS is only meaningful over HTTPS and would be actively unhelpful in
  // local development, so it's enabled per-environment.
  hsts: process.env.NODE_ENV === "production"
    ? { maxAge: 15552000, includeSubDomains: true }
    : false,
  crossOriginEmbedderPolicy: false, // would block Stripe's iframe
}));

app.use(requestLogger);
app.use(cookieParser());

// CORS is pinned to an explicit allowlist, not every origin. Now that the
// auth token lives in an httpOnly cookie rather than being readable by JS
// at all, the bigger risk an open CORS policy would create here is CSRF
// (a malicious site making the browser send authenticated requests, not
// reading responses) - `credentials: true` is required for the cookie to
// be sent/received across origins at all, which makes a strict allowlist
// (rather than a wildcard) essential, not optional.
// Resolved by config.js so the server and the production config check can
// never disagree about which variable is authoritative - they did, and the
// mismatch was silent.
const { origins: allowedOrigins, usingDefault: corsUsingDefault, source: corsSource } =
  resolveCorsOrigins();

if (corsSource === "ALLOWED_ORIGINS") {
  logger.warn("cors_origins_legacy_variable", {
    message: "ALLOWED_ORIGINS is deprecated - rename it to CORS_ORIGINS.",
  });
}
logger.info("cors_configured", { origins: allowedOrigins, usingDefault: corsUsingDefault });
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    const err = new Error(`Origin ${origin} is not allowed by CORS.`);
    err.status = 403;
    callback(err);
  },
  credentials: true,
  // The CSRF header is a custom header, so it must be explicitly allowed
  // or the browser's preflight check rejects any cross-origin request
  // carrying it (same-origin requests via the Vite proxy don't preflight,
  // so this only matters once frontend and backend are on different
  // origins - but it's wrong to leave broken until that day).
  allowedHeaders: ["Content-Type", CSRF_HEADER_NAME],
}));

// Stripe webhook needs the raw body for signature verification, so it must
// be registered BEFORE express.json() below, and only for this one route.
app.post("/api/transactions/webhook", express.raw({ type: "application/json" }), transactionsController.webhook);

// Most endpoints never need more than a tiny JSON body - a small default
// limit here (instead of one big limit for the whole app) means a stray
// multi-megabyte payload to, say, /api/auth/login can't tie up memory.
// Uploads sets its own larger limit on just that one route, below.
app.use((req, res, next) => {
  if (req.path.startsWith("/api/uploads")) return next();
  express.json({ limit: "300kb" })(req, res, next);
});

// Serves locally-stored images when S3 isn't configured (see backend/storage).
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// CSRF: issue a token to every client, and require it back as a header on
// every state-changing request. Registered AFTER the Stripe webhook above
// (which is server-to-server, has no browser cookies, and is authenticated
// by signature instead) and before the API routes it protects.
app.use(issueCsrfToken);
app.use(requireCsrfToken);

app.use("/api/auth", authRoutes);
app.use("/api/listings", listingsRoutes);
app.use("/api/users", usersRoutes);
app.use("/api/messages", messagesRoutes);
app.use("/api/favorites", favoritesRoutes);
app.use("/api/reviews", reviewsRoutes);
app.use("/api/uploads", imagesRoutes);
app.use("/api/transactions", transactionsRoutes);
app.use("/api/connect", connectRoutes);
app.use("/api/meta", metaRoutes);
app.use("/api/moderation", moderationRoutes);
app.use("/api/notifications", notificationsRoutes);
app.use("/api/analytics", analyticsRoutes);
app.use("/api/reconciliation", reconciliationRoutes);
app.use("/api/privacy", privacyRoutes);

// Liveness: is this process alive at all? Deliberately does NOT touch the
// database. A liveness probe that checks dependencies is a well-known
// outage amplifier: a brief database blip makes every instance report
// unhealthy, the orchestrator kills them all, and a recoverable dependency
// problem becomes a total outage.
app.get("/api/health", (req, res) => {
  res.json({ ok: true, uptimeSeconds: Math.round(process.uptime()) });
});

// Readiness: should this instance receive traffic right now? This one DOES
// check dependencies, because an instance that can't reach Postgres should
// be pulled from the load balancer - but not restarted.
app.get("/api/ready", async (req, res) => {
  const checks = {};
  let ready = true;

  try {
    await pool.query("SELECT 1");
    checks.database = "ok";
  } catch {
    checks.database = "unreachable";
    ready = false; // nothing works without the database
  }

  // Redis is optional by design (the app falls back to in-process jobs),
  // so its absence is reported but does not make the instance unready.
  checks.queue = require("./queue").isEnabled() ? "enabled" : "disabled";

  res.status(ready ? 200 : 503).json({ ready, checks });
});

// Operational metrics in Prometheus text format. Deliberately minimal and
// deliberately NOT business analytics - that already exists at
// /api/analytics. This answers "is the service healthy", which is a
// different question asked by different people at different times.
app.get("/metrics", async (req, res) => {
  const lines = [];
  const gauge = (name, help, value) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name} ${value}`);
  };

  const mem = process.memoryUsage();
  gauge("parentos_uptime_seconds", "Process uptime.", Math.round(process.uptime()));
  gauge("parentos_heap_used_bytes", "V8 heap in use.", mem.heapUsed);
  gauge("parentos_db_pool_total", "Postgres pool connections.", pool.totalCount ?? 0);
  gauge("parentos_db_pool_idle", "Idle pool connections.", pool.idleCount ?? 0);
  // A persistently non-zero waiting count means the pool is undersized -
  // the signal that arrives before users notice slowness.
  gauge("parentos_db_pool_waiting", "Requests waiting for a connection.", pool.waitingCount ?? 0);

  try {
    // Unresolved payment discrepancies: the one business number that
    // belongs in operational monitoring, because it means money is
    // currently wrong and nobody has looked.
    const { rows } = await pool.query(
      "SELECT COUNT(*) AS n FROM reconciliation_issues WHERE status = 'open'"
    );
    gauge("parentos_reconciliation_open_issues", "Unresolved payment discrepancies.", Number(rows[0].n));
  } catch {
    // Table may not exist yet on a fresh database - metrics must never
    // fail the scrape.
  }

  res.set("Content-Type", "text/plain; version=0.0.4").send(lines.join("\n") + "\n");
});

app.use((err, req, res, next) => {
  // Goes through errorTracking rather than straight to the logger, so
  // unexpected 500s reach whatever tracker is configured. It logs locally
  // either way.
  captureException(err, { requestId: req.id, method: req.method, path: req.originalUrl });
  // Trust a status the error already carries (body-parser's 413 for an
  // oversized payload, the 403 set on CORS rejections above, etc.) instead
  // of flattening every error to a generic 500 - only truly unexpected
  // errors should hide their message from the client.
  const status = err.status || err.statusCode || 500;
  const message = status < 500 ? err.message : "Something went wrong on the server.";
  res.status(status).json({ error: message });
});

// Schema/seed setup is async now (real network round-trips to Postgres,
// unlike the old synchronous SQLite file access) - `dbReady` is exported so
// the test suite can await it before running anything, and the real server
// only starts accepting connections once it resolves.
const dbReady = initDb();

const PORT = process.env.PORT || 4000;
let server;
if (require.main === module) {
  // Before anything binds a port or touches the database: refuse to start
  // on configuration that isn't safe to run. Deliberately not inside
  // dbReady - a bad JWT secret should fail instantly, not after a
  // successful database connection makes it look like startup worked.
  assertValidConfig();

  // Last-resort handlers. These do NOT keep the process running after an
  // unknown fault - continuing in an unknown state is worse than
  // restarting - but they make sure the reason is logged in the same
  // structured format as everything else, rather than being lost to a raw
  // stack trace on stderr that no log aggregator will parse.
  process.on("unhandledRejection", (err) => {
    captureException(err, { fatal: true, kind: "unhandledRejection" });
    process.exit(1);
  });
  process.on("uncaughtException", (err) => {
    captureException(err, { fatal: true, kind: "uncaughtException" });
    process.exit(1);
  });

  // Graceful shutdown. An orchestrator sends SIGTERM and then waits before
  // sending SIGKILL; closing the server first lets in-flight requests
  // finish instead of being cut off mid-response during every deploy.
  const shutdown = (signal) => {
    logger.info("shutdown_started", { signal });
    server.close(async () => {
      await pool.end().catch(() => {});
      logger.info("shutdown_complete", { signal });
      process.exit(0);
    });
    // Don't wait forever for a stuck connection.
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  dbReady
    .then(() => {
      server = app.listen(PORT, () => logger.info("server_listening", { port: PORT }));

      // Releases listings stuck 'reserved' because a buyer abandoned
      // checkout without Stripe ever sending a failed/canceled webhook -
      // see transactionsService.releaseExpiredReservations. Not run during
      // tests, which call it directly when they want to exercise it.
      const sweepIntervalMs = 5 * 60 * 1000;
      setInterval(async () => {
        try {
          const released = await transactionsService.releaseExpiredReservations();
          if (released > 0) logger.info("reservations_released", { count: released });
        } catch (e) {
          logger.error("reservation_sweep_failed", { err: e });
        }
      }, sweepIntervalMs);
    })
    .catch((e) => {
      logger.error("db_init_failed", { err: e });
      process.exit(1);
    });
}

module.exports = app;
module.exports.dbReady = dbReady;
