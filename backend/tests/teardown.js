// Runs after each test file's suite finishes (registered via jest's
// setupFilesAfterEnv, so `afterAll` is available here) - closes this test
// file's Postgres connection pool so Jest can exit on its own instead of
// needing --forceExit to paper over a real leaked handle.
const { pool } = require("../db");

afterAll(async () => {
  // Several things are deliberately fire-and-forget in production code -
  // notifications, AI replies, analytics writes - precisely so a
  // marketplace action never fails because of them. That means they can
  // still be in flight when a test file's last assertion finishes, and
  // closing the pool underneath them produces "Cannot use a pool after
  // calling end on the pool" as a suite-level error.
  //
  // A short grace period lets those settle first. This is a test-harness
  // concern, not a product one: in the real server the pool lives for the
  // process lifetime, so the situation can't arise.
  await new Promise((resolve) => setTimeout(resolve, 250));
  await pool.end();
});
