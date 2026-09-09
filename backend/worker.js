// Background job worker.
//
// Deliberately a SEPARATE entry point from server.js rather than workers
// started inside the web process. Two reasons that matter in production:
// AI generation is slow and would compete with request handling for the
// event loop, and workers need to scale on a different axis from web
// traffic (a burst of messages needs more workers, not more HTTP capacity).
//
// Run with: npm run worker
require("dotenv").config();

const { registerWorker, isEnabled, shutdown, QUEUE_NAMES } = require("./queue");
const { initDb, pool } = require("./db");
const logger = require("./logger");

async function main() {
  if (!isEnabled()) {
    // Failing loudly here is deliberate: someone running `npm run worker`
    // has explicitly asked for background processing, so silently doing
    // nothing would be the worst outcome - jobs would appear to be
    // handled while nothing consumed them.
    logger.error("worker_cannot_start_no_redis", {
      reason: "REDIS_URL is not set. The app falls back to in-process jobs, so this worker has nothing to consume.",
    });
    process.exit(1);
  }

  await initDb();

  const { runAiReplyForJob } = require("./services/messagesService");
  const { runReconciliation } = require("./services/reconciliationService");

  registerWorker(QUEUE_NAMES.AI_REPLY, async (job) => {
    await runAiReplyForJob(job.data);
  });

  // Concurrency 1: reconciliation reads broadly and there's no value in
  // several passes racing each other.
  const { processQuarantinedImage } = require("./services/imageProcessingService");
  registerWorker(QUEUE_NAMES.IMAGE_PROCESSING, async (job) => {
    await processQuarantinedImage(job.data.quarantineKey);
  });

  registerWorker(QUEUE_NAMES.RECONCILIATION, async () => {
    const result = await runReconciliation();
    return result;
  }, { concurrency: 1 });

  logger.info("worker_started", { queues: Object.values(QUEUE_NAMES) });

  // Close cleanly on a deploy so in-flight jobs finish rather than being
  // killed mid-write - the whole point of the queue is not losing work.
  const stop = async (signal) => {
    logger.info("worker_shutting_down", { signal });
    await shutdown();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}

main().catch((e) => {
  logger.error("worker_crashed", { err: e });
  process.exit(1);
});
