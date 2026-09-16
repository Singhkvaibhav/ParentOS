# Uusiki mobile app

A React Native (Expo) app implementing the Uusiki marketplace screens,
talking to the **same backend and database as the web frontend** — this is
one repo now:

```
ParentOS/
├── backend/    Express + PostgreSQL API
├── frontend/   React + Vite web app
└── mobile/     this app
```

All three clients talk to the same versioned backend API, `/api/v1` (see
`backend/config.js`'s `API_PREFIX`) — mobile through Bearer-token routes
under `/api/v1/auth/mobile/*`, the web frontend through the same routes
using an httpOnly cookie instead, since a native app has no cookie jar.
Sign in on the app and the account, listings, orders and messages are the
actual rows in that backend's database, not sample data.

## What's here

- **Screens**: Login/Sign up/Verify (the real signup → emailed code → verify
  flow, ending signed in — see `AuthGate.tsx`), Browse (feed + real category/subcategory filters from
  `GET /api/v1/meta/config`), Search (full-text search), Sell (create listing,
  with category/subcategory/condition/city/area pickers matching the
  backend's actual taxonomy), Chat (conversation list + a thread view, both
  listing-scoped-new and ongoing), "Buy now" pays for real via Stripe's
  PaymentSheet against the actual `POST /api/v1/transactions/checkout`
  PaymentIntent, Orders (purchases/sales through the real
  pending → paid → fulfilled → completed lifecycle), Home (ParentOS
  landing), Account (email verification status, Stripe Connect payout
  setup).
- **Navigation**: two tab shells — Uusiki (Browse/Search/Sell/Chat/Orders)
  and ParentOS (Home/Account) — switchable via the "← ParentOS" link in the
  Uusiki tabs and the "Open Uusiki" card on Home.
- **Auth**: Bearer JWT access + refresh tokens, with automatic refresh-and-retry
  on a 401 via a single shared in-flight refresh promise (see
  `src/api/client.ts`) — concurrent 401s share one refresh call instead of
  each racing to rotate the same refresh token. The token pair itself is
  persisted in `expo-secure-store` (iOS Keychain / Android Keystore-backed
  encryption), not plain `AsyncStorage` — a refresh token is a long-lived
  credential, so it gets OS-backed storage rather than an unencrypted file
  (see `src/state/AuthContext.tsx`).
- **Design tokens**: `src/theme.ts` mirrors the design canvas's colors,
  Archivo font weights, and sharp (0-radius) styling.
- **Payments**: `@stripe/stripe-react-native`'s PaymentSheet, initialized
  lazily with the `publishableKey` the checkout response returns (same
  pattern as the web frontend's `Checkout.jsx`) rather than at app start,
  since the key doesn't exist until a checkout has actually begun. **This
  requires a custom dev client or EAS build — it will not run in plain Expo
  Go**, since Expo Go can't load arbitrary native modules. See "Running it"
  below. Apple Pay and Google Pay are both offered alongside card entry;
  Google Pay works immediately in its test environment, Apple Pay needs a
  real merchant identifier registered with Apple in place of `app.json`'s
  placeholder (`merchant.fi.uusiki.app`) before it'll actually appear on a
  device — harmless to leave configured until then, it just won't show up.
  A ref-based guard in `useListingActions` (`src/screens/FeedScreen.tsx`)
  stops a second "Buy now" for the same listing from firing while the first
  is still in flight, so a double-tap can't reserve the same listing twice.
- **Push notifications**: `src/notifications.ts` requests permission, gets
  an Expo push token, and registers it against the signed-in account
  (`POST /api/v1/notifications/push-token`) — unregistered again on logout so
  a signed-out device stops receiving another account's notifications. This
  rides the backend's existing notification system rather than a separate
  one: every place the backend already calls `notify()` (a new message, an
  item selling, a review, a listing taken down) now reaches this channel
  for free, alongside the email it already sent. Tapping a notification
  routes to the relevant tab (Chat for a message, Orders for a sale) via a
  navigation ref (`src/navigation/ref.ts`), since the push payload carries
  only ids, not the display strings a specific screen like Thread would
  need. **Requires an EAS project id** (`Constants.expoConfig.extra.eas.projectId`)
  to actually obtain a token - run `eas init` once to create/link one; until
  then registration silently no-ops (logged, not thrown) rather than
  crashing. Also needs the dev client (see Payments above), not Expo Go -
  the same requirement, for the same underlying reason.

## Not built yet

- A dedicated listing detail screen — tapping a card in Browse/Search opens
  an action sheet ("Message seller" / "Buy now") that calls the real API
  directly, rather than a separate detail page.
- Product photos on new listings — the Sell form doesn't collect one yet, so
  cards for app-created listings show a placeholder even though the backend
  does support `photo_url` (existing listings created with one, e.g. via the
  web, render it correctly).

## Running it

1. Start the backend (see [`../backend`](../backend) — needs Postgres/PostGIS
   running, e.g. via its `docker-compose`):

   ```bash
   cd ../backend
   npm install
   npm run migrate
   psql "$DATABASE_URL" -f database/seed.sql   # seeds one demo account + listings
   npm run dev    # listens on http://localhost:4000
   ```

2. In this folder, install dependencies and point the app at that backend:

   ```bash
   npm install
   cp .env.example .env   # then uncomment/adjust EXPO_PUBLIC_API_BASE_URL
   npx expo run:ios    # or run:android — builds a dev client, needed for Stripe's native module
   ```

   `npm start` (plain Expo Go) still works for everything except paying for
   something in Buy now — Expo Go can't load the Stripe native module, so
   that one action will fail there. Every other screen works fine under it.

3. `EXPO_PUBLIC_API_BASE_URL` depends on where the app runs relative to the
   backend, and must include the versioned `/api/v1` prefix (see
   `../backend/config.js`'s `API_PREFIX`):
   - iOS simulator on the same Mac as the backend → leave it unset
     (defaults to `http://localhost:4000/api/v1`).
   - Android emulator → `http://10.0.2.2:4000/api/v1` (the emulator's alias
     for the host machine).
   - A physical phone (Expo Go or a dev build) → your computer's LAN IP,
     e.g. `http://192.168.1.23:4000/api/v1` — `localhost` on a phone means
     the phone itself, not your computer.

4. Sign in with the seeded demo account (`demo@example.com` / `demo1234`,
   pre-filled on the login screen), or tap "New here? Create an account" to
   run the real signup → emailed code → verify flow. In development the
   verification code is also returned to the app directly (`devCode`) and
   prefilled, since there's no email inbox to check when running locally
   with `NODE_ENV` unset.

## Verifying it builds

CI (`.github/workflows/ci.yml`, `mobile` job) runs these on every push:

```bash
npx tsc --noEmit          # type-check
npm test -- --runInBand   # Jest (jest-expo preset) — notification routing,
                           # token-refresh dedup logic
```

Locally, a bundle check with no simulator needed:

```bash
npx expo export --platform ios
```
