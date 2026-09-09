const { Queue, Worker } = require("bullmq");
const logger = require("../logger");

// (#8) Durable background jobs.
//
// AI auto-replies were an in-process `.catch()` promise: if the Node
// process restarted between a buyer's message and the reply being
// generated, the job vanished silently and the buyer waited forever for an
// answer that would never come. Nothing retried, and nothing recorded that
// it had been lost.
//
// A queue fixes the durability problem, but it must not become a hard
// dependency. Requiring Redis to run the app locally, or to run the test
// suite, would be a real cost paid on every single day of development for
// a benefit that only matters in production. So this degrades exactly like
// the PostGIS work: if Redis isn't configured, callers fall back to the
// in-process path and the app behaves as before.
const REDIS_URL = process.env.REDIS_URL || "";
const QUEUES_ENABLED = !!REDIS_URL;

const connectionOptions = QUEUES_ENABLED
  ? {
      connection: {
        url: REDIS_URL,
        // BullMQ requires this; without it a Redis blip throws instead of
        // letting the job retry.
        maxRetriesPerRequest: null,
      },
    }
  : null;

const queues = new Map();
const workers = [];

function isEnabled() {
  return QUEUES_ENABLED;
}

function getQueue(name) {
  if (!QUEUES_ENABLED) return null;
  if (!queues.has(name)) {
    queues.set(name, new Queue(name, connectionOptions));
  }
  return queues.get(name);
}

// Adds a job. Returns false when queues are disabled, so the caller can
// decide what to do instead - rather than silently dropping the work,
// which is the failure mode this whole module exists to remove.
async function enqueue(queueName, jobName, data, opts = {}) {
  const queue = getQueue(queueName);
  if (!queue) return false;

  try {
    await queue.add(jobName, data, {
      // Retries with backoff: an AI provider being briefly unavailable is
      // the expected failure, not an exceptional one.
      attempts: 3,
      backoff: { type: "exponential", delay: 2000 },
      // Keep a bounded history rather than growing Redis without limit.
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 500 },
      ...opts,
    });
    return true;
  } catch (e) {
    // A queue that can't accept work must not take the request down with
    // it - the caller falls back to running inline.
    logger.error("enqueue_failed", { queueName, jobName, err: e });
    return false;
  }
}

function registerWorker(queueName, handler, opts = {}) {
  if (!QUEUES_ENABLED) return null;

  const worker = new Worker(
    queueName,
    async (job) => {
      // The requestId that triggered this job travels with it, so a
      // background failure can be traced back to the request that caused
      // it rather than appearing as an orphaned error.
      logger.info("job_started", { queueName, jobId: job.id, name: job.name, requestId: job.data?.requestId });
      const result = await handler(job);
      logger.info("job_completed", { queueName, jobId: job.id, name: job.name, requestId: job.data?.requestId });
      return result;
    },
    { ...connectionOptions, concurrency: opts.concurrency ?? 5 }
  );

  worker.on("failed", (job, err) => {
    logger.error("job_failed", {
      queueName,
      jobId: job?.id,
      name: job?.name,
      attemptsMade: job?.attemptsMade,
      requestId: job?.data?.requestId,
      err,
    });
  });

  workers.push(worker);
  return worker;
}

async function shutdown() {
  await Promise.all(workers.map((w) => w.close()));
  await Promise.all([...queues.values()].map((q) => q.close()));
}

const QUEUE_NAMES = Object.freeze({
  AI_REPLY: "ai-reply",
  RECONCILIATION: "reconciliation",
  IMAGE_PROCESSING: "image-processing",
});

module.exports = { isEnabled, enqueue, registerWorker, shutdown, QUEUE_NAMES };
