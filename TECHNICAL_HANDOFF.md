# ParentOS / Uusiksi
# Technical Handoff

Written for whoever takes this over next — a technical co-founder, a first
engineering hire, or future-me after time away. It says what exists, what's
verified, and what was deliberately left undone, so nothing here has to be
taken on faith. Where something needs your judgment rather than mine, it's
marked `[REVIEW]`.

See [README.md](README.md) for day-to-day setup, [DEPLOYMENT.md](DEPLOYMENT.md)
for what's been verified in production-like conditions, and
[CHANGELOG.md](CHANGELOG.md) for the round-by-round build history if you
want the reasoning behind a decision, not just the decision.

## 1. Executive Summary

**What the product is.** A curated second-hand marketplace for Finnish
families — think a trust-focused, kids'-gear-first alternative to a generic
classifieds site. Sellers list items, buyers search/browse and message
sellers, checkout is a real payment (not "meet up and pay cash"), and
sellers get paid out via Stripe Connect.

**What has been built.** Not a mockup and not a single stubbed demo — a
working system with three real clients (React web frontend, React Native/
Expo mobile app, and the backend itself) sharing one versioned API
(`/api/v1`) and one PostgreSQL database. Signup with email verification,
login (cookie-based on web, Bearer-token on mobile), listing creation with
real category/subcategory/condition taxonomy, full-text and geo search
(PostGIS), image upload with a quarantine → validate → thumbnail pipeline,
messaging, checkout through real Stripe Connect (test mode), the full
pending → paid → fulfilled → completed order lifecycle, reviews/trust
signals, moderation (reports, blocks, takedowns), notifications (email +
mobile push), a reconciliation job that checks Stripe's view of the world
against the database, and an admin-facing analytics surface. 219 automated
tests, including a real end-to-end run (39 assertions) against a live
Postgres and Stripe's actual SDK talking to a local stripe-mock — not just
mocked unit tests.

**Current stage.** Pre-launch. The application layer is unusually far
along for a pre-revenue project; the business/legal/ops layer is not.
Nothing here has taken a real customer's real payment yet.

**What is intentionally not finished.** No production deployment has ever
been run (Docker/compose config is verified, but nothing is live), no
Finnish company is registered, no lawyer has reviewed the legal drafts, no
production Stripe/S3/Anthropic/SMTP credentials exist, there's no staging
environment, and log shipping/alerting/on-call don't exist yet. Section 9
has the full list.

## 2. Architecture

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

| Layer | Choice | Notes |
|---|---|---|
| Web | React + Vite | `frontend/src`, feature-folder layout (`features/<domain>`), thin `pages/` composing them |
| Mobile | React Native (Expo, TypeScript) | Same backend, `/api/v1`; Bearer JWT instead of cookies; Stripe PaymentSheet needs a dev/EAS build, not Expo Go |
| API | Node + Express | `routes → services → PostgreSQL`, one domain folder per concern (`auth`, `listings`, `images`, `moderation`, `connect`, `reconciliation`, `analytics`, `notifications`, ...) |
| Database | PostgreSQL 16 (+ PostGIS) | 25 sequential migrations, real schema constraints doing real work (see `002_state_invariants.sql`, `012_trust_counters_completed_only.sql`) |
| Queue | BullMQ + Redis | Optional — falls back to running jobs in-process when `REDIS_URL` is unset, so local dev needs no Redis |
| Payments | Stripe + Stripe Connect | Sellers onboard through Connect; checkout is a PaymentIntent; payouts and refunds go through the same account |
| Object storage | Pluggable: S3-compatible or local disk | Unset `S3_*` env vars → images save to `backend/uploads/`, served locally. Set them → real S3/R2/B2/MinIO |
| Email | Pluggable: SMTP or console | Unset `SMTP_*` → verification emails print to the server log instead of sending. Fine for dev, obviously not for real users |
| AI | Anthropic API | `backend/ai` — buyer/seller message assistance, off entirely without `ANTHROPIC_API_KEY` |
| Analytics | PostHog (optional) | Server-side captures only the events that must be authoritative (a checkout actually settling); everything else is client-side |

Everything marked "optional" above is a genuine no-op when unconfigured —
the app runs correctly in dev with zero third-party accounts, and each one
activates independently as you're ready to pay for it.

## 3. Authentication

Two transports, one underlying session model:

- **Web**: httpOnly cookies. A short-lived access cookie + a path-scoped,
  rotating refresh cookie, set together on login (`auth/controller.js`).
  CSRF protection (`middleware/csrf.js`) applies because cookies are
  involved.
- **Mobile**: Bearer JWTs in the response body (`/api/v1/auth/mobile/*`),
  since a native app has no cookie jar. The client (`mobile/src/api/client.ts`)
  dedupes concurrent refreshes behind a single in-flight promise, so two
  401s racing don't each try to rotate the same single-use refresh token
  and spuriously fail one of them. The token pair lives in
  `expo-secure-store` (Keychain/Keystore), not plain `AsyncStorage`.

Both transports share: signup → emailed verification code → verify (dev
mode returns the code directly to the client since there's no inbox to
check locally); refresh tokens are stored server-side and revocable
(`refresh_tokens` table, `017_auth_hardening.sql`, `003_session_versioning.sql`);
logout revokes the presented refresh token; there's a "log out everywhere"
path that ends every other session for the account. Ownership checks are
real throughout — you cannot edit someone else's listing, advance someone
else's sale, or read a thread you're not in (`authzAdversarial.test.js`
exists specifically to keep this true).

## 4. Marketplace

- **Create listing** — real category/subcategory/condition/city/area
  taxonomy (`GET /api/v1/meta/config` backs the pickers on both web and
  mobile, so adding a category is a backend-only change).
- **Browse/search** — full-text search (`004_full_text_search.sql`) and
  geosearch via PostGIS (`008_postgis.sql`, `015_geocoding.sql`).
- **Message seller** — real threads, not per-listing scratch state.
- **Checkout** — a real Stripe PaymentIntent through Connect; a listing is
  reserved (`RESERVATION_TTL_MINUTES`, default 30) so two buyers can't both
  check out the same item — this exact race is covered by
  `concurrency.test.js`.
- **Reservation → Payment → Webhook → Order** — the webhook is what
  actually advances an order's status, not the client's checkout response,
  so a browser closing mid-payment doesn't leave the order stuck; a
  replayed webhook does not double-apply (`stripe-adversarial.test.js`).
- **Completion** — pending → paid → fulfilled → completed, with a full
  transaction-event audit trail (`013_transaction_events.sql`).
- **Seller payout** — via the seller's Connect account once an order
  completes; `COMMISSION_PERCENT` (default 8%) is taken by the platform.

## 5. Images

A three-step pipeline, not a single upload endpoint (`backend/images/routes.js`):

1. **Presign** — the client asks for a place to put the file; the returned
   key is a quarantine key, not a public one.
2. **Upload** — the client uploads directly to that quarantine location.
3. **Finalize** — the server downloads it back, validates it's really an
   image, strips EXIF (which can carry GPS coordinates — a real concern
   when photos are taken inside people's homes), re-encodes it with
   **Sharp**, generates a thumbnail (`023_photo_thumbnails.sql`,
   `services/thumbnailService.js`), and only then promotes it out of
   quarantine to a public key.

Thumbnail generation is best-effort: a failure there degrades to "no
thumbnail" rather than failing the whole upload (`imageQueue.test.js`
covers the queue-state side of this). `018_upload_ownership.sql` ensures a
finalized upload is tied to the account that requested it — another
account can't finalize your presigned key.

## 6. Infrastructure

- **Docker** — every service (`api`, `worker`, `frontend` build) has a
  Dockerfile; `docker-compose.yml` wires them together for a real
  single-host deploy, `docker-compose.local.yml`/`.ci.yml` for dev/CI
  variants.
- **Postgres** — the system of record; not exposed outside the compose
  network.
- **Redis** — backs BullMQ and, when set, distributed rate limiting
  (`rate-limit-redis`) so scaling `api` to N instances shares one rate-limit
  count instead of granting N× the limit. Not exposed outside the network.
- **Worker** — a separate process (`worker.js`, own Dockerfile) running the
  BullMQ queue (thumbnailing, notifications, etc.) so a slow job can't block
  API request handling.
- **Nginx** — TLS termination, serves the built SPA, proxies `/api`, and is
  the only thing with a published port.
- **Backups** — daily, into a volume, verified with `pg_restore --list`
  (refuses to count a dump with no table data as successful), with an
  optional offsite copy to S3-compatible storage via a separate bucket/
  credentials from the one used for listing photos.
- **Metrics** — Prometheus-format gauges on a *separate* internal listener
  (port 9091), deliberately not a route on the public app, after an earlier
  version made one nginx config line the entire boundary around
  operationally sensitive data.
- **Health/readiness** — `/api/health` (liveness, never touches the
  database) is intentionally separate from `/api/ready` (readiness, does).
  Verified behavior during an actual Postgres outage: liveness stays 200,
  readiness drops to 503 — a restart probe pointed at readiness instead of
  liveness would have turned one database blip into a total outage by
  killing every instance at once.

**Verified**, per `DEPLOYMENT.md`: nginx config, backup+restore round-trip,
startup config validation (refuses to boot on unsafe config), liveness/
readiness/metrics behavior including during a real DB outage, that
Dockerfiles/compose actually build and boot (CI does this on every push),
and the offsite backup copy path (success and failure).

## 7. Testing

- **Backend** — Jest + Supertest, 219 tests, against a **real** Postgres
  database (`parentos_test`), not mocks — several bugs this project hit
  were concurrency/constraint issues mocks would have hidden. Covers auth,
  authorization (including adversarial cases), listings, search/geosearch,
  uploads/image queue, messaging, transactions/lifecycle, moderation,
  reviews/trust, notifications/push, reconciliation, rate limiting, and
  general security hardening (see the file list in `backend/tests/`).
- **Frontend** — component/unit tests under `frontend/src` (e.g.
  `i18n/errorMessages.test.js`), plus a build check.
- **Mobile** — Jest (`jest-expo` preset) for notification routing and the
  token-refresh dedup logic; `tsc --noEmit` and `expo export --platform ios`
  as no-simulator-needed build checks.
- **Docker/Compose** — CI builds and boots the actual images and the full
  compose stack on every push (not just unit tests in isolation).
- **End-to-end** — `npm run e2e`: 39 assertions, a real Express process,
  real HTTP, real Postgres, the real Stripe SDK against a local stripe-mock
  speaking Stripe's actual wire protocol (only the far end — Stripe's own
  servers — is faked). Verified to actually catch regressions, not just
  pass: deliberately broke the settlement transition once and confirmed it
  produced 10 cascading failures rather than silently passing.
- **Not covered by any of this**: a wrong live API version, bad key
  permissions, or a mismatched webhook secret against the *real* Stripe —
  no local fake can catch those; only a real Stripe test-mode run can.

`npm run verify` from the repo root runs all of the above in one pass
(migrate, lint, full test suite, frontend build, smoke test) and is the
single source of truth for "does this pass."

## 8. Security

- **Authentication** — see Section 3: httpOnly cookies + CSRF for web,
  Bearer JWT + secure storage for mobile, rotating/revocable refresh
  tokens, server-side session versioning.
- **Authorization** — ownership checks on every mutating route, actively
  tested against adversarial cases (`authzAdversarial.test.js`), not just
  the happy path.
- **CSRF** — `middleware/csrf.js`, applied to the cookie-authenticated web
  routes.
- **Rate limiting** — `express-rate-limit`, Redis-backed
  (`rate-limit-redis`) when `REDIS_URL` is set so it works correctly across
  multiple API instances; falls back to in-memory (per-instance, so less
  effective) otherwise (`rateLimit.test.js`).
- **Upload security** — quarantine-first, server-side re-validation and
  re-encoding (not trusting client-supplied file content), EXIF stripped,
  ownership-checked finalize (Section 5).
- **Payment security** — webhook signature verification is real (a forged
  signature is rejected — tested), `STRIPE_API_HOST` override throws in
  production so test tooling can never accidentally point at live traffic,
  idempotency handled at the webhook level so a replay doesn't double-apply.
- **Secrets** — `configCheck.js` validates configuration at startup and
  **refuses to boot** on unsafe config (e.g. a default/dev JWT secret in
  production) rather than starting insecurely. `.env.production` is
  gitignored; the README recommends injecting secrets from a secret manager
  rather than ever creating that file on a developer machine.
- **Data protection** — EXIF/location stripped from photos; account
  deletion anonymizes rather than hard-deletes, to satisfy Finnish
  accounting-record retention (Kirjanpitolaki, commonly 6 years) —
  see `backend/services/privacyService.js` and `/api/privacy/export`.

`security.test.js`, `hardening.test.js`, and `stripe-adversarial.test.js`
exist specifically to keep adversarial cases honest as the code changes,
rather than relying on this list staying accurate by memory.

## 9. Known Gaps

Stated directly rather than discovered the hard way:

- **Never deployed.** CI builds and boots every image and the full compose
  stack on every push, but nothing has ever pushed an image to a registry
  or run this in front of a real user. "CI passed" → "running in
  production" is still a manual, unverified step.
- **No staging environment.** Today, a change goes from a laptop straight
  to production — the riskiest possible setup for something handling
  payments.
- **Single host.** `docker-compose.yml` describes one machine. Real
  availability needs managed Postgres with failover, more than one API
  host, and a load balancer that outlives any single instance.
- **No log shipping.** Logs are structured JSON and ready to ship; nothing
  ships them anywhere yet, so there's no way to search past logs after an
  incident.
- **No production third-party accounts.** Stripe, S3/R2, SMTP, Anthropic,
  and PostHog are all wired to real APIs but currently only exercised in
  test mode / dev fallback. Every one of these needs a live account
  (several needing the registered company first — see the launch doc).
- **No legal review.** The `legal/` drafts are structurally complete and
  technically accurate to the code, but explicitly not legal advice —
  `[REVIEW]`/`[FILL IN]` markers throughout need a Finnish lawyer.
- **Mobile**: no dedicated listing detail screen (an action sheet
  substitutes), and the Sell form doesn't collect a photo yet (existing
  photo-bearing listings, e.g. from web, still render correctly).
- **Real-Stripe-only failure modes untested**: a wrong live API version,
  bad live key permissions, or a mismatched live webhook secret — the local
  stripe-mock can't produce these, only a real Stripe test-mode dry run can
  surface them before launch.

## 10. Technical Decisions

- **Why a modular monolith, not microservices** — one Express app,
  organized into domain folders (`routes → services → PostgreSQL`), not
  separately deployed services. At this scale, one codebase and one
  deploy unit is strictly less operational overhead than a distributed
  system, with none of the current benefits (independent scaling,
  independent deploys) actually needed yet.
- **Why PostgreSQL** — one relational store for users, listings, orders,
  messages, and trust data, with real constraints doing real work (see
  `002_state_invariants.sql`) instead of application code trying to
  maintain invariants by convention. PostGIS gives geosearch for free
  without a second search system.
- **Why Redis (optional, not required)** — needed for two things that
  genuinely require shared state across instances: the job queue and
  distributed rate limiting. Both degrade gracefully (in-process queue,
  per-instance rate limiting) without it, so a single-instance dev setup
  needs zero extra infrastructure.
- **Why Stripe Connect** — handles seller KYC, escrow-style holds, and
  payouts, and is explicitly structured to keep the platform out of
  licensed payment-institution territory (though whether that holds for
  this exact flow is a legal question, not a technical one — see
  `legal/README.md`).
- **Why Expo (mobile)** — a single TypeScript codebase for iOS and Android,
  with a clear, documented escape hatch (a custom dev/EAS build) for the
  one thing Expo Go can't do — the Stripe native module.
- **Why one API for web and mobile** — no separate mobile backend to drift
  out of sync; the same versioned `/api/v1` serves both, differing only in
  how the session is carried (cookie vs. Bearer token).

## 11. CTO Questions

Worth deciding together early, since they shape what comes next more than
any code decision does:

- **What should change?** Candidates, in rough order of urgency: get a
  real deployment running (even a single host) before anything else,
  because nothing after this list matters until the app is actually live
  somewhere; add log shipping and basic alerting before real users exist,
  not after an incident makes the need obvious.
- **What should not change?** The core architectural bets — one Postgres-
  backed monolith, optional/degradable third-party integrations, real-
  database testing over mocks — have held up under a genuinely adversarial
  test suite. Don't re-architect these without a concrete scaling problem
  they're causing.
- **What should be built next?** Depends on what "next" optimizes for:
  closing the mobile gaps (listing detail, photo upload) to reach feature
  parity with web, vs. spending that time on the deploy/staging/monitoring
  gap that blocks going live at all. `[REVIEW]` — this is a product/
  business call as much as an engineering one.
- **What breaks at 1,000 users?** Probably nothing architecturally — this
  is well within a single well-tuned Postgres instance and one API host.
  The likely failure mode is operational (no staging, no monitoring, no
  on-call) rather than a code failure.
- **What breaks at 100,000 users?** Single-host compose stops being
  viable; Postgres needs managed failover and likely read replicas;
  the in-process/single-Redis queue and rate-limit setup need to be
  confirmed as still correctly shared across many more API instances;
  image storage and CDN delivery need real capacity planning. None of this
  needs to be built now — the schema and service-layer separation
  (`services/` owns all business logic, routes are thin) mean this is a
  scaling exercise, not a rewrite.

## Things I deliberately did NOT build

Not oversights — conscious tradeoffs for a pre-revenue marketplace that
doesn't yet have a single real customer:

- Kubernetes — one Docker Compose file on one host is the right amount of
  orchestration for the current scale.
- Microservices — see Section 10; one modular monolith, not several
  independently deployed services.
- A distributed search engine (Elasticsearch, etc.) — Postgres full-text
  search + PostGIS covers today's search and geosearch needs.
- A recommendation engine — no personalization/ranking system exists;
  browse and search are direct queries, not a ranking model.
- Multi-region infrastructure — one region, one host, one database.
- A complex event-streaming architecture (Kafka, etc.) — BullMQ + Redis (or
  in-process, without Redis) is enough for today's background-job volume.
- An elaborate caching layer — no Redis/CDN caching of application data
  beyond what's structurally needed (rate-limit counters, job queue).

Each of these is a real, well-understood thing to add later, at the point
the system actually needs it — not before.
