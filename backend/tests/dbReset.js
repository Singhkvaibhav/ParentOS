const { query, initDb } = require("../db");

// Truncates every table and resets identity sequences, so each test file
// starts from a genuinely clean slate.
//
// The table list is read from the catalog rather than hardcoded. The
// previous hardcoded version relied on CASCADE to reach dependent tables,
// which worked only for tables with a foreign-key path back to one of the
// six named. A standalone table (reconciliation_runs, for instance) was
// never truncated at all, so rows leaked between test files and produced
// failures that looked like product bugs but were stale fixtures.
//
// Enumerating the catalog means a new table is covered the moment it's
// created, instead of being one more thing to remember.
async function resetDb() {
  const { rows } = await query(`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
      -- schema_migrations records which migrations ran; truncating it
      -- would make the next startup re-run every migration.
      AND tablename <> 'schema_migrations'
      -- PostGIS reference data, not application state.
      AND tablename <> 'spatial_ref_sys'
  `);
  if (rows.length === 0) return;

  const tables = rows.map((r) => `"${r.tablename}"`).join(", ");
  await query(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);
}

module.exports = { resetDb, initDb };
