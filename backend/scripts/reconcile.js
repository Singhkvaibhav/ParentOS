// One-off reconciliation pass, for cron or manual investigation.
//
// Exists separately from the admin endpoint so reconciliation can run on a
// schedule without anyone logging in, and so it can be run against a
// production database during an incident without going through the app.
require("dotenv").config();

const { runReconciliation } = require("../services/reconciliationService");
const { pool } = require("../db");
const logger = require("../logger");

(async () => {
  try {
    const result = await runReconciliation();
    logger.info("reconciliation_run_complete", result);
    // Non-zero exit when discrepancies are found, so a cron wrapper or CI
    // check can alert on it rather than the result being buried in logs.
    process.exit(result.issuesFound > 0 ? 2 : 0);
  } catch (e) {
    logger.error("reconciliation_run_failed", { err: e });
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
