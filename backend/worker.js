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

// Pulled out of registerWorker's callback so it can be unit-tested directly
// against a fake job, rather than only being reachable by actually running
// this file against a live Redis - which the test suite deliberately never
// requires (see queue/index.js's comment on why Redis stays optional).
async function handleImageProcessingJob(job) {
  const { processQuarantinedImage, ImageProcessingError } = require("./services/imageProcessingService");
  const { markProcessed, markFailed } = require("./services/uploadService");
  const { quarantineKey, uploadId } = job.data;

  try {
    const result = await processQuarantinedImage(quarantineKey);
    // This is the state transition the HTTP finalize route can no longer
    // make itself once the job is queued (its response already went out
    // with { queued: true }) - without it, the uploads row stays
    // "uploaded" forever even though the public image now exists.
    await markProcessed(uploadId, {
      publicKey: result.key, publicUrl: result.url, publicThumbUrl: result.thumbUrl,
    });
  } catch (e) {
    if (e instanceof ImageProcessingError) {
      // Deterministic (not an image / still too large after resizing) -
      // processQuarantinedImage already deleted the quarantine object
      // before throwing, so a retry could only fail the same way for a
      // different reason. Record it and stop rather than burning the
      // remaining attempts against a file that no longer exists.
      await markFailed(uploadId, e.message);
      return;
    }
    // Anything else (storage/network) is the transient failure the queue's
    // retry/backoff exists for. Only give up on the upload row once BullMQ
    // has too - attemptsMade counts completed attempts, so this is the
    // last one when it's about to hit the configured cap.
    if (job.attemptsMade + 1 >= job.opts.attempts) {
      await markFailed(uploadId, "Image processing failed after multiple attempts.");
    }
    throw e;
  }
}

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

  registerWorker(QUEUE_NAMES.IMAGE_PROCESSING, handleImageProcessingJob);

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

// Guarded so this file can be `require`d by tests (to reach
// handleImageProcessingJob) without also running the whole worker process,
// which would exit(1) immediately in a test environment that deliberately
// has no REDIS_URL configured.
if (require.main === module) {
  main().catch((e) => {
    logger.error("worker_crashed", { err: e });
    process.exit(1);
  });
}

module.exports = { handleImageProcessingJob };
