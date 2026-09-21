# ParentOS / Uusiksi - Development Log

Round-by-round history of what was built, broken, and fixed. See
[README.md](README.md) for current setup instructions and
[DEPLOYMENT.md](DEPLOYMENT.md) for deployment status.

## Quick start (for reviewers)

Requires **Node 18+** and **PostgreSQL 16**. From the repository root:

```bash
npm run setup     # installs both workspaces, creates backend/.env, checks Postgres
npm run migrate   # applies all migrations to an empty database
npm test          # 402 tests
```

`npm run verify` runs migrate, tests, both lints and the frontend build in
one pass.

`npm run setup` fails with an actionable message if Node is too old, if
`backend/.env` is missing, or if Postgres isn't running - rather than
letting the suite die on a connection error that doesn't say what to fix.

The suite needs a running PostgreSQL: it deliberately tests against a real
database rather than mocks, because several of the bugs found in this
project were concurrency and constraint issues that mocks would have
hidden. It manages its own `parentos_test` schema.


```
ParentOS
├── frontend   (React + Vite)
├── backend    (Node + Express, layered into routes → services → PostgreSQL;
│               database/ - schema migrations + seed data - lives here)
├── mobile     (React Native / Expo - same backend, /api/v1)
└── deploy     (nginx config for the production compose stack)
```

This replaces the earlier single-file Claude.ai artifact prototype with a
proper local dev setup you can open in VS Code, extend, and eventually
deploy. The artifact version still exists as a backup for quick, no-setup
demos - this project is for real development.

## Forty-third round: CI failures on frontend (jsdom/Node 20) and compose (Redis boot crash)

Two independent CI breakages, caught and fixed in the same pass.

**Frontend**: `jsdom` had resolved to `30.0.1`, which requires Node
`^22.22.2 || ^24.15.0 || >=26.0.0` - CI pins Node 20, so `npm test` failed
outright (`TypeError: webidl.util.markAsUncloneable is not a function`,
from undici's newer Web API surface that Node 20 doesn't have). Pinned to
`jsdom@27.0.0`, the newest version confirmed compatible with Node 20;
verified 24/24 tests passing via a clean `npm ci` under `node:20`.

**Compose**: `middleware/rateLimit.js`'s `ioredis` client paired
`lazyConnect: true` with `enableOfflineQueue: false`. `RedisStore`'s
constructor fires two `SCRIPT LOAD` commands immediately to warm its Lua
scripts, before a lazyConnect'd client has actually connected - with the
offline queue disabled, ioredis rejects that first command outright
instead of queueing it (`"Stream isn't writeable and enableOfflineQueue
options is false"`), crashing the app with an unhandled rejection on
every single boot with `REDIS_URL` set. Only the `compose` CI job
actually boots the app that way, which is why the mocked rate-limit tests
missed it. Removed `enableOfflineQueue: false`; added a regression test
asserting on the actual ioredis constructor options, and verified the fix
for real by building the API image and running the full stack (migrate,
smoke test, 12-step purchase journey) against a live Postgres/Redis/
fake-Stripe compose stack.

## Forty-second round: a round of code review findings, closed out

- **Image-processing queue state** - the worker now completes the
  uploads state transition itself (`uploaded` → `processed`/`failed`)
  after queued image processing, instead of leaving rows stuck as
  `uploaded` forever once a public image already existed.
- **Quarantine cleanup** - split storage's `deleteImage(url)` from a new
  `deleteObject(key)`, fixing quarantine-object cleanup (abandoned
  uploads, rejected images) that was silently no-op'ing because it was
  passing raw storage keys to a URL-only function.
- **Reconciliation pagination** - reverse reconciliation
  (`findOrphanedPaymentIntents`) now paginates through Stripe's
  PaymentIntent list instead of only inspecting the first page, so a
  lookback window with >100 PaymentIntents no longer leaves the rest
  uninspected.
- **Mobile secure storage** - access/refresh tokens move from
  `AsyncStorage` to `expo-secure-store` (iOS Keychain / Android
  Keystore), with a one-time migration for any session already
  persisted under the old key.
- **CI coverage** - added a mobile job (`tsc` + `jest`) and wired
  `npm test` into the frontend job - both test suites existed but
  neither actually ran in CI before this.
- **Redis-backed rate limiting** - rate limiting is now backed by
  `rate-limit-redis` whenever `REDIS_URL` is set (already true for
  `docker-compose.yml`'s `api` service), so horizontally scaled
  instances share one count instead of each granting the full
  configured allowance independently.
- Refreshed `mobile/README.md` and stale source comments for the now-
  unified repo layout; added a dedicated adversarial authorization test
  suite (`authzAdversarial.test.js`) covering cross-owner listing
  mutations, admin-only route rejection, cross-user conversation state,
  and token revocation on account deletion.

## Forty-first round: the Uusiksi mobile app joins the unified repo

Brings the mobile client into the same repo as the backend and web
frontend it actually talks to, rather than living in a separate history
with its own bespoke backend. React Native (Expo, TypeScript); includes
marketplace browsing, messaging, Stripe Connect checkout with Apple Pay/
Google Pay, push notifications, and a Jest test suite (notification
routing, token-refresh dedup logic). Points at the versioned `/api/v1`
backend API landed in the previous round - not a coincidence, the two
were built together so the mobile client never had to speak to an
unversioned or web-only API surface.

## Fortieth round: versioning the API, and real frontend test coverage

Introduces a single `API_PREFIX` (`/api/v1`) so mobile and web clients
can pin to a specific API version instead of "whatever `/api` currently
means" as more clients ship (per OWASP API9:2023, improper inventory/
version management). Every route, every test, and every script
(`e2e.js`, `journey.js`, `smoke-stripe.js`) moved onto the prefix
together, not left half-migrated.

Also the frontend's first real automated test coverage - Vitest + React
Testing Library: error-message translation (`i18n/errorMessages.test.js`),
the favorites hook, the marketplace config hook, and the cookie consent
banner. Alongside this, 14 duplicated `createListing`/`createVerifiedUser`
test helpers scattered across the backend suite were consolidated into
shared, fail-loudly helpers in `tests/helpers.js`.

## Thirty-ninth round: thumbnails, push notifications, SEO rendering, product analytics, cookie consent, subcategories

The largest single round to date (103 files) - not one feature but
several independent P2/P3 items landing together:

- **Photo thumbnails** (`023_photo_thumbnails.sql`, `thumbnailService.js`)
  - generated during the existing image-processing pipeline, not a
  separate job; a thumbnail-generation failure degrades to "no
  thumbnail" rather than failing the whole upload.
- **Push notifications** (`024_push_tokens.sql`, `services/pushService.js`,
  `push.test.js`) - sent through Expo's push service, which needs no API
  key or account at this volume. Token format is validated
  (`Expo(nent)?PushToken[...]`) before it's ever stored, and upserts are
  keyed on the token itself, not `(user_id, token)`, since the same
  physical device can end up registered to a different account after a
  sign-out/back-in.
- **Server-side SEO rendering** (`backend/seo/render.js`, `seo/routes.js`,
  `seo.test.js`) - injects real per-listing `<title>`/description/Open
  Graph tags into the built SPA's `index.html` for crawlers and
  link-preview bots (Googlebot, Slackbot, WhatsApp, iMessage, Twitter/X,
  Facebook) that don't execute JavaScript and would otherwise only ever
  see the static "Uusiksi - ParentOS" shell every page shares. A real
  browser gets the identical HTML - the SPA's own script tag is
  untouched, so it boots and client-side-renders normally either way.
  Cached on the built file's mtime, not re-read per request, so a
  listing going viral doesn't mean `stat()`-ing disk on every hit.
- **Product analytics via PostHog** (`services/productAnalyticsService.js`,
  `frontend/src/productAnalytics.js`, `productAnalytics.test.js`) -
  deliberately separate from `services/analyticsService.js`, which serves
  operational dashboards (seller stats, platform totals) back into the
  app's own UI. This instead answers "where do people drop off between
  signing up and their first sale?". Server-side captures only the one
  event that must be authoritative - a checkout actually settling, per
  Stripe's webhook - since a client-side "payment succeeded" event would
  fire (or fail to) based on whether the buyer's tab was still open, not
  on what actually happened to their money. Everything upstream of that
  (viewed a listing, started checkout) is captured client-side. A no-op
  whenever `POSTHOG_API_KEY` is unset, same pattern as `errorTracking.js`.
- **Cookie consent banner** (`components/ui/CookieConsent.jsx`) - renders
  nothing at all when analytics isn't configured; when it is, nothing is
  captured until Accept is pressed (`opt_out_capturing_by_default: true`)
  - opt-in, not opt-out-with-a-banner-that-doesn't-actually-block-anything.
- **Listing subcategories** (`021_listing_subcategories.sql`,
  `subcategoryVocabulary.test.js`) - Stage 1 of a category redesign
  (Clothes > Baby/Girls/Outerwear, Accessories > Shoes/Hats, ...), added
  as one nullable column scoped to the existing three top-level
  categories rather than building a richer menu the backend couldn't yet
  validate, which would let the UI offer combinations that don't exist as
  data. Nullable rather than backfilled: no subcategory value is more
  correct than another for listings that predate the column.
- **Automated, verified backups** (`scripts/backup.sh`) - guards against
  the classic failure mode (a backup job that's "succeeded" nightly for a
  year, never restored, and turns out empty or truncated the day it's
  needed) by verifying each dump after writing it rather than trusting
  `pg_dump`'s exit code alone. Exits non-zero on any failure so a
  scheduler can actually alert on it.
- Plus: production nginx config (`deploy/nginx/parentos.conf`), a real
  hero image replacing a placeholder, and assorted i18n/UI polish.

## Thirty-eighth round: a real end-to-end test

`npm run e2e` - 39 assertions covering signup, email verification, session
refresh, listing, search, geosearch, image upload, messaging, Connect
onboarding, checkout, webhook, fulfilment, receipt, review, trust, audit
trail, webhook replay, data export and account deletion.

**Everything is real except Stripe's servers.** A real Express process over
real HTTP, a real PostgreSQL database, the real Stripe SDK, and webhook
signatures generated with Stripe's own HMAC scheme so the server's actual
signature verification runs. Only the far end of the Stripe connection is a
local fake.

That distinction is the point. The Jest suite mocks the `stripe` module,
which means the SDK never executes - request shapes, form encoding,
idempotency headers, response parsing and error handling all go untested.
Here the SDK does its real work against a stub that speaks the wire
protocol. `stripeClient` gained an optional `STRIPE_API_HOST`, which is how
`stripe-mock` is normally used, and which **throws in production** rather
than letting live payment traffic be pointed at a non-Stripe host.

**Verified the test can fail.** A test that has never failed is a claim,
not evidence. My first attempt at sabotage was ineffective - I changed a
return value that ran *after* the status update, so the order still settled
and the suite still passed. Changing the actual settlement transition
produced 10 cascading failures, which is the behaviour a real regression
would produce.

Notable assertions beyond the happy path: a forged webhook signature is
rejected, another user cannot finalize someone else's upload, checkout is
blocked before Connect onboarding, a replayed webhook does not change a
completed order, and a seller **with a sold listing** can delete their
account - the case that was broken three rounds ago and that the unit
tests had missed entirely.

Now part of `npm run verify`.

**Still not covered:** a wrong API version, bad key permissions, or a
mismatched webhook secret at real Stripe. No local fake can catch those -
`npm run journey` against `sk_test_` keys remains the only thing that will.

## Thirty-seventh round: metrics off the public application

`/metrics` was a route on the public app, protected only by an nginx
`allow`/`deny` block. That made one config line the entire boundary around
operational data - and `parentos_reconciliation_open_issues` in particular
means "money is currently wrong here and nobody has looked", which is not a
number to leave one mistyped `location` away from the internet. A reload
that didn't take, or a direct hit on the container port, would have exposed
it too.

Took the reviewer's preferred option: removed it from the application
entirely rather than adding auth to it. Metrics now run on their own
listener (`metrics.js`, port 9091), bound to `127.0.0.1` by default so
nothing off-host can reach it even if a port were accidentally published.
Compose sets `METRICS_HOST=0.0.0.0` and lists the port under `expose:`,
never `ports:`, so it is reachable on the internal network and nowhere
else. An optional `METRICS_TOKEN` adds bearer auth as defence in depth -
explicitly not the primary control, since the network boundary is.

The nginx `location = /metrics` block is gone: there is nothing behind it
now, and leaving it would imply the endpoint is still reachable through the
public server.

Verified both halves live: the public app returns **404** for `/metrics`
while the internal listener serves the gauges, and with a token configured
it returns 401 for no token, a wrong token, and a wrong-*length* token -
that last one because `timingSafeEqual` throws on mismatched lengths, so
the length check has to come first rather than leaking through an
exception.

Guarded against regression in four places: the public app must 404, no
`app.get("/metrics")` may exist in `server.js`, nginx must not proxy it,
and the compose file must not publish 9091 under `ports:`. `npm run verify`
now smoke-tests the 404 as well.

An existing test asserted `/metrics` returned 200 on the public app -
exactly the behaviour that is now wrong. Replaced rather than adapted.

339 → 345 tests.

## Thirty-seventh round: the UI claimed a confirmation the server never made

A review pointed out that `Checkout.jsx` treated
`paymentIntent.status === "succeeded"` from the Stripe client as the order
being confirmed. But the backend's authoritative state comes from the
webhook, so the two can diverge: Stripe accepts the card, the browser says
"Order confirmed", the webhook is delayed or fails, and the backend still
has the order as `pending`.

The payment succeeding and the *order* transitioning are different facts.
The UI was reporting the second on evidence for the first.

**Split them.** Stripe accepting the card now shows "Payment received".
The client then polls a new `GET /api/transactions/:id/status` until the
backend reports the order settled, and only then says "Order confirmed".

The endpoint is purpose-built for polling: small (id, status, `settled`,
`paidAt`) rather than the full order, and restricted to the buyer and
seller - it's polled, so it must not become a way to enumerate other
people's orders by walking ids. `settled` means "the server has finished
deciding", so a cancelled or refunded order counts too; the client is
asking whether to stop waiting, not whether it succeeded.

**The timeout case is where the honesty matters.** Polling gives up after
30 seconds and says the payment went through but the order is still
confirming, rather than spinning indefinitely or asserting a confirmation
that never arrived. The money is taken either way - what is unconfirmed is
the order transition, and saying exactly that is more useful than a
spinner. A failed poll is explicitly not treated as evidence the order
failed.

339 → 351 tests.

## Thirty-sixth round: monitoring the distributed checkout window

A review noted that checkout spans Postgres, then Stripe, then Postgres
again, with cleanup rather than atomicity covering the gap - and that this
is probably acceptable for an MVP **with strong monitoring**, but should be
redesigned around explicit checkout attempts before scale.

I took that framing literally rather than rushing the redesign, and
checking the monitoring found a real hole.

**Reconciliation was blind in exactly the direction that matters.** It
walked transactions and asked Stripe about each one, so it could only find
problems with rows that EXIST. A PaymentIntent created during checkout
whose transaction row was never written has nothing to walk from - which
is precisely the failure this design produces. Money authorized at Stripe
that the database has never heard of, and nothing looking for it.

Added a reverse pass (Stripe → database) that reports
`orphaned_payment_intent`, folded into the same job so there aren't two
schedules to remember. Read-only like the forward pass: an orphan can also
be a deploy in progress or a test key pointed at the wrong database, and
cancelling on that guess could destroy a legitimate in-flight payment.
Abandoned checkouts (`requires_payment_method`, `canceled`) are ignored -
no money is at stake and flagging them would bury the real cases.

Migration 019 needed its own index for this: `transaction_id` is NULL for
an orphan, and NULL is never equal to NULL in SQL, so the existing unique
index would have let every pass insert another copy of the same orphan.
There's a test for that specifically.

**The window is now measured, not assumed.** `checkout_window_closed` on
success and `checkout_window_failed` on the failure path, both carrying
`windowMs`. Without a success baseline the failure logs have nothing to be
compared against, and "how exposed are we?" stays a matter of opinion.

**The redesign is written down with triggers** rather than left as an
intention - see "Planned redesign: explicit checkout attempts". Doing it
now would be building for load nobody has measured; the instrumentation
exists so that call gets made on evidence.

334 → 339 tests.

## Thirty-fifth round: account deletion was broken, and Express didn't trust nginx

**Account deletion failed outright for any seller who had sold something.**
The anonymization set `area = NULL`, but `city`, `area` and `pincode` are
`NOT NULL`, so the whole deletion transaction aborted. A seller with a
single sold listing could not delete their account at all - a GDPR Article
17 request the system was structurally incapable of honouring.

The bug survived because my deletion tests only ever deleted **buyers**.
Reproduced it directly before fixing, then fixed it by overwriting rather
than nulling. That also closed a second problem the reviewer spotted:
`city` and `pincode` weren't being cleared at all, so a deleted user's
neighbourhood and postcode remained attached to a listing that is supposed
to be anonymized. Three tests now cover it, including an invariant across
every deleted user in the suite.

**Express didn't trust the proxy.** nginx sets `X-Forwarded-For`, but
without `app.set("trust proxy", ...)` `req.ip` is the nginx container's
address for every request. That quietly breaks four things at once: per-IP
rate limits collapse into one shared bucket for the entire user population
(so a handful of failed logins anywhere locks out everyone), login history
records the proxy, suspicious-login detection compares proxy to proxy and
never fires, and password-reset requests all attribute to one address.

Set to a **hop count**, not `true`, and demonstrated why:

| setting | forged `X-Forwarded-For: 1.1.1.1, 2.2.2.2, 203.0.113.7` |
|---|---|
| unset | `127.0.0.1` — the proxy, the bug |
| `1` | `203.0.113.7` — the address nginx appended |
| `true` | `1.1.1.1` — attacker's choice, straight through the limits |

`true` would let a client spoof its own IP by sending the header itself.
Production-only, since trusting a header nobody sets in development is the
same hole with no upside, and configurable via `TRUSTED_PROXY_HOPS` for
anyone putting a CDN in front.

**Three smaller fixes.** The frontend Dockerfile set `VITE_API_BASE` while
the app reads `VITE_API_URL`, so a custom API URL at build time was
silently ignored - now aligned, with a test that derives the expected name
from the source rather than hardcoding it. The cookie policy still
described a 30-day token and claimed refresh rotation "not yet the
default"; it now documents both cookies accurately, including what a
forced sign-out means for the reader. And the brand name is centralized in
`config.BRAND` rather than scattered as literals: "Uusiksi" is the
consumer brand, "ParentOS" the project, which is a deliberate split but was
being carried by hardcoded strings that renaming would have missed.

326 → 334 tests.

## Thirty-fourth round: the double-refund path, Scenario C, journey in CI

Re-review of the previous round's items. Verified rather than assumed:
the 30-day JWT is gone and login issues both halves of the session, so #3
was complete. Two genuine gaps remained.

**A real double-refund path.** Scenario C - refund succeeds at Stripe, the
database transition that records it fails - was the one adversarial case I
had not covered, and covering it found a bug.

The late-payment refund in the webhook handler called
`stripe.refunds.create()` with **no idempotency key**, and the surrounding
`catch` swallowed transition failures. So: refund fires, `transitionOrder`
fails, the order keeps its old status, Stripe retries the same event
(delivery is at-least-once, so retries are expected rather than
exceptional), the handler sees `needs-refund` again - and the buyer is
refunded twice. Real money, silently.

Now keyed on the transaction id, so a retry returns the original refund
instead of creating another. Three tests cover it, including a structural
one asserting **every** `refunds.create` in the codebase passes a key, so a
new call site cannot quietly omit one. That check initially produced a
false positive on correct code - the moderation saga passes its key via a
variable rather than inline - so it now inspects a window around the call
rather than only inside the parentheses. Confirmed it genuinely fails when
a key is removed, rather than passing vacuously.

Removing that path also surfaced `refundForModeration` as dead code,
superseded by the moderation saga several rounds ago - 64 lines that
refunded money without an idempotency key and had no callers.

**The full journey now runs in CI.** The compose job previously only
smoke-tested endpoints, which proves containers start, not that a user
journey survives them. It now runs `npm run journey` inside the API
container against the composed Postgres and Redis, accepting exit code 2
(stopped at the Stripe step for want of keys) as distinct from failure.

That required a fix: the journey depended on `devCode`, which is only
returned when `NODE_ENV !== "production"`. Inside the container it is
absent and the real code went to an inbox the script cannot read - and the
stored code is bcrypt-hashed, so it cannot be recovered either. Local mode
now verifies the account directly, the same deliberate shortcut already
used for Connect onboarding, and never in real mode where verification is
part of what is being tested.

**Still not validated locally:** nginx and certbot, which need real
certificates and a real domain. Testing them against neither would be
testing a fiction, so they remain excluded from the CI stack and need a
staging host.

323 → 326 tests.

## Thirty-third round: finishing the auth migration, adversarial Stripe tests

**The session model now matches the schema.** `refresh_tokens`, families,
rotation and replay detection existed in the database and in
`tokenService`, while login still issued a single 30-day JWT - the
architecture and the behaviour disagreed, so none of the hardening was
actually in effect.

Login and verification now issue both halves: a 15-minute access cookie and
a path-scoped rotating refresh cookie, with `POST /api/auth/refresh` to
exchange them. The frontend refreshes transparently on a 401, sharing one
in-flight promise - concurrent refreshes would race to rotate the same
token, and the loser would be treated as a replay, revoking the family and
logging the user out. The security mechanism firing on its own client.

Logout now **revokes** the refresh token server-side rather than only
clearing the cookie: a credential the browser forgets is still valid to
anyone who captured it. Logout-everywhere revokes all refresh tokens, since
`session_version` alone only invalidates access tokens - without that,
every other device could simply refresh its way back in, making it a
15-minute inconvenience rather than a logout.

**Two bugs surfaced from wiring it together.** Scoping the refresh cookie to
`/api/auth/refresh` meant logout never received it and so could not revoke
it - widened to `/api/auth`, which still keeps the long-lived credential
off ordinary API requests. And the two token issuers had drifted on claim
names: `authService` signed `sv` while `tokenService` signed
`session_version`, so every token minted by the refresh path failed
authentication. There is now one signer, plus a test asserting tokens from
both paths are interchangeable.

**Adversarial Stripe scenarios**, all seven now covered:

- **Stripe succeeds, our write fails** - the PaymentIntent is cancelled and
  the listing released rather than left reserved with money committed.
  Triggered by a genuine unique-index collision rather than by mocking the
  transaction helper, since a test that mocks the thing it's exercising
  proves little.
- **Webhook arrives after the reservation sweep** - the order either settles
  or is refunded; money is never silently kept against a `pending` row.
- **Five concurrent deliveries of the same webhook** - settles exactly once,
  one audit event, no spurious refund. At-least-once delivery is normal;
  double-settling is not.
- **`payment_failed` after `payment_succeeded`** - a stale failure does not
  reverse captured money. Stripe does not guarantee ordering.
- **Seller's Connect account disabled** - checkout is refused, and an
  already-paid buyer still has the dispute route, so captured money has a
  way back.

**Docker: still not validated locally, now validated in CI.** No Docker
daemon here, so rather than claim otherwise, CI brings up Postgres, Redis
and the API from the real compose file, waits for health, runs migrations
inside the container, runs them again to prove idempotence, and smoke-tests
through the running stack. Writing that caught a mistake of its own: the
job wrote `.env` when the api service reads `.env.production`, which would
have produced a container with no configuration.

nginx and certbot are deliberately excluded - they need real certificates
and a real domain, and testing them against neither would be testing a
fiction.

308 → 323 tests.

## Thirty-second round: two critical auth bugs

**Password-reset tokens weren't actually single-use.** The flow read the
token, checked `used_at` and expiry in JavaScript, changed the password,
and only then marked the token used. Two requests with the same token both
read it as unused and both proceeded - so "single-use" held only when
nobody raced it, which is precisely the condition an attacker holding a
leaked token would not respect.

The claim is now `UPDATE ... WHERE used_at IS NULL AND expires_at > now()
RETURNING *`, so the database is the arbiter: the first statement flips
`used_at`, every other matches zero rows, and only the request holding the
returned row continues. Claim, password change and burning any other
outstanding tokens all happen in one transaction - a claim that committed
separately from a failed password update would leave the user with a burned
token and an unchanged password, locked out by the mechanism meant to let
them back in.

**A test that proved nothing.** My first regression test called
`resetPassword()` ten times concurrently and passed - but it also passed
with the bug deliberately reintroduced. `bcryptjs` is pure JavaScript and
blocks the event loop, so ten calls in one process serialize on hashing and
never interleave. The race is real in production, where requests span
multiple instances and connections.

The test now races the claim across parallel database connections, which is
the shape production actually has. Verified both directions: the naive
read-then-write lets **two** winners through, the atomic claim allows
exactly **one**.

**Direct-upload keys weren't tied to their uploader.** The presign flow
issued `quarantine/<uuid>.upload` and both the PUT and finalize endpoints
checked only that the key started with `quarantine/`. Any authenticated
user holding a key could write to it or finalize it. A UUID is unguessable,
but unguessable is not authorized - keys travel through logs, browser
history, proxies and error reports, and any of those turns "hard to guess"
into "known".

Migration 018 adds an `uploads` table naming the user each key was issued
to, and both later steps verify ownership. A key belonging to someone else
returns **404, not 403**: confirming that a key exists but isn't yours is
exactly what someone probing keys wants to learn. The table also gives
abandoned uploads somewhere to be found - previously an unused presign left
an orphaned object with nothing recording it existed - so `sweepAbandoned`
can now clean them up.

296 → 308 tests.

## Thirty-first round: CORS mismatch, checkout atomicity, production config

**A silent production-breaking bug.** `server.js` read `ALLOWED_ORIGINS`
while `configCheck.js` validated `CORS_ORIGINS`. In production that
combination is worse than no check at all: you set `CORS_ORIGINS`, startup
validation reports everything fine, and the server ignores it and falls
back to `http://localhost:5173` - so the real frontend is CORS-blocked
while the config check says the config is correct.

Resolution now lives in one place (`config.resolveCorsOrigins`), used by
both the server and the check, so they cannot disagree. `CORS_ORIGINS` is
canonical; `ALLOWED_ORIGINS` still works but warns as deprecated. Falling
back to the dev default is a startup **error** in production, since a
server that starts and then blocks its own frontend is the failure mode
this is meant to prevent.

**Checkout is now atomic.** The transaction row and its first audit event
were two independent statements. A failure between them left either an
order whose history begins mid-lifecycle, or - worse - an orphaned
`pending` row whose PaymentIntent the error handler had already cancelled.
Both now roll back together. A test asserts the invariant across every
order the suite creates, so a future non-atomic path trips it.

**Object storage is required in production, not advised.** Local disk on a
container filesystem means every deploy silently deletes every uploaded
photo, and a second instance cannot see the first one's files - a failure
that only becomes visible once the damage is done. Missing `S3_BUCKET`, or
a bucket without credentials, now refuses startup. `REDIS_URL` stays a
warning, because the in-process fallback genuinely works.

`FRONTEND_URL` is also now required and must be https, since it is what
password-reset links point at - unset, every user gets a dead localhost
link; plain http and the link travels unencrypted.

**Docker images are now built in CI.** They had been written but never
built, which meant "the Dockerfiles exist" was being mistaken for "the
Dockerfiles work" - a distinction that surfaces during a deploy, the worst
possible time. No Docker daemon is available in the sandbox, so rather
than claim verification I could not perform, CI now builds all three
images on every push, runs the API image to confirm it reports missing
configuration and exits non-zero, and validates the compose file.

**Password reset** was already implemented in the previous round; verified
rather than rebuilt.

**Not done, and not claimable:** staging, and the real Stripe test-mode
run. Both need infrastructure and credentials outside this environment.
`npm run journey` is written for the Stripe flow and skips with a clear
message without keys.

289 → 296 tests.

## Thirtieth round: order state machine, audit trail, security headers

Worked the review's list in priority order, respecting the items it
explicitly deferred (#8 AI job queue, #13 object storage, #14 geocoding -
all "not yet unless traffic justifies it").

**#10 and #11 were built together, not separately.** The single transition
function is exactly where audit events belong, so building them apart
would have meant writing the same code twice.

`services/orderStateMachine.js` now owns every status change.
`transitionOrder()` handles validation, timestamps, the audit event, trust
counter refresh and notifications in one place. Nine call sites previously
did their own `UPDATE`, each individually responsible for remembering the
side effects - which is precisely how the trust counters ended up counting
payments instead of completions.

The audit event is written in the **same database transaction** as the
status change, so an order's status cannot move without leaving a record
of who moved it. `SELECT ... FOR UPDATE` serialises concurrent transitions
so two actors can't both validate against the same stale status.

**Routing everything through it immediately exposed a real bug.** The
transition table declared `expired` and `cancelled` terminal, but Stripe
can confirm a payment *after* we've given up on an order - and that money
has to be refunded, which means leaving those states. The old raw
`UPDATE` never consulted the table, so the inconsistency was invisible.
Both now permit `→ refunded`.

**Migration 013 adds `transaction_events`** with actor attribution.
System-driven changes are recorded as `actor_type: 'system'` with a null
actor - "nobody did this, a timer did" is a real answer in a dispute. The
backfill only writes events it can evidence from existing timestamp
columns; inventing plausible intermediate events would poison the trail it
exists to provide.

One behaviour change: transitions are now **idempotent** when the order is
already in the target state. Required for the webhook path (Stripe
re-delivers routinely) and better for a double-clicked button. The
guarantee that matters is that it doesn't happen twice - there's a test
asserting exactly one completion event however many times it's called.

**#12 - Security headers via Helmet.** CSP is configured explicitly rather
than taking the default, because the default forbids Stripe's card iframe
and a CSP that breaks checkout just gets switched off. `frameAncestors:
none` (clickjacking), `nosniff`, and `strict-origin-when-cross-origin` so
listing URLs - which identify an item and a seller - don't leak to sites
users click through to. HSTS is production-only, since it's meaningless
over local HTTP.

**#12 - Request correlation** via `AsyncLocalStorage`. The request id
existed but only reached the HTTP log line, so a Stripe failure, an AI
timeout and the request that caused them appeared as three unrelated
events. Now every log line inherits it automatically without any call site
passing it - verified by checking that `email_dev_fallback`, which never
passes a request id, shares one with its `http_request` line. Deliberately
used for diagnostics only: passing identity or authorization implicitly
would hide it where it most needs to be explicit.

**#15 - The suite couldn't be run.** The review couldn't execute the tests
because dependency installation timed out. Added a root `package.json` and
`scripts/check-env.js`: `npm run setup` installs both workspaces, creates
`backend/.env`, and fails with an actionable message if Node is too old or
Postgres isn't running - rather than letting the suite die on a connection
error that doesn't say what to fix. `npm run verify` does everything in
one pass. A quickstart now sits at the top of this file rather than
hundreds of lines down.

210 → 219 tests.

## Twenty-ninth round: production infrastructure

Deployment was the last real gap. The rule for this round was that
anything runnable had to actually be run - infrastructure that has never
executed is a liability dressed as reassurance. `DEPLOYMENT.md` states
what was verified and what wasn't, per component.

**Two genuine production bugs found by running things.**

*The API died on a database blip.* `pg` emits an `error` event on idle
pooled clients when a connection drops, and an unhandled `error` event on
an EventEmitter throws - taking the process down. There was no
`pool.on("error")` handler, so any brief Postgres restart, failover, or
managed-database maintenance window would have killed every API instance
at once, turning a recoverable dependency blip into a full outage. Found
by stopping Postgres against a running server and watching it exit. Now
handled and re-verified: the process survives, liveness stays 200,
readiness drops to 503, and it reconnects on its own.

*HSTS was silently absent from every response.* nginx's `add_header` does
not accumulate - a `location` block containing any `add_header` of its own
**discards** every inherited one. Both static locations set
`Cache-Control`, so the `Strict-Transport-Security` header defined at
server level never reached the wire. Present in the config, missing in
reality. Found by curling the running proxy rather than reading the file.

Also caught by validation rather than assumption: `http2 on;` requires
nginx ≥ 1.25.1, and Ubuntu 24.04 LTS - a very common deploy target - ships
1.24. `nginx -t` failed on it.

**Liveness and readiness are deliberately different endpoints.**
`/api/health` never touches the database; `/api/ready` does. Pointing a
*restart* probe at a dependency check is a known outage amplifier: a
database blip makes every instance report unhealthy, the orchestrator
kills them all, and a recoverable problem becomes a total one. The
container healthcheck uses liveness for exactly this reason. Tested
against a real Postgres outage rather than reasoned about.

**Startup config validation** refuses to boot on unsafe production
configuration - development-default or short secrets, wildcard or
plain-http CORS origins with credentialed cookies, missing Stripe webhook
secret, missing SMTP. Optional infrastructure (S3, Redis) warns instead.
The failure this prevents is specific: a default secret breaks no test,
because nothing exercises it until someone attacks it.

**Backups verify themselves.** `pg_dump` exiting zero proves very little,
so each dump is read back with `pg_restore --list` and rejected if it
contains no table data - the two silent failures being a truncated archive
and faithfully backing up an empty database for months. Retention prunes
only *after* the new backup verifies, so a failing job can't delete the
last good one. Verified end to end here: backed up the real database,
restored into a fresh one, and confirmed rows and the PostGIS generated
column survived.

**Dockerfiles rewritten.** The previous ones ran as root and shipped the
build toolchain (`python3`, `make`, `g++`) into the runtime image - useful
for seconds at build time, attack surface for the container's life. Now
multi-stage, non-root, healthchecked, with a separate worker entry point
from the same source. The frontend image no longer ships a Node server to
host static files, since nginx is already the entry point.

**Not verified, and marked as such:** the Dockerfiles and compose file
have never been built - no Docker daemon was available. They're
structurally validated (YAML parsed, service and volume references
cross-checked) and nothing more. The first `docker compose up` is a real
test.

247 → 255 tests.

## Twenty-eighth round: verified deployment, and a ship-blocking bug

The moderation saga and one-command verify from the previous round were
documented but not actually present in the tree - rebuilt and now covered
by the suite. Two smaller fixes fell out of doing so: the saga's first
version did raw `UPDATE`s on transactions, bypassing `transitionOrder` and
losing the refund's audit-trail attribution (caught by an existing test),
and `transitionOrder` wasn't keeping `cancellation_reason` in sync, so
callers were patching the row afterwards. It owns both now, which is the
point of having one function own transitions.

**A ship-blocking deployment bug, found by simulating a real install.**
Rather than trusting the compose file, I ran `npm ci --omit=dev` - exactly
what the Dockerfile runs - and booted with `NODE_ENV=production` against
real Postgres and Redis. It crashed immediately:
`ENOENT: /database/migrations`.

The cause would have broken the first deploy. `migrate.js` resolved
migrations at `../database/migrations`, a *sibling* of the backend
directory and therefore **outside the Docker build context** (`./backend`).
`COPY . .` could never include them, so the built image would ship with no
migrations at all. `seed.sql` had the same problem. Migrations are
backend-owned, so both moved to `backend/database/`.

The re-run booted cleanly: 16 migrations applied, every endpoint 200.

Two things worth recording from that exercise. The production config guard
correctly *refused* to start on the first attempt - weak JWT secret, a
development database URL, missing CORS/Stripe/SMTP - which is exactly the
behaviour you want and is easy to assume without ever testing. And a
dependency audit confirmed no runtime `require` resolves to something in
`devDependencies`, which `--omit=dev` would silently drop.

**Real-Stripe smoke test.** The suite's full-journey test covers
checkout -> paid -> fulfilled -> completed -> review, but against a mocked
Stripe. What that structurally cannot cover is real webhook signature
verification, real PaymentIntent transitions, and Stripe's actual response
shapes. `npm run smoke:stripe` walks the same chain against real test-mode
Stripe with `stripe listen` forwarding. It **refuses to run against a live
key** - a smoke script that charges real customers because someone had
production credentials loaded would be worse than no smoke script at all.

**Logging cleanup.** The last `console.error`/`console.log` calls in
runtime paths now go through the structured logger. The two remaining are
startup guards that fire before anything is wired up, whose only job is to
be readable by a human at a terminal; they're annotated so nobody
"fixes" them.

262 tests.

## Twenty-seventh round: auth hardening, GDPR, legal drafts

Audited first - email verification, session revocation, logout-everywhere,
rate limiting and verification lockout already existed. Password reset,
refresh tokens, and GDPR tooling genuinely did not.

**Split credential (migration 017).** A single 30-day JWT *was* the
session, so a captured token stayed useful for a month and the only remedy
was bumping `session_version`, which logs out every device at once. Now a
15-minute access token plus a refresh token that **rotates on every use**.
Rotation is what makes theft *detectable*: because each refresh invalidates
the token that produced it, an old token presented again means two parties
hold the same credential. That revokes the whole family - we can't tell the
victim from the attacker, so both are stopped. Tokens are stored hashed,
so a database leak doesn't hand over working sessions.

**A real bug in that, caught by its own test.** The reuse response revoked
the family *inside* a transaction and then threw - and the throw rolled the
revocation back. The security response was being silently discarded by the
error that reported it. Revocation now happens after the transaction
settles; verified by confirming `reuse_detected` rows actually persist,
where previously there were none.

**Password reset** with single-use, 30-minute tokens. Requesting a reset
reports success for unknown addresses too, because confirming whether a
given parent has an account here is itself a privacy leak, separate from
takeover risk. Completing a reset ends every other session - if the reset
was prompted by a compromise, leaving the attacker signed in would defeat
the point - and emails the user afterwards, which is what lets a victim
notice a takeover they didn't start.

**Per-account lockout and suspicious-login detection.** Per-IP limiting
can't stop an attacker rotating addresses against one victim, and punishes
a shared office IP. Lockout increments in a single statement so concurrent
attempts can't all read the same stale count. "Suspicious" means the
account has signed in before but never from this IP - deliberately coarse,
because it triggers an email, not a lockout, so a false positive is cheap.

**GDPR (Articles 15, 17, 20).** Export returns everything held about a
user as a downloadable file - and deliberately excludes the *other* party's
messages, since satisfying one person's access request by handing over
someone else's personal data would be a breach, not compliance.

Deletion anonymizes rather than deletes, because "erase everything" and
"retain accounting records" are both legal obligations pointing opposite
ways. Personal data is erased; transaction records survive stripped of
identity (statutory retention); reviews the user *wrote* survive without
attribution, because otherwise anyone could erase unfavourable reviews by
deleting their account. Deletion is refused while an order is in flight -
vanishing mid-transaction leaves the other party with no counterparty.

**Legal drafts** in `legal/`, clearly marked as drafts requiring a Finnish
lawyer. I'm not one and didn't pretend otherwise: every point needing legal
judgement or a business fact is flagged `[REVIEW]` or `[FILL IN]` rather
than invented - 53 of them. The technical content is drawn from the code,
not a template: the cookie policy lists the cookies actually set, and the
privacy policy's data categories match the schema. The largest open
question is flagged prominently - whether high-volume sellers count as
*traders* under EU consumer law, which determines withdrawal rights,
warranty obligations, and platform duties.

**One process failure worth recording:** I wrote migration 017 to
`database/migrations/` when the real directory is
`backend/database/migrations/`. Tests failed with missing columns, and
`npm run migrate` reported success while silently applying 16 of 17. Moved,
and the stray directory removed.

262 → 289 tests.

## Twenty-sixth round: moderation saga, dispute resolution, one-command verify

**Moderation and payments are now recoverable, not best-effort.** The
takedown previously hid the listing, then called Stripe, outside any
transaction, catching individual refund failures so one bad order didn't
block the rest. Right instinct, wrong outcome: the system could come to
rest at *listing moderated, order paid, money still captured*, with
nothing recording that a refund was owed and nothing to retry it.

Wrapping both in one database transaction does not fix this, and the
review was right to say so - Stripe is a separate system, a DB transaction
cannot roll back a refund that already happened, and holding a transaction
open across a call to a payment provider is its own problem.

So the intermediate states became explicit and durable. A takedown is now a
saga: one database transaction hides the listing, creates a
`moderation_action`, and writes one `moderation_refund_task` per affected
order. Those tasks are then executed against Stripe, each result recorded
in its own transaction, and the action finalizes only when every task has
succeeded. A crash anywhere leaves a row describing the outstanding
obligation.

Two decisions worth stating. **Concealment does not wait for money**: an
unsafe car seat stops being purchasable the instant a moderator acts, even
if Stripe is unreachable - what waits for settlement is *finalization*, not
hiding. And **each task carries a stored idempotency key**, so a retry
after an ambiguous timeout cannot refund the same buyer twice, which is the
bug a naive retry loop would introduce while fixing a different one.
Exhausted tasks move the action to `needs_attention` and appear in an
admin queue with a retry endpoint, rather than failing silently.

Building it exposed a regression I'd introduced: the saga initially did raw
`UPDATE`s on transactions, bypassing `transitionOrder` - so refunds moved
the order but left no attributed audit event. An existing test caught it.
The fix was to route through the state machine, which is what the earlier
"one function owns transitions" work existed for; and `transitionOrder` now
also keeps `cancellation_reason` in sync, rather than leaving callers to
patch the row afterwards.

**Dispute resolution.** `disputed → refunded` and `disputed → completed`
were declared legal in the transition table and implemented nowhere, so
every dispute was permanent and the money frozen with it. Now admin-only
(the parties disagree by definition, so letting either close it just hands
the argument to whoever clicks first), with a mandatory resolution note
because disputes are exactly the records that get re-examined. For a
refund, Stripe is called *before* the status changes: if it fails the order
stays disputed and the admin sees an error, which is recoverable - marking
it refunded first would tell everyone the buyer had been paid when they
hadn't. Upholding restores the seller's trust credit automatically, because
the counters recompute from `completed` rather than being incremented.

**`npm run verify`.** One command covering environment, migrations, both
lints, the full test suite, the frontend build, and a smoke test against a
real running server - including that protected endpoints still return 401,
since a 200 there would mean authentication had silently stopped applying.
Previously these checks lived in four commands across two directories, so
it was easy to see green tests and miss a broken frontend build.

**`npm run journey`.** The full purchase chain over HTTP against a real
database. Its unique value is the *real* Stripe round trip - wrong API
version, bad key permissions, a mismatched webhook secret - none of which a
mock can catch. This sandbox can't reach Stripe (the egress proxy returns
403), so it's written to run against `sk_test_` keys with
`stripe listen`, and without them it exits with a distinct code and says
plainly what it cannot verify rather than reporting a misleading failure.
The application-side chain it would cover is instead asserted by a new test
that walks checkout → paid → fulfilled → completed → review in one go and
checks the trust and audit side effects follow.

255 → 262 tests.

## Twenty-fifth round: frontend feature structure (#7), and verifying #12

**#12 turned out to be already done.** Request correlation via
`AsyncLocalStorage` (`backend/requestContext.js`) was built in an earlier
round, and Helmet was already configured. Rather than assume, I verified
it: triggered a request and confirmed a deep service log
(`email_dev_fallback`, emitted from inside the email module) carries the
same `requestId` as the `http_request` line. Nothing to add.

**#7 - Feature-based frontend structure.** The reviewer singled out
Profile.jsx, and they were right: 184 lines holding three unrelated
domains inline - orders, Stripe Connect payouts, and listing management -
each with its own state, loading and actions. They shared nothing except
being rendered on the same page.

Split into `useOrders`, `usePayouts` and `MyListings`/`OrderList`/
`PayoutSetup`, each owning its own slice. Profile is now 46 lines of
composition. A change to order handling no longer means reading past
payout logic to find it.

Components and hooks moved into the feature that owns them
(`features/auth`, `listings`, `marketplace`, `messaging`, `orders`,
`payouts`, `moderation`, `notifications`, `profile`), with only genuinely
shared pieces left at the top level. Routes extracted to `app/routes.jsx`,
so the shell (header, providers, error boundary) and the map of what pages
exist can be read independently.

**A real gap surfaced during the split.** `OrderList` needed the seller's
"I've handed this over" and the dispute actions - and the frontend
`transactionsService` had no methods for them. The backend `fulfil` and
`dispute` endpoints have existed since the lifecycle round with no client
ever calling them, so `fulfilled` was unreachable in practice and disputes
could not be raised from the UI at all. That's the same "built but never
wired up" shape as the `'completed'` status the journey audit caught,
which suggests it's worth checking new endpoints have a caller rather than
assuming the round that added them finished the job.

**On the mechanical part:** moving files broke imports in two waves. The
first rewrite only fixed paths for files that *moved*, leaving imports of
unmoved shared modules (`services/auth` and others) pointing at now-wrong
relative paths. Rather than patch them one at a time, the second pass
indexed every real module and repaired any relative import that didn't
resolve - 17 of them. Verified beyond a passing build: the built SPA was
served and its bundle fetched, since a green build says the imports
resolve, not that the app runs.

Backend untouched: 247 tests still passing.

## Twenty-fourth round: queues, Stripe reconciliation, direct uploads, geocoding

Review items #8, #9, #13, #14. Worth recording that the reviewer marked
#8, #13 and #14 as "not yet" - these are answers to load that hasn't been
measured. Built on request; the reasoning for deferring them still stands.

**#8 - Durable job queue (BullMQ + Redis).** AI replies were an in-process
`.catch()`: if Node restarted between a buyer's message and the reply, the
job vanished silently and the buyer waited forever for an answer that
would never come. Now enqueued, with retries and exponential backoff.

Deliberately optional. Requiring Redis to run the app or the tests would
be a cost paid every day of development for a benefit that only matters in
production, so with no `REDIS_URL` the app falls back to the in-process
path - the same graceful-degradation shape as the PostGIS work. The claim
is *verified*, not asserted: Redis was installed here, a job enqueued from
a process that then exited without processing it, and a separate worker
process started afterwards picked it up.

The AI claim is taken *before* dispatch, so duplicate-reply protection
works identically on both paths - moving it into the worker would open a
window where two enqueued jobs both pass the check. Workers run from a
separate entry point (`npm run worker`) because AI generation is slow and
would otherwise compete with request handling for the event loop.

**#9 - Stripe reconciliation.** Webhooks are at-least-once, not
exactly-once: they can be delayed, dropped during a redeploy, or rejected
by a failed signature check, and nothing noticed. That produces a bug
class invisible until a customer complains - Stripe says succeeded, the
database says pending, the reservation expires, and the buyer paid for
something they never received.

A pass compares both systems and records discrepancies by type
(`stripe_succeeded_db_pending`, `stripe_failed_db_paid`, `stripe_missing`,
`amount_mismatch`, `stripe_refunded_db_active`). Deliberately **read-only**
- it flags for a human rather than auto-correcting, because both error
directions can be caused by something the job can't see (a dashboard
refund, a dispute, a partial capture), and silently "fixing" a mismatch by
trusting one side turns a reporting problem into a money problem. Runs are
recorded too, so "no issues" is distinguishable from "hasn't run in a
week", which look identical if you only store issues.

**#13 - Direct (presigned) uploads** - with an important qualification.
The naive version of this reviewer suggestion is a real regression: the
existing inline path re-encodes with sharp, which rejects non-images and
**strips EXIF**. For a marketplace where parents photograph items inside
their homes, EXIF GPS is a home address, and publishing it next to
"children's items, collect here" would be a serious privacy failure.

So presigned uploads land in a **quarantine prefix that is never served**,
and a job (queued when Redis is present, inline otherwise) validates,
strips and re-encodes before promoting the object. Un-stripped EXIF is
never an acceptable fallback, so the inline path runs even without a
queue. The local driver implements the same three-step flow against a
local endpoint, so the browser code path is identical in development and
production rather than first running untested in prod. A test builds a
JPEG *with* GPS EXIF, pushes it through the whole flow, and asserts the
published object has none.

**#14 - Geocoding.** The hand-maintained 13-neighbourhood table doesn't
survive expansion to Espoo, Vantaa, Turku, Tampere, Stockholm. Provider is
now selectable (`table` default, `nominatim`, `google`) behind a cache,
because providers rate-limit hard (Nominatim allows 1 req/sec) and cost
money at volume, while addresses repeat constantly.

Misses are cached too - without that, an unmappable address hits the
provider on every request forever. Provider *failures* are deliberately
**not** cached: an outage says nothing about whether an address is real,
and caching it would make a transient failure permanent. On failure it
falls back to the local table, because a slightly approximate coordinate
beats a listing that can't be created because a third party is down. The
default stays `table` so switching to a network provider - and its
latency, rate limits and outage modes - is an explicit decision.

The remote providers are tested against a mocked transport; this sandbox
can't reach Nominatim or Google, and that limit is stated rather than
papered over.

**Two real bugs found along the way.** I introduced a duplicate migration
number (two `013`s) because an earlier round had already added
`013_transaction_events.sql` - renamed to `014`. And `tests/dbReset.js`
truncated a hardcoded table list, relying on CASCADE to reach the rest;
any table with no foreign-key path back to those six (`reconciliation_runs`,
for one) was never cleared, so rows leaked between test files and produced
failures that looked like product bugs but were stale fixtures. It now
enumerates the catalog, so new tables are covered automatically.

231 → 247 tests.

## Twenty-third round: centralizing status logic, fixing stale docs and duplicated config

Follow-up review. Three of the points raised (review eligibility, the
analytics conflation, the counter-recalculation migration) were already
fixed in the previous round - verified rather than assumed before moving
on. The remaining three were genuine and are addressed here.

**Centralized transaction status logic** (`backend/transactionStatus.js`).
The status *values* were correct after the last round but scattered across
four services, phrased slightly differently in each - which is exactly how
the "paid counted as completed" bug happened: the lifecycle changed in one
file and four others kept the old assumption, with no single search that
would find them all. They're now named business concepts -
`MONEY_CAPTURED`, `AWAITING_HANDOVER`, `CONCLUDED`, `REVERSED`,
`IN_FLIGHT_FOR_MODERATION` - alongside `VALID_TRANSITIONS`, so the
lifecycle and everything derived from it can't drift apart. A future
change is one edit rather than a hunt through SQL string literals.

`sqlList()` asserts each member is a real status before emitting it. These
are our own frozen constants so there's no injection path, but the check
means a typo fails loudly at startup instead of silently producing a
filter that matches nothing - which would read as "no sales yet" rather
than as a bug.

**Stale documentation corrected.** The README still claimed CSRF was
`SameSite=Lax` only; the app has had a double-submit token with
`timingSafeEqual` comparison since round twelve. The limitation entry now
describes the actual posture and names the real remaining gap (a token is
per-session, not rotated per request). Auditing the rest of that list
found it had also fallen behind: added the in-memory rate-limit store
(counters are per-instance, so behind a load balancer the effective limit
is N times the configured one), disputes that can be raised but not
resolved, polling rather than push, and the deferred infrastructure.

**One source of truth for marketplace config.** `constants.js` held its
own `CATEGORIES`/`CONDITIONS` and the hook fell back to them, so the
backend's list was authoritative only when the network cooperated. Now
`constants.js` holds `CATEGORY_METADATA` - label and icon, keyed by id -
and the valid ids come from `GET /api/meta/config`. An id with no local
metadata still renders, deriving a label and using a default icon, so
adding a category server-side reaches the UI with no frontend change
(verified by temporarily adding one and watching it appear as "Nursery
furniture").

Degraded mode is deliberately asymmetric. Read paths (browsing, filtering)
fall back to the ids we have presentation for, since a stale filter value
just returns nothing. The write path does not: the sell form stays
disabled until the server has said what's valid, because offering a
category the backend would reject means a confusing validation failure
*after* the user has filled in the whole form.

202 → 210 tests, including assertions that the config endpoint publishes
exactly the values listings accept, and that `CONCLUDED` never widens to
include `paid` - the invariant behind both the trust counters and review
eligibility.

## Twenty-second round: P0 - trust counters counted payments, not completions

A review caught a real bug I introduced in the previous round: the
transaction lifecycle was changed to `pending → paid → fulfilled →
completed`, but the trust counters were never moved to match it. They were
still incremented in the Stripe webhook the moment payment settled.

So the code asserted two contradictory things at once: the lifecycle said
payment received ≠ deal concluded, while the counters said payment
received = completed sale. The consequence was that a seller who took
€50 and shipped nothing still gained `+1 completed_sales_count` and could
reach the `active` trust badge on the strength of orders that never
concluded - precisely the case a buyer consults the badge to avoid.

**The conflation was in five places, not one.** Fixing only the call site
would have left the badge wrong:
1. the webhook increment (the reported bug),
2. the 007 backfill, which counted `status IN ('paid','completed')`,
3. seller analytics, reporting paid orders as "completed sales",
4. platform analytics, same,
5. **review eligibility** - which matters most, because `ratingCount` and
   `averageRating` also feed the trust badge. A buyer could review before
   receiving anything, so a seller could accumulate stars without ever
   handing an item over.

**Counters are now recomputed from source rather than incremented.** Same
reasoning as `refreshRatingAggregates`: it's idempotent and self-healing.
It also handles something an increment never could - a completed order
that is later disputed correctly drops back out of the seller's count,
rather than being permanently banked. Completions are rare relative to
profile reads and both queries hit partial indexes added in migration 012,
so this isn't on a hot path. The recompute runs inside the same database
transaction as the status change, so the counters can't drift from the
status they're derived from.

Migration 012 repairs historical drift from both the webhook increments
and the bad backfill in one pass.

**Analytics now separates "money captured" from "deals concluded"** rather
than merging them, since a paid-but-not-handed-over order is genuinely
revenue the seller can see but is not a concluded sale. Platform stats
gained `inProgress` and `disputed` alongside `completed`.

**Review eligibility now requires `completed`.** Known trade-off, recorded
rather than glossed: a seller who takes payment and goes silent can't be
reviewed, because the order never reaches `completed`. The recourse is the
dispute flow, which is the right shape - a ghosted buyer wants their money
back, not a star rating - but it does mean review counts under-represent
bad sellers until there's a dispute-resolution path that can settle an
order.

**Seven existing tests failed on this change, and every one of them was
asserting the old, wrong behaviour** - which is the clearest evidence the
bug was load-bearing rather than theoretical. They were updated to assert
correct semantics rather than worked around, and new tests were added for
the cases that were previously impossible to express: paying alone doesn't
count as a sale, a paid-but-unhandled-over seller stays at `new`, and
disputing a completed order removes it from the count again.

197 → 202 tests.

## Twenty-first round: P0 money/safety, P1 abuse and scalability

**P0 #1 - Moderation vs in-flight payments.** This was the worst bug in
the codebase. Taking a listing down ignored transactions entirely: a buyer
could have paid for a recalled car seat, and the takedown would hide the
listing while quietly keeping their money and leaving the order looking
normal. Takedown now resolves in-flight money, with the two cases handled
differently on purpose - a `pending` order has its PaymentIntent
**cancelled** (no money moved, so a refund would be the wrong tool), while
`paid`/`fulfilled` orders are **refunded**. A `completed` order is
deliberately left alone: the buyer has the item and confirmed it, so
unwinding a finished deal is a dispute, not an automatic refund. Refunds
are awaited rather than fire-and-forget - if they can't be processed the
moderator must know, rather than believing the problem is handled.

**P0 #2 - A real transaction lifecycle.** The old statuses conflated
"money taken" with "goods handed over" and had no representation for a
contested order. Now `pending → paid → fulfilled → completed`, with
`cancelled`/`expired`/`refunded`/`disputed` as exceptional exits, each
transition validated against a state table rather than checked ad hoc.
`fulfilled` is the genuinely new step: a seller previously had no way to
say "I've sent this", so "buyer hasn't confirmed" was indistinguishable
from "seller did nothing" - exactly the ambiguity a dispute turns on.
Either party can raise a dispute, since a buyer falsely claiming
non-delivery harms a seller just as much as the reverse.

**P1 #3 - Messaging and AI rate limits**, keyed **per-user**, not per-IP.
These endpoints require a login, so identity is known - and per-IP would
be the wrong control anyway: an abuser rotates IPs trivially, while a
family sharing a connection would be punished for each other's use. AI
gets a tighter budget than messaging (it costs real money per call) with
per-IP layered on top to stop one machine spreading abuse across throwaway
accounts. Message length is now capped at 2000 characters - previously
unbounded, so a 300KB message would be stored, re-sent on every thread
fetch, *and* fed to the AI as prompt input.

**P1 #4 - Verification attempt race.** The limit check was read-then-write,
so concurrent guesses all compared against the same stale count - firing
many requests at once, every one saw "attempts = 0" and proceeded, making
the 5-attempt lockout meaningless against exactly the automated attacker
it exists to stop. Now a single conditional `UPDATE` claims an attempt
atomically. Tested with genuinely concurrent requests from separate
connections.

**P1 #5 - Moderated listings were still publicly retrievable** by anyone
holding the id, so a link shared before a takedown kept working. Now 404s
for everyone except the seller (who needs to see what was removed) and
moderators (who need to review it) - deliberately 404 rather than 403,
which would confirm the listing exists.

**P1 #6 - HTML email escaping.** A display name like
`<img src=x onerror=...>` went straight into the verification email body.
Unlike a web page there's no CSP to fall back on. Escaping is applied to
every interpolated value, with `&` handled first so escapes aren't
double-applied.

**P1 #7 - Message pagination.** The inbox was loading **every message
across every conversation** just to render a preview and count unread -
growing without bound on the most frequently polled endpoint. Now
`DISTINCT ON` fetches one latest message per thread, unread counts are a
single grouped SQL query, and history moved to
`GET /conversations/:id/messages?cursor=`. Cursor-based rather than
offset, because messages are appended constantly and an offset shifts
under the reader.

**P1 #8 - Marketplace pagination UI.** The API had returned
`total`/`hasMore` for several rounds while the UI ignored it, so anything
past the 20th listing was simply unreachable by browsing. "Load more"
appends rather than replaces, since paging that swaps the grid out loses
the reader's place, and results are deduplicated by id because a listing
sold between pages shifts the offset.

**A real test-harness bug surfaced here too**: several things are
deliberately fire-and-forget (notifications, AI, analytics) so a
marketplace action never fails because of them - which meant they could
still be in flight when a test file closed its connection pool, producing
`Cannot use a pool after calling end on the pool` as a suite-level error
that passed all its individual tests. Fixed with a grace period in
teardown; verified stable across consecutive full runs.

165 → 197 tests.

## Twentieth round: closing the gaps in the user journey

A full journey map was provided (Buyer / Seller / Admin → browse → listing
→ message → buy → Stripe → order → pickup/delivery → review). Rather than
treating it as a description of what exists, I audited it against the
actual code - and it exposed three real gaps.

**1. The "Pickup / Delivery" step didn't exist.** `'completed'` was
already a permitted transaction status *and* already treated as
review-eligible, but **nothing in the codebase ever set it**. Every
transaction stayed `'paid'` forever, so the handover step existed on paper
only. Added `POST /api/transactions/:id/confirm-receipt`, deliberately
buyer-only: the person who received the item is the one who can attest
that they did, and letting a seller mark their own sale complete would
make the signal meaningless. Six tests cover it, including that a seller
and an unrelated user are both refused, double-confirmation is rejected,
an unpaid order can't be confirmed, and - the point of the whole step -
that a confirmed order is still review-eligible.

**2. There was no public seller profile page.** The diagram shows "Seller
profile" as a node buyers reach, but no route existed. A buyer deciding
whether to deal with someone needs their trust signals, their other
listings, and their reviews in one place, rather than inferring it all
from a single listing card. Added `/seller/:id`, linked from the seller's
name on any listing.

**3. The moderation UI didn't exist.** The backend has had a full report
queue and takedown API since round fifteen, but nothing in the app could
reach it - a moderation system nobody can open isn't a moderation system.
Added `/moderation` with queue filtering by status, takedown/restore, and
resolve actions. Authorization stays entirely server-side: the page
handles a 403 gracefully rather than reimplementing the admin check
client-side, where it would be advisory at best. `isAdmin` is now exposed
on `/auth/me` purely so the UI knows whether to *offer* the link.

Migration 010 adds the `order_completed` notification type - the
notifications table has a CHECK constraint on `type`, so the new event
would have failed at runtime without it.

159 → 165 tests, and every node in the journey map now has a reachable
implementation.

## Nineteenth round: P2 #21 - analytics (completes P0, P1 and P2)

I'd previously pushed back on building analytics blind, and that shaped
what got built rather than being an excuse not to. Most marketplace
questions were **already answerable** from existing tables - listings,
transactions, conversations, reviews and users between them cover supply,
demand, conversion and retention. So this deliberately does **not** add a
generic `events` table with a JSON payload. That's how analytics usually
starts and it becomes a dumping ground that's expensive to query and
impossible to trust, while the real questions are answerable from
properly-typed rows that already exist.

**One genuine gap was missing: views.** Without them there's no
denominator. "12 sales" is unanchored; "12 sales from 400 views" is a
conversion rate you can act on. More importantly it lets a seller
distinguish "nobody is finding this" from "people look and don't buy" -
two problems with completely opposite fixes (reach vs price/photos).

Migration 009 adds `listing_views` plus a denormalized counter, so a
dashboard doesn't `COUNT(*)` over full history on every render while the
raw rows remain for time-series questions a single counter can't answer.

Details that mattered:
- **Anonymous views are counted.** Browsing doesn't require an account, so
  refusing to count logged-out visitors would badly understate real demand.
  A new `optionalAuth` middleware attributes a view when someone is signed
  in without making the listing page require it - and deliberately skips
  the `session_version` check `requireAuth` does, since this only affects
  analytics attribution, never authorization.
- **A seller's own views don't count.** Refreshing your own listing would
  otherwise inflate the exact number you're trying to read.
- **Recording happens after the response is sent**, so browsing is never
  slowed or failed by analytics bookkeeping.
- **Conversion rate is `null`, not `0`, with no views** - "0% conversion"
  reads as failure when the truth is "no data yet".
- **Per-listing stats are seller-only** (403 otherwise), since they'd
  otherwise let anyone measure a competitor's demand.

Platform metrics are chosen to answer "is this working?" rather than to
look impressive - notably **sell-through rate**, since a marketplace where
nothing sells has a supply problem dressed up as growth.

149 → 159 tests. **This completes P0, P1 and P2.**

## Eighteenth round: P2 #15 - PostGIS geospatial search

Distance search did a lat/lng bounding-box prefilter in SQL, then computed
exact Haversine distance and sorted in JavaScript. That was the right call
while the catalogue was small, but it meant every distance query pulled
the whole bounding box into Node, and pagination had to happen *after* the
sort rather than in the database.

Migration 008 adds a generated `geography(Point, 4326)` column with a GiST
index, and the query now does distance filtering, ordering and pagination
entirely in Postgres via `ST_DWithin` - returning exactly the page asked
for.

`geography` rather than `geometry` deliberately: it computes distances on
the spheroid in metres, which is what "within 5 km" actually means.
`geometry` would need an appropriate projection to avoid distortion, and
Finland is far enough north for that to matter.

**The fallback is kept, and that's the point.** The migration checks
`pg_available_extensions` and does nothing if PostGIS isn't there;
`db.detectPostgis()` checks at startup whether the column actually exists;
and `listingsService` picks the spatial path or the original bounding-box
path accordingly. Requiring PostGIS to run the app at all would make it
much harder to deploy (plenty of managed Postgres offerings don't include
it) for no benefit at small scale.

**Verified the two paths actually agree**, rather than assuming: ran both
against the same data and compared. Identical ordering, identical totals,
distances within 28 metres - the small delta is expected and correct,
since PostGIS uses the true spheroid while the fallback uses spherical
Haversine. Also confirmed via `EXPLAIN` that the query is a genuine
`Index Scan using idx_listings_geog`, not a sequential scan wearing a
spatial function.

**A real bug caught in the tests, not the code.** The test file titled its
describe block using `hasPostgis()` evaluated at module load - before
`dbReady` resolves and detection runs - so it always printed "fallback"
even when the spatial path was genuinely being used. The runtime code was
fine (it checks per-request, after startup), but the test output was
actively lying about which implementation it exercised. Now there's an
explicit test that logs the path in use, so a silent regression to the
fallback would be visible rather than passing quietly.

140 → 149 tests.

## Seventeenth round: P2 #19 - seller/buyer trust signals

The pieces existed (reviews, a verified flag, Connect onboarding) but
nothing combined them, and none of it appeared where buyers actually
decide - the listing card.

**Component signals, not a single score.** This deliberately exposes
rating, completed sales, account age and verification as separate facts
rather than reducing them to one number. A buyer can act on "12 sales, 4.8
from 9 reviews"; nobody can act on "87% trusted", and a wrong single score
is worse than several honest facts. The one derived value is a coarse
`level` used only to decide whether to show a badge - and it's
intentionally hard to game, requiring real completed transactions rather
than a filled-in profile. An unverified account is always `unverified`
regardless of volume; `established` needs sustained sales **and** a good
average, not either alone. All of that is tested directly against the
pure `summarize()` function rather than by constructing database state for
every permutation.

**An average rating is withheld below three reviews.** "5.0 from 1 review"
reads as far stronger evidence than it is, and one bad day shouldn't
render as "2.0 stars" either. The review *count* is still shown, so the
UI can say "2 reviews" without implying a score. This changed existing
behaviour, so an existing test that encoded the old "show the average
immediately" rule was updated to assert the new deliberate one rather than
being worked around.

**Counters are materialized, and updated in the right places.** Completed
sales/purchases increment **inside the same database transaction that
settles the sale** - a crash between the two would otherwise permanently
understate a number buyers rely on. Review aggregates are recomputed from
source after each review (cheap, since reviews are rare relative to
reads), so an incremental-update bug can't leave the cache permanently
wrong. Migration 007 backfills both from existing data, so established
sellers don't suddenly look brand new.

**Zero extra queries to display it.** The seller's trust columns come
along with the join that was already happening for their name, so a
listing card shows trust without the N+1 shape earlier rounds worked to
remove. The raw aggregate columns are stripped before the response -
they're an implementation detail of the join, not API surface, and
there's a test asserting they don't leak.

Removing the old ad-hoc star display from the listing detail view also
deleted a per-view API round-trip that fetched every review just to
compute an average the listing now already carries.

129 → 140 tests.

## Sixteenth round: P2 #18 - notifications

Until now the only way to learn that someone messaged you, bought your
item, or left you a review was to happen to open the app. For a
marketplace where the other party is waiting on a reply, that's the
difference between a sale and a dead thread.

**Stored, not just emailed.** Notifications are rows in the database,
which means the in-app list works with no email provider configured, an
event can't produce two notifications, and there's a record of what was
actually sent. The rendered `title`/`body` are denormalized on purpose - a
notification is a record of what someone was told at that moment, so it
shouldn't silently change if a listing is later renamed.

**Fire-and-forget, deliberately.** `notify()` swallows every error and
logs it rather than propagating. A sale must never fail because SMTP was
down or a notification insert hit a snag - the marketplace action is what
matters, the notification is an enhancement. This also means the tests
have to *wait* for notifications rather than assume they've landed, which
is what the `waitForNotification` helper does.

**Wired into five real events**: a message arriving (to whichever party
didn't send it), a sale completing (both sides - the seller has something
to hand over, the buyer wants confirmation their money went through), a
review being received, and a listing being taken down. That last one
matters: silently hiding a seller's listing would leave them wondering why
nobody's contacting them, so the takedown notification includes the
moderator's reason.

**Email is opt-out per user** (`email_notifications`, defaulting on for
things someone is actively waiting on). A user who turns it off still gets
in-app notifications - there's a test asserting exactly that split, since
conflating the two would mean opting out of email meant opting out of
knowing anything.

**Scoping is enforced in the WHERE clause**, so guessing another user's
notification id can't mark it read - tested by having a third party try,
then asserting the row is genuinely untouched rather than just that the
request 404'd.

The frontend gets a bell with an unread badge, polling once a minute -
same reasoning as the message polling: much simpler than WebSockets and
appropriate at this volume. A minute is deliberately unhurried; this is an
ambient "you have things waiting" signal, not a live feed. Opening the
panel marks everything read, since making someone click each item to clear
a badge is busywork.

119 → 129 tests.

## Fifteenth round: P2 #20 - reporting, blocking, moderation

Took this next because it's a safety mechanism rather than an
optimization. A marketplace for children's items needs a way to flag a
recalled car seat or a damaged cot, and a way to stop someone contacting
you - without those, the only recourse is emailing support, which doesn't
scale and leaves no record.

**Reporting.** Users can report a listing, a user, or a conversation, with
a reason drawn from a fixed set (`safety`, `prohibited`, `misleading`,
`harassment`, `spam`, `other`). `safety` is deliberately first in the UI -
for this catalogue an unsafe product is the report that matters most, and
burying it under spam would be the wrong default.

The database does the structural enforcement rather than trusting
application code: a CHECK constraint requires **exactly one** target, and
partial unique indexes prevent duplicate *open* reports while still
allowing a fresh report after an earlier one was resolved (the problem
recurring is legitimate new information). Constraint violations are
translated into useful messages - reporting a nonexistent listing gives a
clean 404, not a raw foreign-key error.

You also can't report a conversation you're not part of, which would
otherwise let anyone probe whether a given conversation id exists.

**Blocking** is deliberately separate from reporting: reporting asks
moderators to act, blocking is something a user does for themselves
immediately without waiting for anyone. Crucially it's **symmetric** - if
A blocks B, neither can message the other. A one-way check would only stop
the person who didn't want contact in the first place, which gets the
threat model backwards. It's enforced both when starting a conversation
and on every reply, since a block can be applied partway through an
existing thread.

**Moderator actions.** Admins (a plain `is_admin` boolean - inventing a
role system before there's a second privileged capability would be
speculative) can view the open report queue, resolve reports with a note,
and take listings down or restore them.

The takedown deliberately lives in its **own column** (`moderated_at`)
rather than reusing the seller-facing status, so a seller cannot relist,
reserve, or mark-sold their way out of a moderation decision - there's a
test asserting exactly that, plus tests that a taken-down listing
disappears from browsing *and* can't be purchased by someone holding a
direct link from before the takedown.

The admin check lives in the service (`requireAdmin`) rather than the
route, so it can't be bypassed by any other caller reaching the same
function.

Reports are also logged as structured `report_filed` events (using the
logger from the previous round), so a spike is visible in monitoring
without querying the database.

98 → 119 tests.

## Fourteenth round: P2 - observability, pagination, search

Starting P2. Took these three first because they're the ones that are
useful *now* rather than speculative: you can't tune what you can't
measure, and search/pagination affect every browse request today.

**#22 - Observability / structured logging.** 26 scattered
`console.log`/`console.error` calls replaced with a single structured
logger emitting one JSON object per line - the format that's actually
queryable once logs are shipped anywhere (filter on `level`, `event`,
`requestId`) rather than regex-matching prose. Deliberately
dependency-free (~40 lines, no supply-chain surface) and behind one
module, so swapping in pino later touches nothing else.

Every request now gets an id (honouring an inbound `x-request-id` from a
proxy so traces aren't broken at our boundary), echoed back in the
response header and logged with method, path, status, duration and user
id - which is what turns independent log lines into something traceable.
A redaction list keeps passwords, tokens, cookies and verification codes
out of logs entirely, since logs get shipped to third parties and retained
for months.

Two real bugs found by actually reading the output rather than assuming it
worked: requests were logging as `/signup` instead of `/api/auth/signup`
(by the time the handler fires, `req.path` is router-relative, making
different endpoints indistinguishable), and the dev-fallback email logger
was putting the **verification code itself** into a structured log line -
fine as a console line a developer reads, not fine as something shipped
and retained. Both fixed.

**#17 - Pagination.** The non-distance path returned no `total` at all
while the distance path did, so a client couldn't tell how many results
existed or whether to render a "next page" control. Both paths now return
the same envelope (`limit`, `offset`, `total`, `hasMore`). The count comes
from `COUNT(*) OVER ()` in the *same* query as the page - a separate
`SELECT COUNT(*)` would run the filters twice and could disagree with the
page if a listing changed in between.

**#16 - Full-text search.** Search was `title ILIKE '%term%' OR description
ILIKE '%term%'`. The leading wildcard makes any index unusable, so every
search sequentially scanned every active listing, couldn't match word
stems, and had no relevance ordering.

Migration 004 adds a generated `tsvector` column (Postgres keeps it in
sync automatically on write) with a GIN index. Title text is weighted
above description text, so searching "stroller" surfaces listings actually
*titled* stroller before ones that merely mention it - verified by a test
asserting the ordering, not just that both match. Terms are prefix-matched
(`:*`) so a partly-typed word still finds results, and ANDed so extra
words narrow rather than widen.

Two details worth noting: the search config is `'simple'`, not
`'english'`, because the catalogue is Finnish-market and mixes Finnish,
Swedish and English - `'simple'` degrades gracefully across all three
instead of stemming one correctly and mangling the others. And tsquery
operators a user might type (`&`, `!`, `:*`) are stripped rather than
passed through, since raw operators would be a syntax error straight into
`to_tsquery` - there's a test for exactly that input.

Also fixed a bug in my own first attempt here: the `ts_rank` ORDER BY
referenced its parameter by arithmetic position (`params.length - 2`),
which happened to work only when no bounding-box filter had pushed
parameters in between. Now the index is captured explicitly when the
parameter is added.

90 → 98 tests.

## Thirteenth round: the rest of P1 (#10-13)

**#12 - Centralized marketplace configuration.** The delivery fee,
commission, reservation TTL, price cap, category/condition vocabularies
and field limits were scattered across two services *and* duplicated again
in `frontend/src/constants.js`. That duplication is the actual risk:
adding a category server-side but forgetting the frontend copy silently
produces listings no filter can match. All of it now lives in
`backend/config.js`, with a public `GET /api/meta/config` so the frontend
renders from the same source of truth the API validates against.
Commission is deliberately **not** exposed - it's a platform-internal
number a buyer's UI has no reason to know, and the authoritative amounts
always come from the checkout response anyway.

**#10 - Stripe Connect enforced before a sale can happen.** This was
quietly the worst behaviour in the codebase: when a seller had no working
Connect account, checkout **silently fell back to collecting the buyer's
full payment into the platform's own Stripe account**. That means taking
real money for an item with no automated way to pay the seller - a manual
reconciliation problem created on every such sale, invisible to everyone
involved. Checkout now refuses up front with a clear 409, the buyer isn't
charged, no PaymentIntent is created, and the listing isn't left stranded
in `reserved`. The destination-charge path is now unconditional, since a
payout-capable seller is guaranteed by the time it runs. Enforcement is at
*checkout* rather than listing creation on purpose - a seller can still
draft and publish listings while onboarding, they just can't be bought
until payouts work.

**#11 - Image cleanup.** Deleting a listing or replacing its photo
orphaned the file forever - storage quietly accumulating for data nothing
references. `storage/deleteImage` handles both S3 and local disk (with a
path-traversal guard on the filesystem delete), wired into listing
deletion and photo replacement. Best-effort by design: a failed file
cleanup is logged, never thrown, because the listing being gone is what
the user actually asked for. Three tests verify real files disappear from
disk - including that an unrelated edit does **not** delete a photo still
in use.

**#13 - Checkout confirmation flow.** Payment success previously showed a
single line of text, leaving the buyer with no record of what they bought,
what they paid, or how they'd receive it. Checkout is now three explicit
steps - choose delivery → pay → confirmation - with a real order summary
at the end: order number, amount paid, delivery method, pickup location
where relevant, what happens next, and where to find the order again. The
payment step also shows the amounts from the **server's** checkout
response rather than recomputing them client-side, so what the buyer sees
is exactly what the PaymentIntent charges. The hardcoded delivery fee is
gone from the frontend, now read from `/api/meta/config` (with a local
fallback, since a config fetch failing shouldn't break checkout).

83 → 87 tests. All of P0 and P1 are now complete; P2 (#15-22 - PostGIS,
search indexing, notifications, moderation, analytics, observability) is
scaling and product work that genuinely should wait for real usage data.

## Twelfth round: P1 security - session revocation and CSRF

Continuing the P0/P1/P2 list. This round covers the two security-critical
P1 items (#8, #9); the remaining P1 items (#10-13) are noted at the end.

**#8 - Session revocation via versioning.** JWTs are stateless: once
issued, a token stayed valid for its full 30-day life no matter what
happened to the account. There was no way to end a session early - "log
out everywhere" was impossible, and a stolen token could only be dealt
with by waiting a month or rotating `JWT_SECRET`, which logs out *every
user on the platform* at once.

Migration 003 adds `users.session_version`, embedded in each token as it's
issued (`sv` claim) and re-checked by `requireAuth` on every authenticated
request. Bumping a user's version instantly invalidates every token issued
before the bump, **for that user only**. A new `POST
/api/auth/logout-everywhere` does exactly that, while issuing the current
device a fresh token so the person triggering it isn't logged out of the
device they're holding. The trade-off is one small indexed lookup per
authenticated request - deliberate, and the fix if it ever matters is
caching `session_version`, not dropping the check.

**#9 - CSRF protection (double-submit cookie).** Now that auth is an
httpOnly cookie, the browser attaches it automatically to *any* request to
this origin - including one triggered by a malicious third-party page.
`SameSite=Lax` (already set) blocks the common cases but varies by browser
and shouldn't be the only layer.

`middleware/csrf.js` issues a random token in a deliberately
**non-httpOnly** cookie (readable by our own JS - that's the mechanism) and
requires it echoed back in an `x-csrf-token` header on every
state-changing request. An attacker's page can make the browser *send* our
cookies, but same-origin policy stops it *reading* them, so it can't
produce the header. Comparison is constant-time (`timingSafeEqual`) so
response timing can't leak how much of a guessed token was right.

Three details that needed care:
- **The Stripe webhook is explicitly exempt.** It's a server-to-server
  POST with no browser and no cookies, authenticated instead by verifying
  Stripe's signature over the raw body. Left unexempted, CSRF would have
  silently broken all payment settlement.
- **CORS must allow the custom header**, or cross-origin preflight
  rejects any request carrying it - invisible today (the Vite proxy makes
  requests same-origin) but broken the moment frontend and backend are
  split across origins.
- **Bootstrapping**: on a completely fresh page load there's no CSRF
  cookie yet, so the user's *first* action would fail with a confusing
  403. The frontend now fetches one on demand before its first
  state-changing request.

**Test infrastructure** needed a real change here, not a workaround: every
mutating request in the suite was (correctly) being rejected with 403.
`tests/helpers.js` now provides a `csrfAgent` that behaves like a real
browser - persisting cookies *and* echoing the CSRF token back as a
header - so tests exercise the behaviour they're actually about rather
than asserting against CSRF rejections. New `tests/security.test.js`
covers both features directly, including a genuine two-device scenario
proving `logout-everywhere` ends the other session while keeping the
current one alive. 74 → 83 tests.

**Still open from P1**: #10 (enforce Stripe Connect before selling), #11
(image cleanup), #12 (centralize marketplace config), #13 (checkout
confirmation flow). P2 (#15-22) is scaling/product work, appropriately
deferred until there's real usage.

## Eleventh round: P0 hardening before serious production testing

A prioritized P0/P1/P2 list was raised. This round covers **all seven P0
items**, plus P1 #14 (concurrency tests) since it's what actually proves
the P0 fixes work rather than asserting they do.

1. **Stripe webhook + expiry transitions are now atomic.** Both handlers
   mutate transaction *and* listing state, and genuinely can run at the
   same instant. Previously each did read-then-write across separate
   queries, so a payment settling while the expiry sweep ran could leave
   the two disagreeing (e.g. transaction `paid` but listing back to
   `active`). Both now run inside a single database transaction (new
   `withTransaction` helper in `db.js`) and take a `SELECT ... FOR UPDATE`
   row lock before reading status - whichever handler arrives first wins
   cleanly and the other sees the settled status and no-ops. The sweep
   uses `SKIP LOCKED` so a row mid-settlement is left to the webhook
   rather than blocking the whole sweep. The external Stripe refund call
   is deliberately kept *outside* the transaction, so a slow API response
   can't hold a row lock open.
2. **Concurrent conversation creation fixed.** `getOrCreateConversation`
   was a check-then-act (`SELECT`, then `INSERT` if missing) that two
   simultaneous first messages could both pass, with one then failing on
   the unique constraint. Now a single `INSERT ... ON CONFLICT DO NOTHING`
   plus a re-`SELECT`: the losing request simply reads the row the winner
   created.
3. **State invariants pushed into the database** (migration 002), so they
   hold regardless of which code path runs: at most one `pending`
   transaction per listing (partial unique index), and a CHECK constraint
   that `reserved_at` is set exactly when `status = 'reserved'`. **The
   CHECK immediately caught a real pre-existing bug**: the seller's manual
   "Mark reserved" action never set `reserved_at`, meaning a manually
   reserved listing was invisible to the expiry sweep and could sit
   reserved forever. Fixed in `setStatus`.
4. **Unique constraint on `stripe_payment_intent_id`.** Without it, two
   transaction rows could point at one payment and the webhook's lookup
   would settle whichever came back first, leaving the other `pending`
   forever.
5. **AI reply no longer races the seller.** If the seller answers while a
   reply is still generating, the generated text is now discarded instead
   of landing *after* the real answer and contradicting it. The insert is
   conditional on `seller_replied` still being false, checked inside the
   same SQL statement so there's no read-then-write gap.
6. **AI failure state handled properly.** `getAutoReply` previously
   swallowed every error and returned fallback text, making failure
   indistinguishable from success to the caller - so a transient API blip
   left `ai_replied` permanently set and silently disabled auto-replies
   for that conversation *forever*. It now throws a typed
   `AiUnavailableError`, and the caller releases its claim so a later
   message can retry.
7. **Numeric/input validation tightened beyond ids.** Probing with real
   malformed requests (not code reading) found four more gaps: a price
   large enough to overflow the `INTEGER` column returned a raw 500, and
   `category`, `condition`, and text lengths were entirely unvalidated -
   a listing could be created with category `"weapons"` or a 100,000-
   character title, which no filter would ever match. All now validated
   through one shared `validateListingFields`, applied to **both** create
   and update so an edit can't sneak in a value create would reject.

**Concurrency tests (P1 #14)** - a new `tests/concurrency.test.js` proves
each fix rather than assuming it: a webhook racing the expiry sweep must
leave coherent state (either paid+sold or expired+active, never a mix);
duplicate PaymentIntent and double-pending inserts must be rejected by the
database; simultaneous first messages must create exactly one
conversation; an AI reply generated while the seller replies must be
discarded; and a failed AI generation must release its claim so a retry
works. The AI mock is made controllable (instant/slow/fail) so these are
deterministic rather than timing-dependent flakes. 60 → 74 tests, run
three times consecutively to confirm stability.

## Tenth round: Stage 1 of a 6-stage roadmap - stabilize what exists

A 6-stage roadmap was proposed (stabilize → data model → security →
marketplace UX → trust & safety → scale). This round is Stage 1 only,
done thoroughly rather than spreading thin across all six - later stages
are each substantial enough to warrant their own dedicated pass.

- **Genuinely clean install, not just "it still works."** Deleted
  `node_modules` and `package-lock.json` for both `frontend` and `backend`
  and reinstalled from scratch - no stale lockfile or cached module could
  be hiding a problem. Both installed cleanly.
- **Frontend build, frontend lint, backend lint, backend tests** - all run
  fresh, all passing, zero errors. One lingering **warning** (not an error)
  in `useListings.js` finally fixed properly instead of continuing to
  tolerate it: `useCallback` depended on `JSON.stringify(filters)` instead
  of `filters` itself, which is what triggered `react-hooks/exhaustive-deps`
  every round. The caller (`Marketplace.jsx`) already wraps `filters` in
  its own `useMemo`, so the object reference is already stable - depending
  on `filters` directly is both the *correct* fix (satisfies the lint rule
  because it's actually right, not suppressed) and confirmed safe by
  checking there's only one caller of the hook in the whole codebase.
  Frontend now lints with **zero errors and zero warnings**.
- **A real, systemic API validation gap, found by testing malformed
  input, not by reading code.** Every endpoint that takes a database id -
  as a route param (`/api/listings/:id`, `/api/users/:id`, etc.) or a body
  field (`checkout`'s `listingId`, a review's `revieweeId`, ...) - returned
  a raw `500 "Something went wrong on the server"` for a non-numeric value
  instead of a clean `400`. The cause: an unvalidated string like
  `"not-a-number"` reaching a Postgres integer comparison throws a
  type-conversion error that nothing was catching. This is the same class
  of bug as an earlier round's favorites fix, but far more widespread -
  probed with the exact same method (real malformed requests against a
  running server) and found it affected listings, messages, users,
  reviews, transactions, and favorites. Fixed with two small, shared
  pieces rather than patching each spot individually:
  `middleware/validateId.js` (route params, applied in every routes.js)
  and `utils/validation.js`'s `parseId()` (body-supplied ids, used inside
  the relevant services). Verified live against all 8 originally-broken
  cases (now clean `400`s) plus a sanity check that a real id still
  returns `200` normally, then added a dedicated `tests/validation.test.js`
  covering all of them so this can't silently regress. 48 → 60 tests.
- **Error handling audited, not just re-described.** Confirmed via `grep`
  that every service module has exactly one typed error class, and every
  HTTP controller (except `ai/controller.js`, which isn't a route and
  correctly has its own internal fallback instead) checks it with
  `instanceof` - the pattern established several rounds ago has held up
  consistently rather than drifting as new modules were added.

## Ninth round: an external review, addressed point by point

A detailed external review flagged ten numbered issues plus general
observations. Here's what changed for each - genuinely fixed and tested
where the review called for immediate action, explicitly deferred where the
reviewer themselves said not to build it yet, and one gap acknowledged
rather than silently left untested.

1. **Issue #3 (🔴 Very high) - listing status had no real state machine.**
   This was the most serious finding. `reserve`/`markSold`/`relist` could
   previously transition a listing to *any* status regardless of its
   current one - including the reviewer's exact scenario: a buyer starts
   checkout (`reserved`, with a real Stripe PaymentIntent), the seller
   clicks "Relist" mid-payment, the listing goes back to `active`, and a
   second buyer can now buy the same item out from under the first payment.
   Fixed with an actual transition table (`active → reserved/sold`,
   `reserved → active/sold`, `sold → active`) **and** a hard guard that
   blocks *any* manual status change while a real `pending` transaction
   exists on the listing - closing the gap regardless of which direction
   the conflict would come from. A dedicated test (`listings.test.js`)
   reproduces the exact scenario above and confirms it's now rejected with
   a `409`. The frontend no longer even offers "Relist"/"Mark sold" buttons
   on a `reserved` listing - it should resolve automatically via payment or
   expiry, not manual intervention.
2. **Issue #2 (🔴 High) - checkout wasn't fully transactional.** If Stripe's
   PaymentIntent creation succeeded but the subsequent `INSERT INTO
   transactions` failed, the result was an orphaned PaymentIntent: money
   reserved at Stripe with no local record of it. Added a Stripe
   idempotency key to the PaymentIntent call (protects against Stripe's own
   SDK silently retrying on a transient network error and creating a
   duplicate charge), and wrapped the `INSERT` so that a failure now
   cancels the PaymentIntent and releases the reservation instead of
   leaving it dangling. **Honest gap**: I could not write an automated test
   for the exact "Stripe succeeds, DB insert fails" sequence - the module's
   `const { query } = require("../db")` destructuring pattern makes that
   specific failure hard to inject without restructuring the module purely
   for testability. The logic mirrors the already-tested Stripe-failure
   cleanup path, but this one exact branch is unverified by a test.
3. **Issue #4 (🔴 High) - no migration system.** `initDb()` used to just run
   a monolithic `schema.sql` with `CREATE TABLE IF NOT EXISTS`, which does
   nothing for an already-deployed database that needs a schema *change*.
   Replaced with real migrations: `database/migrations/001_initial.sql`
   (the current schema, baselined - there's no real prior deployed version
   to preserve), a runner (`backend/migrate.js`) that tracks applied
   migrations in a `schema_migrations` table and applies each pending one
   inside its own transaction, `npm run migrate` as a standalone command,
   and an explicit migration step in CI. Tested: fresh-DB apply, a second
   run being a true no-op, and the normal server boot and full test suite
   both going through the new path successfully.
4. **Issue #5 (🟠 Medium/high) - verification codes used `Math.random()`
   and were stored in plaintext.** Switched to `crypto.randomInt()`
   (cryptographically secure), and the stored code is now a bcrypt hash,
   same as passwords - a database read (backup leak, compromised admin
   panel) no longer hands over anyone's live verification code directly.
   Verified live: the plaintext code goes to the client/email, the database
   column contains a `$2a$10$...` hash, and verification still works
   correctly end to end.
5. **Issue #6 - AI model hardcoded, no timeout.** `ANTHROPIC_MODEL` is now
   an env var (defaults to `claude-sonnet-5`). Also added a real gap the
   review's mention of "AI timeout" pointed at: without one, a hung request
   to Anthropic would leave the conversation's `ai_replied` claim
   permanently set with no reply ever inserted - the buyer would get
   silence forever, not even the fallback text. Now bounded to 20s
   (`AI_TIMEOUT_MS`) via `AbortController`.
6. **Issue #10 (🟠 Medium) - N+1 queries.** Already fixed in the prior
   round (`transactionsService.mine()` and
   `messagesService.myConversations()`) - confirmed via `grep` that no
   instance of the pattern remains, rather than re-doing already-done work.
7. **Issue #19 (🔴) - stale UI copy.** The frontend still said "We can't
   send real emails yet" unconditionally (even when SMTP *was* configured
   and email sending succeeded) and the footer's "Planned next: local
   pickup & delivery, real payments" was flatly wrong - all three already
   existed. The signup/verify screen now shows the backend's actual
   `message` field (which already correctly reflects whether email was
   sent, not sent, or failed) instead of a hardcoded claim, and the footer
   no longer hardcodes a feature-status list at all - it points to the
   README's "Known limitations" section instead, so the two can't drift
   out of sync with each other again the way they just did.
8. **Issues #7, #8, #9 (🟠) - message pagination, WebSockets/SSE, PostGIS
   distance search.** Deliberately **not implemented** - the reviewer
   explicitly said each of these is fine for MVP and shouldn't be built
   yet ("I'd not implement this yet" / "Don't do this now"). Noted here so
   it's clear they were considered, not missed.
9. **Issue #18 - frontend state management.** Also explicitly framed by the
   reviewer as a future direction (TanStack Query once the hooks grow
   unwieldy), not an immediate ask - not implemented.
10. **Issue #20 - "I couldn't independently run your test suite."** Fair,
    and worth being direct about: every test-count and pass/fail claim
    anywhere in this README reflects commands I actually ran myself, in
    this sandboxed environment, against a real local PostgreSQL 16 server
    I installed - not something inferred or assumed. I can't make the
    reviewer's own extraction environment have working `node_modules`, but
    the CI workflow (`.github/workflows/ci.yml`) will give an
    independently-verifiable green/red signal once this is pushed to a
    real GitHub repo, which is the right way to settle this going forward
    rather than trusting either of our local runs.

Also: thank you for the note about the code comments - keeping that
discipline (explaining *why*, not just *what*) throughout every round
above is deliberate, and it's genuinely useful feedback to hear it's
landing as intended.

## Eighth round: money is integer cents, not floating point

The previous round's review flagged `DOUBLE PRECISION` for money as a real
risk and documented `round2()` as a band-aid rather than a fix. Eliminated
the underlying problem instead of continuing to compensate for it:

- **Every money column is now `INTEGER` cents**, end to end:
  `listings.price_cents`, and `transactions.item_amount_cents` /
  `delivery_fee_cents` / `commission_amount_cents` / `total_amount_cents`.
  `round2()` is gone entirely - there's no float arithmetic on money left
  anywhere in the backend to round in the first place. The one remaining
  place a fractional cent can arise (the percentage-of-cents commission
  calculation) has exactly one `Math.round()`, at single-cent granularity,
  not accumulated across repeated additions the way the old euros version
  was.
- **Stripe's `amount` field wants integer cents anyway** - the old code
  had `Math.round(totalAmount * 100)` converting euros to cents right
  before calling Stripe. That conversion (and its rounding) is gone too;
  `totalAmountCents` goes to Stripe exactly as stored.
- **A real bug caught mid-migration**: the AI auto-reply prompt
  (`ai/controller.js`) still read `listing.price` directly - had this
  shipped unchanged, the AI would have received a raw `1999` and told a
  buyer their €19.99 item costs "€1999". Fixed with a small `formatEuro()`
  used only for the prompt string; verified in isolation that `1999` cents
  correctly renders as `€19.99`.
- **The frontend now has exactly two places money units ever convert**:
  `formatEuro(cents)` (display) and `eurosToCents(string)` (the price
  input field, where a human should still type "19.99", not "1999" -
  everywhere else, cents flow through unchanged). This incidentally fixed
  a small existing display bug too: `formatEuro` previously did no decimal
  formatting at all (`€18` instead of `€18.00`, `€18.5` instead of
  `€18.50`) - it now always shows two decimals.
- **Added a regression test that would have caught this class of bug**:
  checkout with a price of 1999 cents (chosen because 8% of it, 159.92, is
  exactly the kind of value that's risky under float arithmetic) asserts
  `commission_amount_cents` is precisely `160` and every amount field is a
  true integer (`Number.isInteger`), not just numerically close to one.
  41 → 42 tests, all still passing against real Postgres.

## Seventh round: a real code review, not a self-report

Asked to review the code independently rather than just recap prior
changes - actually inspected files, ran the linter/tests, and tested edge
cases live rather than re-describing what was already documented. Found
six real issues; fixed five, documented the sixth.

1. **`POST /api/favorites` returned a raw `500`** for a nonexistent
   `listingId` instead of a clean `404` - the foreign-key violation was
   never caught. Confirmed live before the fix (`"Something went wrong on
   the server."`) and after (`404 "Listing not found."`).
2. **Zero test coverage for `favorites`, `reviews`, `connect`, and
   `uploads`** - the favorites bug above is exactly what a test would have
   caught immediately. Added four new test files (19 new tests, 22 → 41
   total): favorites (add/list/remove, double-favorite idempotency,
   per-user scoping), reviews (including the **success path**, which had
   never been tested anywhere - only rejection had), connect (mocked
   Stripe Express onboarding, account reuse, status caching), and uploads
   (real image processing, garbage-data rejection, disk cleanup after the
   test run).
3. **N+1 queries in `transactionsService.mine()` and
   `messagesService.myConversations()`** - both looped over rows firing a
   separate query per row. Rewritten as batched queries: `mine()` is now a
   single `JOIN`; `myConversations()` went from up to 3 queries *per
   conversation* down to exactly 4 total regardless of how many
   conversations exist, computing unread counts in JS from already-fetched
   messages instead of a per-row `COUNT`.
4. **Inconsistent error handling in `connect/controller.js`** - every
   other module uses a typed error class checked with `instanceof`;
   `connect` instead matched on `e.message?.includes(...)`, which would
   have silently broken (falling through to a raw 500) if that message
   text ever changed. Now uses a `ConnectError` class like everywhere else.
5. **Jest never closed its Postgres pool**, which is why `--forceExit` was
   needed - not a red flag on its own, but it was masking the actual
   `--detectOpenHandles` signal that would catch a *real* leaked-promise
   bug in the future. Added `tests/teardown.js` (via
   `setupFilesAfterEnv`) to close the pool properly; confirmed Jest now
   exits cleanly on its own, and removed `--forceExit` from `npm test`.
6. **Money stored as floating point, not `NUMERIC`** - documented as a
   known limitation (see below) rather than changed, since migrating it
   touches every price/fee field across the schema and every place that
   currently treats them as plain JS numbers.

## Sixth round: messages table, secure auth, race conditions, and edge cases

Nine things were flagged; here's what changed for each, with what was
actually tested rather than just written.

1. **SQLite → PostgreSQL** - already done as of the fifth round; confirmed
   still in place, no rework needed.
2. **JSON messages → a real `messages` table.** The fifth round's JSONB
   array (itself an improvement over the original SQLite version) is gone -
   messages are now their own table with `conversation_id`, `sender_id`,
   `sender_type`, `text`, `created_at`. Each message is an independent row
   insert, so there's no shared mutable field for concurrent writes to race
   over at all - a stronger guarantee than the JSONB `||`-concatenation
   trick from the previous round, not just a different way of expressing
   the same one.
3. **httpOnly cookie auth, replacing localStorage.** The JWT no longer
   exists anywhere client-side JS can read it - `backend/auth/controller.js`
   sets it via `res.cookie(..., { httpOnly: true, ... })` on login/verify
   instead of returning it in the JSON body, and a new `POST
   /api/auth/logout` clears it server-side. This is a strict security
   improvement: an XSS payload that could previously read `localStorage`
   and steal a session token now can't touch it at all. **Verified the
   full lifecycle live**, not just written: login sets the cookie with no
   token in the response body, the cookie authenticates protected routes,
   and logout actually clears it - which caught a real bug along the way
   (see below). The entire frontend was refactored to match: no more
   `localStorage`, `apiFetch` sends `credentials: "include"` on every
   request, and every hook/service dropped its `token` parameter in favor
   of a simple `enabled`/`!!user` flag. **Caught and fixed a real bug
   during this**: the first version of `clearCookie()` still included
   `maxAge`, which made Express set the cleared cookie's expiry 30 days in
   the *future* instead of actually deleting it - confirmed via the raw
   `Set-Cookie` header before and after the fix.
4. **Reservation expiry.** `listings.reserved_at` is stamped when checkout
   claims a listing. A periodic sweep (`releaseExpiredReservations`, run
   every 5 minutes from `server.js`, and directly callable - tests call it
   synchronously rather than waiting on a timer) releases anything still
   `reserved` past `RESERVATION_TTL_MINUTES` (default 30) back to `active`
   and marks the associated transaction `expired`. This is the cleanup the
   fourth round's README flagged as missing for buyers who abandon
   checkout without Stripe ever sending a failed/canceled webhook.
5. **AI race condition - found a real design flaw, not just a theoretical
   one.** The first attempt (an `ai_reply_pending` flag, cleared once the
   reply finished generating) looked race-safe but wasn't: a **test**
   proved that two buyer messages sent close together could still produce
   *two* AI replies, because the first one's claim was released as soon as
   it completed - fast enough (with the mocked AI call) that a second
   message's trigger could claim it again afterward, not just during. The
   actual fix: `ai_replied` is a **permanent** flag per conversation (never
   reset), so at most one AI-generated reply exists while waiting for the
   real seller, not just "no two generating at the exact same instant."
6. **Concurrent message writes** - resolved by #2 (a normalized table has
   no shared mutable field to race over), and verified with an actual
   concurrency test: two replies fired via `Promise.all` at the same
   conversation both land as distinct rows with nothing lost.
7. **Production email verification.** `sendVerificationEmail` now retries
   once with backoff on transient SMTP failures. More importantly: a
   genuine send failure (not the intentional local-dev fallback) now
   surfaces to the user via a `warning` field the frontend shows as a
   toast - previously, a real email outage in production would have left
   someone with an unverifiable account and zero indication anything went
   wrong, since there's no `devCode` fallback outside development.
8. **Payment/webhook edge cases.** Two real ones handled, both with test
   coverage using a mocked Stripe SDK (never a real network call, but every
   line of *our* logic runs for real against the real test database):
   - **Idempotency** - Stripe redelivers webhook events; the same
     `payment_intent.succeeded` event delivered twice now provably
     processes only once (`status = 'pending'` guards prevent reprocessing
     an already-settled transaction).
   - **Late payment after expiry** - if the reservation-expiry sweep (or a
     failure webhook) already released a listing and *then* the original
     payment actually succeeds on Stripe's side, the app can't safely honor
     it (the item may already be gone) - it now automatically refunds the
     late payment via the Stripe API and flags it loudly for manual
     review, rather than either silently keeping the money or incorrectly
     marking the listing sold again.
9. **Comprehensive automated tests.** Grew from 13 to 22, including a new
   `tests/transactions.test.js` covering the full checkout → webhook flow,
   idempotency, expiry, and the late-payment edge case above - achieved by
   mocking only the `stripe` npm package itself, so real application logic
   (the atomic claim, the webhook handler, the sweep) runs against the real
   Postgres test database rather than being tested by inference. Ran the
   full suite three times back-to-back to confirm the concurrency/race
   tests aren't flaky.

## Architecture

```
                   ┌───────────────┐
                   │    React      │
                   │    Frontend   │
                   └───────┬───────┘
                           │
                           ▼
                   ┌───────────────┐
                   │ REST API      │
                   │ Express       │
                   └───────┬───────┘
                           │
             ┌─────────────┼─────────────┐
             │             │             │
             ▼             ▼             ▼
        ┌────────┐   ┌──────────┐   ┌─────────┐
        │ Auth   │   │ Business │   │ Stripe  │
        │        │   │ Services │   │         │
        └────────┘   └────┬─────┘   └─────────┘
                          │
                          ▼
                    ┌───────────┐
                    │PostgreSQL │
                    └───────────┘
```

**Fifth round migrated the app onto this shape.** Concretely:

- **PostgreSQL, not SQLite.** `backend/db.js` now wraps a `pg` connection
  pool instead of `better-sqlite3`. Every query moved from synchronous
  `?`-placeholder SQL to async `$1/$2`-placeholder SQL. This wasn't just a
  driver swap - a few things got genuinely better in the process:
  - **Messages briefly lived as `JSONB`, now a real table.** The fifth
    round moved messages from a SQLite text blob to a Postgres `JSONB`
    array with atomic `||` concatenation, which fixed the original
    clobbering risk. The sixth round went further and gave messages their
    own table entirely (see "Sixth round" above) - normalized, individually
    queryable/indexable, and with no shared mutable field to race over at
    all, which is a stronger guarantee than the JSONB approach was.
  - **Timestamp comparisons are native.** The SQLite version needed a
    workaround because `datetime('now')` and JS's `toISOString()` didn't
    always compare correctly across timezones (a real bug an earlier round
    hit and fixed). Postgres's `TIMESTAMPTZ` type and `now()` handle this
    correctly without a workaround.
  - `.changes`/`.lastInsertRowid` became `rowCount`/`RETURNING id` - most
    relevant in the checkout race-condition fix (see "Fourth round" below),
    which still atomically claims a listing via
    `UPDATE ... WHERE status = 'active'`, just checking Postgres's
    `rowCount` instead of SQLite's `.changes`. **Re-verified this still
    works after the migration**, the same way it was first verified: a
    temporary artificial delay, two genuinely concurrent requests, one gets
    the reservation, the other gets a clean `409`.
- **A real service layer.** Each domain (`auth`, `listings`, `messages`,
  `favorites`, `reviews`, `transactions`, `connect`, `users`) now has a
  `backend/services/*Service.js` module holding all the actual logic
  (validation, business rules, database access) with no Express `req`/`res`
  in sight - just plain functions that take data and return data or throw a
  typed error (`AuthError`, `ListingError`, etc., each carrying an HTTP
  status). The route controllers became thin: parse the request, call the
  service, translate the result (or thrown error) into a response. This is
  the "Business Services" box in the diagram above, and it's what makes the
  services testable independent of HTTP or the specific web framework.
- **Tests now run against a real, separate Postgres database**
  (`parentos_test`), truncated before each test file via
  `tests/dbReset.js`, instead of a fresh SQLite `:memory:` instance per
  file. **This surfaced a real bug during the migration**: the seeding
  guard (`INSERT the demo user if the listings table is empty`) doesn't
  account for one test file's leftover users colliding with the demo
  seed's hardcoded `id=1` once tests share one real database instead of
  each getting an isolated in-memory one. Fixed by never seeding during
  `NODE_ENV=test` - tests create their own users through the API anyway and
  never needed the seed data.

## What's implemented

- **Every user is both a buyer and a seller** - one `users` table, one
  login, no separate account type. Sign up, email verification (simulated -
  see note below), login, JWT sessions, bcrypt-hashed passwords.
- **Listings**: reference `seller_id`. Browse, filter by category/
  condition/search text, and by distance from a chosen area or your live
  location. Full ownership lifecycle: edit, delete, reserve, mark sold, and
  relist - manageable from "My listings" on your profile.
- **Conversations & messages**: `conversations` has `buyer_id` and
  `seller_id`, both real foreign keys to `users`. A single unified inbox
  (`GET /api/messages/conversations`) shows every conversation you're in,
  whether you're buying or selling, each with a live **unread count**
  (`buyer_last_read_at` / `seller_last_read_at` track what each side has
  seen). Messages are embedded on the conversation as a JSON array. An AI
  auto-reply (via the Anthropic API, server-side) answers using the
  listing's real details until the seller responds personally.
- **Favorites & reviews**: favorite a listing; leave a 1-5 star review for
  another user, with an aggregate shown on their public profile.
- **Images live in object storage**, not embedded as base64. A pluggable
  storage layer (`backend/storage`) uses real S3-compatible storage (AWS S3,
  Cloudflare R2, MinIO, etc.) when configured, and falls back to local disk
  (`backend/uploads/`, served at `/uploads`) otherwise - runs out of the box
  without a cloud account, same code path goes live once you add real
  credentials.
- **Transactions**: real Stripe (test mode) checkout. `POST
  /api/transactions/checkout` creates a Stripe PaymentIntent for item price
  + delivery fee, calculates the platform commission, and a `transactions`
  row tracks it all. A webhook marks the transaction paid and the listing
  sold once Stripe confirms payment. See **Payments setup** below - this is
  the one piece needing your own (free) Stripe account before it processes
  a real payment.

## Payments setup (required for checkout to work)

Checkout is real, working code against Stripe's actual API - but unlike
everything else in this project, I couldn't run-test an end-to-end payment
myself, since that requires a live Stripe test account, which only you can
create:

1. Sign up at https://dashboard.stripe.com/register (free, no business
   verification needed for test mode).
2. From the Stripe Dashboard (test mode), copy your **Secret key** and
   **Publishable key** into `backend/.env` as `STRIPE_SECRET_KEY` and
   `STRIPE_PUBLISHABLE_KEY`.
3. For the webhook (marks a transaction "paid" and the listing "sold"),
   install the Stripe CLI and run:
   `stripe listen --forward-to localhost:4000/api/transactions/webhook`
   - it prints a webhook signing secret; put that in `STRIPE_WEBHOOK_SECRET`.
4. Test with Stripe's test card `4242 4242 4242 4242`, any future expiry,
   any CVC.
5. Enable Stripe Connect in your dashboard's test mode settings, then from
   your profile page click "Set up payouts" to go through Stripe's hosted
   Express onboarding (see the "Fourth round" section below). Also add
   `stripe listen --forward-to localhost:4000/api/transactions/webhook -e account.updated`
   so status changes propagate.

Seller payouts via Stripe Connect are now built (see "Fourth round" below)
- checkout automatically routes the seller's share to their connected
  account once they've onboarded, instead of the platform keeping 100%.

## Auth API

```
POST /api/auth/signup        create account, issues a verification code (15 min expiry)
POST /api/auth/verify        confirm the code (max 5 attempts before lockout); sets the session cookie
POST /api/auth/resend-code   issue a fresh code, resetting the attempt counter
POST /api/auth/login         rate-limited; one generic error for bad email or bad password; sets the session cookie
POST /api/auth/logout        clears the session cookie
POST /api/auth/logout-everywhere  ends all OTHER sessions (bumps session_version), keeps the current device signed in
GET  /api/auth/me            current user, from the session cookie (httpOnly - no token in JS, ever)
```

## Listing ownership API

```
GET    /api/users/me/listings     your listings, every status included
POST   /api/listings              create
PATCH  /api/listings/:id          partial edit (any subset of fields)
DELETE /api/listings/:id          delete - blocked if a buyer has already
                                   messaged about it (mark sold instead, so
                                   their conversation isn't orphaned)
POST   /api/listings/:id/reserve  status -> reserved
POST   /api/listings/:id/sold     status -> sold
POST   /api/listings/:id/relist   status -> active, and bumps created_at so
                                   it resurfaces at the top of the feed
```

The public `GET /api/listings` feed only returns `status = 'active'` items -
reserved and sold listings drop out of browsing automatically but remain
visible (with a status badge) under "My listings".

## Messaging API

```
GET  /api/messages/conversations              every conversation you're in
POST /api/messages/conversations/:id/reply    reply, as whichever role you are
POST /api/messages/conversations/:id/read     mark read without replying
GET  /api/messages/thread?listingId=          find/start "my thread" about a listing
POST /api/messages/thread                     start or continue that thread as buyer
```

## Transactions API

```
POST /api/transactions/checkout   atomically claim the listing + create a Stripe PaymentIntent
POST /api/transactions/webhook    Stripe calls this on payment success/failure/Connect updates
GET  /api/transactions/mine       your purchase & sales history
```

## Connect API (seller payouts)

```
POST /api/connect/onboard   create/continue Stripe Express onboarding, returns a hosted URL
GET  /api/connect/status    whether the seller's account can currently receive payouts
```

## Security fixes applied

A review flagged five issues; here's the current state of each:

1. **Messaging auth** - already correct as of the relational-model refactor:
   `/api/messages/thread` requires a valid JWT and scopes strictly to
   `req.user.id`, not a client-supplied name. Verified with an
   unauthenticated request (`401 Not logged in.`).
2. **PII leak / account enumeration** - `GET /api/users/:id` no longer
   returns `email` in the response. Login now returns one generic
   `"Invalid email or password."` (401) whether the account doesn't exist
   or the password is wrong, and runs `bcrypt.compare` against a dummy hash
   in the no-account case so the response time doesn't leak which one it
   was either. (The "verify your email first" message is still distinct,
   but it's only reachable after the correct password has already been
   supplied, so it doesn't add a new enumeration vector.)
3. **Open AI proxy removed.** `POST /api/ai/reply` is deleted - it was never
   used by the app (the messages flow calls the AI function internally, not
   over HTTP) and had no auth, no rate limit, and took an attacker-supplied
   `listing` object straight into the prompt.
4. **`devCode` gated behind `NODE_ENV`.** Signup only returns the
   verification code in the response when `NODE_ENV !== 'production'`.
   Make sure `NODE_ENV=production` is actually set in your real deployment
   environment, or this protection does nothing.
5. **Async errors now reach the error handler.** `express-async-errors` is
   loaded at the top of `server.js`, so a rejected promise in any async
   route handler (Anthropic call, DB error, Stripe call, etc.) hits the
   error middleware and returns a 500 instead of hanging the request
   forever. Verified by forcing a deliberate throw in a temporary test
   route and confirming it returned instantly rather than timing out.
6. **Rate limiting + verification code hardening.** `express-rate-limit` on
   `/auth/login`, `/auth/signup`, `/auth/verify`, and the new
   `/auth/resend-code`. The 6-digit verification code now expires after 15
   minutes and locks after 5 wrong attempts (`429`, with a
   `POST /api/auth/resend-code` to get a fresh one) - previously it never
   expired and had no attempt limit at all, so it was a ~1-in-a-million
   brute force away from account takeover.
7. **CORS pinned to an allowlist.** `CORS_ORIGINS` in `.env` (defaults to
   `http://localhost:5173`) instead of allowing every origin. Originally
   written when the JWT lived in `localStorage` (read-access risk); since
   the sixth round moved auth to an httpOnly cookie (see above), the
   allowlist is now what makes `credentials: true` CORS safe at all - an
   open origin policy combined with a credentialed cookie would be a CSRF
   risk instead.
8. **Fails fast on missing/placeholder `JWT_SECRET`.** The server now exits
   at boot with a clear message if `JWT_SECRET` is unset, and refuses to
   start in production if it's still the example placeholder value -
   instead of 500ing on every login attempt with a confusing error.
9. **JWT now uses the standard `sub` claim for user id**, not email -
   `jwt.sign({ sub: user.id, ... })`. Tokens survive an email change and
   every part of the app already keyed off `req.user.id`, not email.
10. **Listings support pagination and a distance bounding-box prefilter.**
    `GET /api/listings` takes `limit`/`offset` (default 20, capped at 100).
    SQLite has no built-in trig functions, so exact Haversine distance
    still can't be computed in SQL - but when a max distance is given, a
    cheap `lat/lng BETWEEN` bounding box (backed by a new
    `idx_listings_latlng` index) now narrows the candidate rows in SQL
    *before* the exact distance calculation and sort happen in JS, instead
    of scoring every active listing in the database on every distance
    search.
11. **Listing ownership lifecycle** (edit/delete/reserve/sold/relist,
    `requireOwnedListing` helper) - this was already fully built in an
    earlier round; confirmed still intact.
12. **Image uploads are re-processed server-side, not trusted from the
   client.** The upload route now decodes the image with `sharp`, resizes
    to a max 1280px side, re-encodes as JPEG (which also strips embedded
    metadata), and rejects anything that isn't actually a valid image or is
    still over 3MB after processing - verified with a payload claiming to
    be a PNG that was actually garbage bytes, which is now correctly
    rejected instead of stored. Separately, the app's default JSON body
    limit was cut from a blanket 8MB to 300KB; only the uploads route gets
    a larger (6MB) limit, so an oversized payload to an unrelated endpoint
    like `/auth/login` is now rejected with a proper `413` instead of being
    accepted or (as it briefly was mid-fix) crashing into a generic 500.

## Fifth round: five flagged issues, fixed and verified

1. **Public seller email leak.** Every listing response (including the
   public, unauthenticated `GET /api/listings` feed) was joining and
   returning the seller's raw email address - and the frontend never even
   used it. Removed entirely from `LISTING_SELECT`. Verified live: the
   field is now absent from every listing response.
2. **Double-purchase / payment race condition.** `checkout()` used to
   check `listing.status !== 'active'` and only write to the database
   afterward - two concurrent buyers could both pass that check before
   either write happened. Fixed with an atomic claim:
   `UPDATE listings SET status = 'reserved' WHERE id = ? AND status = 'active'`,
   checking `.changes` - only one concurrent request can ever win that
   update. **This was genuinely tested**, not just reasoned about: I added
   a temporary artificial delay to simulate real Stripe latency, fired two
   truly concurrent requests at the same listing, confirmed one got a real
   reservation and the other got `409 "no longer available"`, then removed
   the delay and reconfirmed the full test suite still passes. The claim
   is released back to `active` if Stripe fails, and the webhook now also
   handles `payment_intent.payment_failed`/`canceled` to release it if the
   buyer's payment doesn't go through.
3. **Seller payout via Stripe Connect.** Sellers can now onboard a Stripe
   Express account (`POST /api/connect/onboard` returns a hosted
   onboarding URL; `GET /api/connect/status` checks readiness) from a new
   "Getting paid" card on their profile. Once onboarded, checkout
   automatically routes `total - commission` to the seller's account via
   Stripe's destination-charge pattern (`transfer_data` +
   `application_fee_amount`) instead of the platform keeping 100% - a
   webhook (`account.updated`) keeps the cached enabled-flags in sync.
   **Caveat, same as the rest of the Stripe integration:** I built and
   validated this against Stripe's real, documented API and every
   validation path (missing config, unauthenticated, etc.), but actually
   completing Connect onboarding and watching a real destination charge
   land requires your own Stripe test account - I can't do that from here.
4. **Real email verification.** `backend/email/` sends real verification
   emails via SMTP (any provider - Postmark, SES, SendGrid, Gmail, etc.)
   when `SMTP_HOST`/`SMTP_USER`/`SMTP_PASS` are set, with bounded 5s
   timeouts so a broken SMTP config can't hang signup. Without SMTP
   configured, it logs the email to the console instead of silently doing
   nothing - verified this fires on every signup. `devCode` in the
   response is now a dev/test convenience layered on top of real sending,
   not a replacement for it, and remains fully suppressed in production
   regardless of SMTP configuration.
5. **Transaction-based reviews.** Previously any user could review any
   other user with just a rating and an optional listing reference -
   verified live that this is now rejected (`403`) unless a real `paid` or
   `completed` transaction exists between the reviewer and reviewee for
   that specific listing. `listing_id` on reviews is now required, not
   optional, since every review must be traceable to a real transaction.

## Fourth round: reliability, correctness, and dev workflow

13. **AI auto-reply is generated out-of-band.** Sending a message used to
    block on the Anthropic call - now the buyer's message is saved and the
    response returned immediately (measured ~9ms locally), and the AI reply
    is generated afterward and appended once ready. The frontend polls
    briefly to pick it up. Failures are now logged with the conversation id
    instead of silently vanishing into the canned fallback text.
14. **Fixed the model id.** `ai/controller.js` was calling a model string
    that doesn't correspond to any current Anthropic model - it was failing
    silently into the fallback text with nothing in the logs to explain why
    (compounded by #13's original swallowed-error bug). Both are fixed now:
    a real current model id, and the API's actual error response is logged
    when a call fails.
15. **Explicit `ON DELETE` behaviour on every foreign key.** Previously
    left to SQLite's implicit default. There's no account-deletion feature
    yet, so this doesn't change current behaviour - it's precautionary, and
    the `RESTRICT` choices will need revisiting (probably toward a
    soft-delete or anonymization approach) once that feature actually
    exists, since as written it would block deleting any user who has ever
    listed, messaged, reviewed, or transacted. (The `seller_name` staleness
    concern this was raised alongside doesn't apply here - it was never a
    stored column; every query joins `users` live, so it can't go stale.)
16. **A real test suite, a linter, CI, and Dockerfiles.** `backend/tests/`
    has Jest + Supertest coverage for auth (signup/verify/lockout/resend,
    enumeration-resistant login, the `/me` endpoint) and message
    authorization (unauthenticated rejection, a third party can't read or
    reply to someone else's conversation, a seller can't message their own
    listing) - 13 tests, all passing. Both `frontend` and `backend` have
    ESLint configs and lint clean. `.github/workflows/ci.yml` runs lint +
    test + build on push/PR. **Caveat:** I built and ran the tests/lint
    myself and they pass for real - the `Dockerfile`s and
    `docker-compose.yml` are written correctly against the app's actual
    structure, but this sandbox has no Docker daemon, so unlike everything
    else in this project, I could not actually build or run the containers
    myself. Worth a real `docker compose up` before trusting them blindly.
17. **Frontend hygiene**: an `ErrorBoundary` around the whole app (a render
    crash now shows a recoverable message instead of a blank screen -
    though note React error boundaries never catch errors in event
    handlers or async code, only render errors); every data-fetching hook
    (`useListings`, `useMyListings`, `useFavorites`, `useAuth`) now cancels
    its request via `AbortController` on unmount or re-fetch instead of
    letting a stale response call `setState` after the fact; and a shared
    `useToast` hook replaces two separate copies of a toast timer that
    never cleared itself (a new toast could get wiped early by an old
    timer, and neither cleared on unmount).

## Planned redesign: explicit checkout attempts

Recorded here so it's a decision with a trigger rather than a vague
intention.

**The current design.** Checkout reserves the listing, calls Stripe, then
writes the transaction:

```
UPDATE listings SET status = 'reserved'   (Postgres)
            v
create PaymentIntent                      (Stripe)
            v
INSERT transaction + audit event          (Postgres, one transaction)
```

Two systems, three steps. The middle step can succeed while the process
dies before the third, leaving a reserved listing and possibly a live
PaymentIntent with no order. Postgres and Stripe cannot be made atomic, so
this cannot be closed by wrapping it in a transaction - only detected and
cleaned up.

**Why it's acceptable now.** Three independent mechanisms cover it:

- the expiry sweep releases reservations older than the TTL, whether or not
  a transaction row exists
- the failure path cancels the PaymentIntent and releases the reservation
- reconciliation compares both systems in **both directions** - the reverse
  pass exists specifically because the forward pass is structurally blind
  to a PaymentIntent whose transaction row was never written

The window is also now instrumented (`checkout_window_closed` on success,
`checkout_window_failed` on the failure path, both with `windowMs`), so its
size and failure rate are measurable rather than assumed.

**What would replace it.** An explicit checkout-attempt record written
*before* Stripe is called:

```
INSERT checkout_attempt (pending)         (Postgres)
            v
create PaymentIntent, attach attempt id   (Stripe)
            v
attempt -> completed + transaction        (Postgres)
```

Every PaymentIntent then has a local row from the moment it exists, so an
interrupted checkout is a row in a known state rather than something
reconciliation has to go looking for. It also makes the attempt idempotent:
a retried checkout finds its own attempt instead of creating a second
PaymentIntent.

**Trigger for doing it.** Any of:

- `checkout_window_failed` exceeding roughly 0.1% of checkouts
- any `orphaned_payment_intent` reaching a real customer rather than being
  caught by reconciliation first
- p99 `windowMs` above ~2 seconds, which widens the exposure
- more than one API instance handling checkout for the same catalogue at
  meaningful volume

Doing it before any of those fire would be building for load that hasn't
been measured - the instrumentation exists precisely so that call is made
on evidence.

## Known limitations to fix before a real launch

1. **Area/pincode data is a small hand-built lookup table** (in
   `backend/areaData.js` and `frontend/src/constants.js`, kept in sync by
   hand). Coordinates are approximate. Replace with a real geocoding
   service if you need accuracy or wider coverage.
2. **The container build itself has never run**, though what it installs
   has. There's no Docker in the development sandbox, so `docker compose
   build` is unexecuted. What *has* been verified is the layer underneath:
   a `npm ci --omit=dev` install (exactly what the Dockerfile runs) booting
   with `NODE_ENV=production` against real Postgres and Redis, serving
   200s, with every file the image needs confirmed to be inside the build
   context. That caught a real bug; it is still not the same as building
   the image.
3. **CSRF protection is a double-submit token, but without per-request
   rotation.** State-changing endpoints require a `x-csrf-token` header
   matching the `parentos_csrf` cookie, compared with
   `crypto.timingSafeEqual`, layered on top of `SameSite=Lax`. The Stripe
   webhook is deliberately exempt (it isn't browser-initiated and carries
   its own signature over the raw body). The remaining gap is that a token
   is issued per session rather than rotated per request, so a token
   leaked through some other channel stays valid for the session's
   lifetime; per-request rotation would be the stricter posture.

4. **Rate limits are stored in-process.** `express-rate-limit` defaults to
   an in-memory store, so every application instance keeps its own
   counters. Behind a load balancer with N instances the effective limit
   is roughly N times the configured one, and all counters reset on
   deploy. Redis is now a supported dependency (see the queue), so wiring
   `rate-limit-redis` is the remaining step.
5. **A silent seller still can't be reviewed.** Disputes can now be
   resolved (`POST /api/transactions/:id/resolve-dispute`), which closes
   most of this gap - an admin upholding a disputed order moves it to
   `completed`, making it reviewable. But a seller who takes payment and
   simply goes quiet, with no dispute ever raised, leaves the order at
   `paid` forever and unreviewable. An automatic sweep that escalates
   long-unfulfilled orders would close it.
6. **Real-time updates are polling, not push.** Messages and notifications
   poll on an interval, which is simple and fine at current volume but
   won't scale to many concurrent users.
7. **No production infrastructure.** Redis, background job queues, object
   storage for images (currently local disk), monitoring, error tracking
   and backups are all deferred. These were consciously left until there's
   real usage to size them against, and the structured logging added in
   the fourteenth round is what should inform which are needed first.

## Running it locally

### 1. PostgreSQL

```bash
# macOS: brew install postgresql; Linux: apt-get install postgresql
createdb parentos
createdb parentos_test   # used by the test suite - see "Tests & linting" below
```

Or skip this entirely and use `docker compose up postgres` (see "Docker"
below) instead of a local install.

### 2. Backend

```bash
cd backend
cp .env.example .env
# fill in DATABASE_URL (defaults to postgres://postgres:postgres@localhost:5432/parentos),
# JWT_SECRET, ANTHROPIC_API_KEY, and (for checkout) your Stripe test keys
npm install
npm run dev                # http://localhost:4000
```

Pending migrations (`database/migrations/`) run automatically on first
start, and the database is seeded with a few demo listings
(`database/seed.sql`) if it's empty. Demo login: `demo@example.com` /
`demo1234`. To run migrations as an explicit, separate step instead (e.g.
in a deploy pipeline) rather than relying on the automatic boot-time check:
`npm run migrate`.

### 3. Frontend

```bash
cd frontend
cp .env.example .env       # defaults already point at localhost:4000
npm install
npm run dev                # http://localhost:5173
```

Open http://localhost:5173 - the Vite dev server proxies `/api` requests to
the backend automatically (see `frontend/vite.config.js`).

### Tests & linting

```bash
cd backend && npm test    # Jest + Supertest, against a real parentos_test Postgres database
cd backend && npm run lint
cd frontend && npm run lint
```

If your Postgres isn't on `localhost:5432` with the default
`postgres`/`postgres` credentials, set `TEST_DATABASE_URL` before running
`npm test` (see `tests/setupEnv.js`).

### Docker (unverified - see note in "Third round" below)

```bash
docker compose up --build
```

## Project structure

```
frontend/src/
  components/   ListingCard, ListingGrid, ListingDetails, SearchFilters,
                SellForm, AuthModal, ChatThread, Inbox, Checkout,
                ErrorBoundary
  app/          routes.jsx - the route table, separate from the shell
  features/     one folder per domain (auth, listings, marketplace,
                messaging, orders, payouts, moderation, notifications,
                profile), each with its own components/ and hooks/
  pages/        Home, Marketplace, Listing, Profile, Messages,
                SellerProfile (public seller view), Moderation (admin
                queue) - thin composition over features/
  hooks/        useAuth, useListings, useMyListings, useMessages,
                useLocation, useFavorites, useToast
  services/     auth, listings, messaging, favorites, reviews, uploads,
                transactions, connect

backend/
  services/      *Service.js per domain - all actual logic (validation,
                  business rules, Postgres access) lives here, with no
                  Express req/res. This is the "Business Services" layer
                  in the architecture diagram above.
  auth/           thin controller + routes for signup/verify/login/logout/
                  me, delegating to services/authService.js;
                  cookieConfig.js holds the shared httpOnly cookie settings
  listings/       thin controller + routes: list (active only) / mine (all
                  statuses) / get / create / update / delete / reserve /
                  sold / relist, delegating to services/listingsService.js
  users/          public profile (name, verified, listing count, review
                  aggregate - never email), delegating to
                  services/usersService.js
  messages/       unified conversations (buyer or seller role), unread
                  tracking, reply, mark-read, listing-scoped thread start,
                  delegating to services/messagesService.js - messages
                  themselves are their own table (see
                  backend/database/migrations/001_initial.sql), not embedded on
                  the conversation
  favorites/      thin controller + routes for services/favoritesService.js
  reviews/        thin controller + routes for services/reviewsService.js -
                  every review requires a real 'paid'/'completed'
                  transaction between reviewer and reviewee for the listing
  transactions/   Stripe checkout (atomic reservation claim, idempotency
                  key, orphaned-PaymentIntent cleanup), webhook (idempotent,
                  handles late-payment-after-expiry), purchase/sales
                  history, and the periodic releaseExpiredReservations
                  sweep - all in services/transactionsService.js
  connect/        Stripe Connect seller onboarding, delegating to
                  services/connectService.js
  images/         upload endpoint backed by backend/storage
  storage/        pluggable image storage - S3-compatible or local disk,
                  including deleteImage() cleanup on listing delete and
                  photo replacement
  ai/             server-side Anthropic call (configurable model via
                  ANTHROPIC_MODEL, bounded by AI_TIMEOUT_MS) - called
                  directly by messagesService, no HTTP route of its own
  stripeClient.js shared Stripe client used by both transactionsService
                  and connectService
  email/          pluggable verification-email sending - real SMTP (with
                  retry) or a logged dev fallback; surfaces genuine send
                  failures to the caller rather than always claiming success
  services/orderStateMachine.js  every status change goes through
                  transitionOrder(): validation, timestamps, audit event,
                  trust counters and notifications in one place
  requestContext.js  AsyncLocalStorage request-id propagation
  configCheck.js  refuses to boot on unsafe production configuration
  errorTracking.js  vendor-agnostic exception reporting (no-op unless configured)
  queue/          BullMQ job queue; disabled (and bypassed) without REDIS_URL
  worker.js       separate worker process - npm run worker
  reconciliation/ Stripe-vs-database discrepancy detection (admin)
  transactionStatus.js  single source of truth for order statuses and
                  what they mean (money captured vs deal concluded)
  logger.js       structured JSON logging with credential redaction
  config.js       single source of truth for marketplace configuration
                  (fees, commission, vocabularies, limits) - exposed to
                  the frontend via GET /api/meta/config
  meta/           public config endpoint
  analytics/      seller performance, per-listing stats, platform health
  notifications/  in-app notification list, mark-read, email preference
  moderation/     reports, blocks, and moderator actions (queue, takedown,
                  restore, resolve) - admin check lives in the service
  db.js           PostgreSQL connection pool; initDb() runs pending
                  migrations then seeds if empty
  migrate.js      migration runner (npm run migrate) - see database/migrations/
  middleware/     requestLogger (request ids + timing), optionalAuth
                  (attributes a view without requiring a login), requireAuth
                  (verifies the session cookie AND that the
                  token's session_version is still current), csrf.js
                  (double-submit token on state-changing requests),
                  rateLimit, and validateId.js (rejects a
                  non-numeric route-param id with a clean 400 before it
                  can reach Postgres as a raw type error)
  utils/          validation.js's parseId() - the body-field-id equivalent
                  of middleware/validateId.js, used inside services
  tests/          Jest + Supertest (345 tests), run against a real
                  parentos_test database - dbReset.js truncates it before
                  each test file, helpers.js's createVerifiedUser returns a
                  cookie-carrying supertest agent, transactions.test.js and
                  listings.test.js mock only the `stripe` npm package so
                  checkout/webhook/expiry/state-machine logic runs for real
                  against real Postgres

database/
  migrations/   001_initial.sql (baseline schema), 002_state_invariants.sql
                (unique PaymentIntent id, one pending transaction per
                listing, reserved_at/status CHECK), 003_session_versioning.sql
                (revocable sessions), 004_full_text_search.sql (indexed
                tsvector + GIN for search), 005_reports_and_blocks.sql
                (reporting, blocking, moderator takedowns),
                006_notifications.sql (stored notifications + email
                preference), 007_trust_signals.sql (materialized trust
                counters, backfilled), 008_postgis.sql (spatial index,
                skipped gracefully if PostGIS isn't available),
                009_analytics.sql (listing views),
                013_transaction_events.sql (order audit trail),
                014_reconciliation.sql (Stripe discrepancies),
                015_geocoding.sql (geocode cache),
                010_order_completion.sql (order_completed notification
                type), 011_transaction_lifecycle.sql (fulfilled/disputed
                states + transition timestamps),
                012_trust_counters_completed_only.sql (counters count
                completions, not payments), 013_transaction_events.sql
                (append-only order audit trail) - every future schema
                change is a new numbered file here, never an edit to an
                already-applied one (see backend/migrate.js)
  seed.sql      a few demo listings + a demo seller account (dev/demo only
                - never run during tests, see the "Architecture" section)
```
