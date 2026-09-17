# ParentOS / Uusiksi

A curated second-hand marketplace for Finnish families, built as a real,
runnable app: React frontend, Express backend, PostgreSQL database, Stripe
Connect for payments and payouts, and a React Native (Expo) mobile app - all
three clients (web, mobile, and the backend itself) share the same versioned
API, `/api/v1`.

## Stack

- **Frontend** - React + Vite
- **Mobile** - React Native (Expo) - see [mobile/README.md](mobile/README.md)
- **Backend** - Node + Express, layered `routes → services → PostgreSQL`
- **Database** - PostgreSQL (+ PostGIS for geosearch, optional)
- **Queue** - BullMQ + Redis (optional; falls back to in-process)
- **Payments** - Stripe + Stripe Connect
- **AI** - Anthropic API for buyer/seller message assistance

## Quick start

Requires **Node 18+** and **PostgreSQL 16**.

```bash
cp backend/.env.example backend/.env   # then fill in real secrets
npm run migrate                        # applies all migrations
npm run dev:backend                    # http://localhost:4000
npm run dev:frontend                   # http://localhost:5173 (proxies /api)
```

```bash
npm run verify   # migrate + lint + full test suite + frontend build + smoke test
```

`verify.sh` is the single source of truth for "does this pass" - it installs
both workspaces, runs migrations, lints, runs the backend test suite against
a real `parentos_test` Postgres database, builds the frontend, and smoke-tests
a running server. Tests deliberately hit a real database rather than mocks.

Other useful scripts (run from `backend/`): `npm test`, `npm run journey`
(full purchase flow against real Stripe test-mode keys), `npm run e2e`
(signup-to-deletion against a local Stripe fake), `npm run smoke:stripe`,
`npm run worker`, `npm run reconcile`.

## Project structure

```
frontend/src/
  app/          route table + shell
  features/     one folder per domain (auth, listings, marketplace,
                messaging, orders, payouts, moderation, notifications, profile)
  pages/        thin composition over features/
  hooks/        services/  shared hooks and API clients

backend/
  <domain>/     thin controller + routes per domain (auth, listings, users,
                messages, favorites, reviews, transactions, connect, images,
                moderation, analytics, notifications, meta)
  services/     all business logic and Postgres access lives here
  storage/      pluggable image storage (S3-compatible or local disk)
  email/        pluggable verification email (SMTP or dev console fallback)
  ai/           Anthropic-backed message assistance
  queue/        BullMQ job queue (bypassed without REDIS_URL)
  tests/        Jest + Supertest, against a real database
  database/
    migrations/   one numbered file per schema change, never edited after landing
    seed.sql      demo data (dev only, never run in tests)

mobile/         React Native (Expo) app - same backend, /api/v1
```

## Docs

- [DEPLOYMENT.md](DEPLOYMENT.md) - what's been verified in production and what hasn't
- [CHANGELOG.md](CHANGELOG.md) - detailed round-by-round development history
- [legal/](legal/) - draft policies (Terms, Privacy, Cookies) - **drafts only, need legal review**
