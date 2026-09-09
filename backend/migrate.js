// Real, incremental database migrations - replaces the earlier
// "CREATE TABLE IF NOT EXISTS schema.sql, hope it matches" approach.
//
// database/migrations/*.sql files run in filename order, each exactly
// once, tracked in a schema_migrations table. Adding a new schema change
// means adding a new numbered file (e.g. 002_add_something.sql) - never
// editing an already-applied one.
//
// Usable two ways:
//   - `node migrate.js` (or `npm run migrate`) as an explicit deploy step,
//     matching the "deploy -> run migrations -> start app" flow rather
//     than the app silently hoping its schema matches on every boot.
//   - `require("./migrate").runMigrations()` - what db.js's initDb() calls
//     automatically for local dev/tests, so `npm run dev` still works with
//     zero extra steps.
const fs = require("fs");
const path = require("path");
const { pool } = require("./db");

// Inside the backend directory, NOT a sibling of it.
//
// This was `../database/migrations`, which put the migrations OUTSIDE the
// Docker build context (`./backend`). `COPY . .` therefore couldn't
// include them, so the built image shipped with no migrations at all and
// crashed on first boot with ENOENT - a bug that only appears in a real
// production install, which is exactly why it survived until one was
// actually simulated.
const MIGRATIONS_DIR = path.resolve(__dirname, "database/migrations");

async function runMigrations() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort(); // filenames are zero-padded (001_, 002_, ...) so lexical sort is also numeric order

  const { rows } = await pool.query("SELECT filename FROM schema_migrations");
  const applied = new Set(rows.map((r) => r.filename));

  const pending = files.filter((f) => !applied.has(f));
  if (pending.length === 0) return { applied: [] };

  for (const filename of pending) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, filename), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [filename]);
      await client.query("COMMIT");
      console.log(`Applied migration: ${filename}`);
    } catch (e) {
      await client.query("ROLLBACK");
      console.error(`Migration ${filename} failed - rolled back:`, e.message);
      throw e;
    } finally {
      client.release();
    }
  }

  return { applied: pending };
}

if (require.main === module) {
  runMigrations()
    .then(({ applied }) => {
      console.log(applied.length ? `Done - ${applied.length} migration(s) applied.` : "Already up to date.");
      return pool.end();
    })
    .catch((e) => {
      console.error("Migration run failed:", e);
      process.exit(1);
    });
}

module.exports = { runMigrations };
