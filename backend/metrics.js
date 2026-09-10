const http = require("http");
const { pool } = require("./db");
const logger = require("./logger");

// Metrics live on their OWN listener, not on the public application.
//
// They were previously a route on the main app, protected only by an nginx
// allow/deny block. That makes nginx the single boundary for operational
// data: one mistyped `location`, one config reload that doesn't take, one
// direct hit on the container port, and pool saturation and unresolved
// payment discrepancies are public. `parentos_reconciliation_open_issues`
// in particular says "money is currently wrong here", which is not a
// number to leave one config line away from the internet.
//
// A separate port means the public app has no /metrics route to reach at
// all - the endpoint simply is not part of the surface nginx proxies. It
// binds to 127.0.0.1 by default so nothing outside the host can connect
// even if a port is accidentally published; a container deployment sets
// METRICS_HOST=0.0.0.0 and keeps the port off the published list, so it's
// reachable on the compose network and nowhere else.
//
// A bearer token can be required as well. That's defence in depth, not the
// primary control: the network boundary is.
const METRICS_PORT = Number(process.env.METRICS_PORT || 9091);
const METRICS_HOST = process.env.METRICS_HOST || "127.0.0.1";
const METRICS_TOKEN = process.env.METRICS_TOKEN || "";

async function collect() {
  const lines = [];
  const gauge = (name, help, value) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name} ${value}`);
  };

  const mem = process.memoryUsage();
  gauge("parentos_uptime_seconds", "Process uptime.", Math.round(process.uptime()));
  gauge("parentos_heap_used_bytes", "V8 heap in use.", mem.heapUsed);
  gauge("parentos_db_pool_total", "Postgres pool connections.", pool.totalCount ?? 0);
  gauge("parentos_db_pool_idle", "Idle pool connections.", pool.idleCount ?? 0);
  // A persistently non-zero waiting count means the pool is undersized -
  // the signal that arrives before users notice slowness.
  gauge("parentos_db_pool_waiting", "Requests waiting for a connection.", pool.waitingCount ?? 0);

  try {
    // Unresolved payment discrepancies: the one business number that
    // belongs in operational monitoring, because it means money is
    // currently wrong and nobody has looked.
    const { rows } = await pool.query(
      "SELECT COUNT(*) AS n FROM reconciliation_issues WHERE status = 'open'"
    );
    gauge("parentos_reconciliation_open_issues", "Unresolved payment discrepancies.", Number(rows[0].n));
  } catch {
    // Table may not exist yet on a fresh database - a scrape must never
    // fail because one gauge is unavailable.
  }

  return lines.join("\n") + "\n";
}

function createMetricsServer() {
  return http.createServer(async (req, res) => {
    if (req.url !== "/metrics" || req.method !== "GET") {
      res.writeHead(404).end();
      return;
    }

    if (METRICS_TOKEN) {
      const provided = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      // Length-safe comparison: timingSafeEqual throws on mismatched
      // lengths, so check that first rather than leaking it by exception.
      const crypto = require("crypto");
      const a = Buffer.from(provided);
      const b = Buffer.from(METRICS_TOKEN);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        res.writeHead(401).end();
        return;
      }
    }

    try {
      res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" }).end(await collect());
    } catch (e) {
      logger.error("metrics_collection_failed", { err: e });
      res.writeHead(500).end();
    }
  });
}

function startMetricsServer() {
  const server = createMetricsServer();
  server.listen(METRICS_PORT, METRICS_HOST, () => {
    logger.info("metrics_listening", {
      host: METRICS_HOST,
      port: METRICS_PORT,
      tokenRequired: !!METRICS_TOKEN,
    });
  });
  // Never let the metrics listener keep the process alive on shutdown.
  server.unref();
  return server;
}

module.exports = { createMetricsServer, startMetricsServer, collect, METRICS_PORT, METRICS_HOST };
