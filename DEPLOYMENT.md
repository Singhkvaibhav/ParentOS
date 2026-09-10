# Deploying ParentOS

What has and hasn't been verified is stated explicitly below. Infrastructure
that has never been run is a liability dressed as reassurance, so it's
worth knowing which is which.

| Piece | Status |
|---|---|
| nginx reverse proxy config | **Verified** - `nginx -t` passes, and it was run against the live API and built SPA (redirect, TLS, proxying, SPA deep links, metrics ACL, HSTS all checked over the wire) |
| Backup script | **Verified** - run against a real database, dump verified, restored into a fresh database, data and PostGIS columns confirmed intact |
| Startup config validation | **Verified** - refuses to boot on unsafe config, boots on valid config |
| Liveness / readiness / metrics | **Verified** - including behaviour during a real Postgres outage |
| Database outage resilience | **Verified** - process survives, readiness drops to 503, reconnects automatically |
| Dockerfiles and docker-compose | **Not built** - no Docker daemon was available. Structurally validated only |

---

## Architecture

```
                     internet
                        |
                   [  proxy  ]          nginx: TLS, static SPA, API routing
                        |
           +------------+------------+
           v            v            v
          api        worker     static assets
           |            |
     +-----+-----+------+
     v           v
  postgres     redis          object storage (S3 / R2, external)
     |
     +-- backup (daily, verified)
```

Only the proxy publishes ports. Postgres and Redis are reachable only on
the internal network.

## First deploy

**1. Secrets.** Copy the template and fill it in:

```bash
cp .env.production.example .env.production
openssl rand -base64 48          # JWT_SECRET
export POSTGRES_PASSWORD="$(openssl rand -base64 32)"
```

`.env.production` is gitignored. Better still, inject these from a secret
manager and never create the file on a developer machine.

The app validates all of this at startup and **refuses to boot** on unsafe
configuration rather than starting insecurely. A failed deploy is a much
better outcome than a running service with a development JWT secret.

**2. Build the frontend.** The proxy serves the built assets directly:

```bash
cd frontend && npm ci && npm run build
```

**3. TLS.** Get certificates before starting the proxy, or nginx fails to
load its config:

```bash
docker compose run --rm certbot certonly --webroot -w /var/www/certbot \
  -d parentos.example --agree-tos -m ops@parentos.example
```

**4. Start.**

```bash
docker compose up -d
docker compose exec api npm run migrate
```

Migrations are run explicitly rather than on container start: two API
instances booting simultaneously would otherwise race, and a migration
failure would look like a crash loop instead of a clear error.

## Operations

```bash
docker compose logs -f api | jq          # structured JSON logs
curl https://parentos.example/api/ready  # readiness
docker compose exec api npm run reconcile  # Stripe vs database check
```

**Monitoring.** `/metrics` exposes Prometheus-format gauges and is
restricted to private networks by the proxy. The ones worth alerting on:

- `parentos_db_pool_waiting` persistently above zero - the pool is
  undersized, and this arrives before users notice slowness.
- `parentos_reconciliation_open_issues` above zero - money is currently
  wrong somewhere and nobody has looked.

**Probes.** `/api/health` is liveness (never touches the database) and
`/api/ready` is readiness (does). Keep them distinct in your orchestrator.
Pointing a *restart* probe at a dependency check is a known outage
amplifier: a brief database blip makes every instance report unhealthy,
the orchestrator kills them all, and a recoverable problem becomes a total
outage. This was tested - stopping Postgres leaves liveness at 200 and
drops readiness to 503, which is what you want.

**Backups.** The `backup` service runs daily into a volume. It verifies
each dump with `pg_restore --list` and refuses to keep one containing no
table data, because a backup that has never been restored is a hypothesis,
not a backup.

Restore drill - do this on a schedule, not just during an incident:

```bash
docker compose exec postgres createdb -U parentos parentos_restore_test
docker compose exec postgres pg_restore \
  -U parentos -d parentos_restore_test /backups/parentos-<timestamp>.dump
```

Copy backups off the host as well. A volume on the same machine does not
survive losing the machine.

## Scaling out

```bash
docker compose up -d --scale api=3
```

Before doing this, note the rate limits use an in-memory store, so N
instances means N times the configured limit. Redis is already a
dependency; wiring `rate-limit-redis` is the remaining step.

## What is still missing

- **Dockerfiles have never been built.** Multi-stage, non-root, and
  healthchecked, but the first `docker compose up` is a real test.
- **No CI/CD.** No automated build, test, or deploy pipeline.
- **No log shipping.** Logs are structured JSON and ready to ship;
  nothing ships them.
- **Single host.** This compose file is one machine. Real availability
  needs managed Postgres with failover, more than one API host, and a load
  balancer that outlives any of them.
- **No staging environment.** Changes would go straight from a laptop to
  production, which is the riskiest possible arrangement for a system
  handling payments.

## Metrics

Metrics are **not** served by the public application. They run on a
separate listener inside the API container, port `9091`, path `/metrics`.

That separation is deliberate. Previously `/metrics` was a route on the
public app protected only by an nginx `allow`/`deny` block, which made one
config line the entire boundary around operational data - including
`parentos_reconciliation_open_issues`, which means "money is currently
wrong and nobody has looked". A mistyped location, a reload that didn't
take, or a direct hit on the container port would have exposed it.

- `METRICS_PORT` (default `9091`)
- `METRICS_HOST` (default `127.0.0.1`; compose sets `0.0.0.0` so other
  containers on the internal network can scrape it)
- `METRICS_TOKEN` (optional bearer token — defence in depth, not the
  primary control; the network boundary is)

The port is under `expose:` in `docker-compose.yml`, never `ports:`, so it
is reachable on the compose network and not published to the host. Point
Prometheus at `api:9091` from within that network.

**Do not** add a `location = /metrics` block back to nginx. There is
nothing behind it, and re-adding one would re-expose the data through the
public server, which is what moving it off the app was for.
