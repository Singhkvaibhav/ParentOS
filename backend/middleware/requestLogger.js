const { randomUUID } = require("crypto");
const logger = require("../logger");
const { runWithRequestContext } = require("../requestContext");

// Assigns every request an id and logs one structured line when it
// finishes, with the timing. The id is echoed back in an `x-request-id`
// header and attached to `req` so anything logging mid-request can
// reference it - which is what turns a pile of independent log lines into
// something you can actually trace ("show me everything for this one
// failing request").
//
// Honours an inbound x-request-id if a proxy/load balancer already set
// one, so a trace isn't broken at our boundary.
function requestLogger(req, res, next) {
  req.id = req.get("x-request-id") || randomUUID();
  res.set("x-request-id", req.id);

  const startedAt = process.hrtime.bigint();

  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

    // Health checks are typically hit every few seconds by an uptime
    // monitor - logging each one buries everything else in noise.
    if (req.originalUrl.startsWith("/api/health") && res.statusCode < 400) return;

    const level = res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";
    logger[level]("http_request", {
      requestId: req.id,
      method: req.method,
      // originalUrl, not req.path: by the time this fires, req.path has
      // been rewritten to be relative to whatever router handled it, so a
      // request to /api/v1/auth/signup would log as just "/signup" - which
      // makes different endpoints indistinguishable in the logs.
      path: req.originalUrl.split("?")[0],
      status: res.statusCode,
      durationMs: Math.round(durationMs * 10) / 10,
      userId: req.user?.id,
    });
  });

  // Everything downstream of here runs inside the request's context, so
  // any log line it produces is automatically correlated.
  runWithRequestContext({ requestId: req.id }, () => next());
}

module.exports = requestLogger;
