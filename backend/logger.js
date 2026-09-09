// Structured JSON logging.
//
// Replaces scattered console.log/error calls with a single logger that
// emits one JSON object per line. That format is what makes logs actually
// queryable once they're shipped anywhere (CloudWatch, Datadog, Loki,
// etc.) - you can filter on `level`, `event`, `requestId` or any other
// field instead of writing regexes against prose.
//
// Deliberately dependency-free: pino/winston are better at high volume,
// but this is ~40 lines, has no supply-chain surface, and can be swapped
// out later because every caller goes through this one module.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_LEVEL = LEVELS[process.env.LOG_LEVEL] || LEVELS.info;

// Never let these reach the logs, no matter which object gets passed in -
// logs get shipped to third parties, kept for months, and read by people
// who shouldn't see credentials.
const REDACTED_KEYS = new Set([
  "password", "passwordHash", "password_hash",
  "token", "clientSecret", "client_secret",
  "verification_code", "verificationCode", "devCode",
  "authorization", "cookie",
]);

function redact(value, depth = 0) {
  if (depth > 4 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = REDACTED_KEYS.has(k) ? "[redacted]" : redact(v, depth + 1);
  }
  return out;
}

function emit(level, event, fields = {}) {
  if (LEVELS[level] < MIN_LEVEL) return;

  // Attached automatically from the ambient request context, so a Stripe
  // failure deep in a service is linkable to the HTTP request that caused
  // it without every call site remembering to pass an id.
  // Required lazily: logger.js is loaded very early and must not create a
  // require cycle.
  let requestId = null;
  try {
    ({ currentRequestId: requestId } = { currentRequestId: require("./requestContext").currentRequestId() });
  } catch {
    // No context (startup, a background sweep) - just omit the field.
  }

  const line = {
    level,
    event,
    time: new Date().toISOString(),
    ...(requestId ? { requestId } : {}),
    ...redact(fields),
  };

  // Errors carry their message/stack outside enumerable properties, so
  // they'd serialize to "{}" without this.
  if (fields.err instanceof Error) {
    line.err = { message: fields.err.message, name: fields.err.name, stack: fields.err.stack };
  }

  const out = level === "error" || level === "warn" ? process.stderr : process.stdout;
  out.write(JSON.stringify(line) + "\n");
}

const logger = {
  debug: (event, fields) => emit("debug", event, fields),
  info: (event, fields) => emit("info", event, fields),
  warn: (event, fields) => emit("warn", event, fields),
  error: (event, fields) => emit("error", event, fields),
};

module.exports = logger;
