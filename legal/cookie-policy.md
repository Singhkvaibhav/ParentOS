# Cookie Policy — DRAFT

**[REVIEW] Not legal advice. Have a Finnish lawyer review before publishing.**

Last updated: [FILL IN]

## Cookies this service sets

Taken from the application code, not from a template. If the code changes,
this must change with it — a cookie policy that misdescribes what is stored
is worse than none.

| Cookie | Purpose | Type | Lifetime |
|---|---|---|---|
| `parentos_token` | Keeps you signed in. A short-lived access token, `httpOnly` so page scripts cannot read it, `SameSite=Lax`, and `Secure` in production. | Strictly necessary | 15 minutes |
| `parentos_refresh` | Renews your sign-in without asking for your password again. Scoped to `/api/auth`, so it is not sent with ordinary requests. `httpOnly`, `SameSite=Lax`, `Secure` in production. | Strictly necessary | 30 days |
| `parentos_csrf` | Stops another website performing actions in your account. Readable by our own page, which is how the protection works. | Strictly necessary | Session |

### How the sign-in cookies work together

The access cookie is deliberately short-lived, so a copied one stops being
useful within minutes. The refresh cookie renews it, and **rotates on every
use** — each renewal invalidates the previous refresh token.

That rotation is also how theft is detected. If a refresh token is
presented twice, two parties hold the same credential, so every session in
that chain is ended and you are asked to sign in again. If that happens to
you unexpectedly, change your password: it may mean someone else had a copy
of your session.

Signing out revokes the refresh token on our servers, not just in your
browser — a cookie your browser forgets is still valid to anyone who copied
it. "Sign out everywhere" revokes all of them.

## Cookies this service does NOT set

We do not currently set advertising, analytics, or third-party tracking
cookies. There is no Google Analytics, no advertising pixel, and no
cross-site tracking.

**[REVIEW]** Under the ePrivacy Directive as implemented in Finland,
strictly necessary cookies do not require consent. Because this service
sets *only* strictly necessary cookies, a consent banner is likely not
required — but this is exactly the kind of conclusion to confirm with a
lawyer, and it stops being true the moment any analytics or advertising
tool is added.

## Third parties

**Stripe** sets its own cookies on payment pages for fraud prevention.
Those are governed by Stripe's own policies, not this one. See
`https://stripe.com/cookies-policy/legal`.

## Changing your mind

Because the cookies above are required for signing in and for security,
blocking them will prevent the service from working. They can be cleared
in your browser at any time, which signs you out.
