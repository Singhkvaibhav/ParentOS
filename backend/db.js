const path = require("path");
const fs = require("fs");
const { Pool } = require("pg");
const logger = require("./logger");
require("dotenv").config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/parentos",
});

// Thin query helper - every caller in this app uses this instead of the raw
// pool, so there's one place to add logging/metrics/tracing later.
// A dropped connection on an IDLE pooled client makes `pg` emit 'error'
// on the pool. An unhandled 'error' event on an EventEmitter throws, which
// takes the whole process down - so without this handler a brief Postgres
// restart, a failover, or a managed-database maintenance window kills
// every API instance at once, turning a recoverable blip into an outage.
//
// Verified by stopping Postgres against a running server: it exited.
// Logging and continuing lets the pool reconnect on the next query, which
// is what the readiness probe is there to report in the meantime.
pool.on("error", (err) => {
  logger.error("db_pool_error", { err, detail: "Idle client error; the pool will reconnect on the next query." });
});

async function query(text, params) {
  return pool.query(text, params);
}

// Runs `fn` inside a single database transaction on one dedicated
// connection, committing on success and rolling back on any throw. The
// callback receives a `tx(text, params)` function to use INSTEAD of the
// module-level `query` - anything using `query` inside the callback would
// grab a different pooled connection and therefore run OUTSIDE the
// transaction, which is exactly the subtle bug this helper exists to
// prevent. Used wherever a state change spans multiple statements that
// must not interleave with a concurrent writer (the Stripe webhook and
// the reservation-expiry sweep both mutate transaction + listing state and
// can genuinely run at the same moment).
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const tx = (text, params) => client.query(text, params);
    const result = await fn(tx);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// Applies any pending migrations (see migrate.js) and, only if the
// listings table is empty, seed.sql. Called once at startup from server.js
// rather than at module-load time, since it's async and needs to finish
// before the app starts accepting requests.
async function initDb() {
  const { runMigrations } = require("./migrate"); // required here, not at top, to avoid a circular require (migrate.js needs `pool` from this file)
  await runMigrations();

  // Before the test early-return below: tests must detect PostGIS too, or
  // they'd silently only ever exercise the bounding-box fallback and the
  // spatial path would go untested.
  await detectPostgis();

  // Never seed demo data during tests - they create their own users via the
  // API, and seed.sql hardcodes id=1 for the demo account, which can
  // collide with an auto-generated id from a previous test file's users
  // once tests share one real Postgres database rather than each getting
  // an isolated SQLite ":memory:" instance (see tests/dbReset.js).
  if (process.env.NODE_ENV === "test") return;

  const { rows } = await pool.query("SELECT COUNT(*) AS n FROM listings");
  if (Number(rows[0].n) === 0) {
    // Same reason as MIGRATIONS_DIR: must live inside the Docker build
    // context, or the image ships without it.
    const seedPath = path.resolve(__dirname, "database/seed.sql");
    if (fs.existsSync(seedPath)) await pool.query(fs.readFileSync(seedPath, "utf8"));
  }
}

// Whether the database actually has PostGIS and the spatial column, so
// listingsService can pick the indexed spatial query or the bounding-box
// fallback. Detected once at startup rather than per-request: it can't
// change while the process is running, and checking on every search would
// add a round-trip to the hot path.
let postgisAvailable = false;

async function detectPostgis() {
  try {
    const { rows } = await pool.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'listings' AND column_name = 'geog'
      ) AS has_geog
    `);
    postgisAvailable = !!rows[0]?.has_geog;
  } catch {
    postgisAvailable = false;
  }
  return postgisAvailable;
}

function hasPostgis() {
  return postgisAvailable;
}

module.exports = { pool, query, withTransaction, initDb, detectPostgis, hasPostgis };
