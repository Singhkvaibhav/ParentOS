# Cookie Policy — DRAFT

**[REVIEW] Not legal advice. Have a Finnish lawyer review before publishing.**

Last updated: [FILL IN]

## Cookies this service sets

This list is taken from the application code, not from a template. If the
code changes, this must change with it.

| Cookie | Purpose | Type | Lifetime |
|---|---|---|---|
| `parentos_token` | Keeps you signed in. Contains a signed session token; `httpOnly` so page scripts cannot read it, and `SameSite=Lax`. | Strictly necessary | 30 days [REVIEW: shortening to a 15-minute access token with refresh rotation is implemented in `tokenService` but not yet the default] |
| `parentos_csrf` | Prevents another website from performing actions in your account. Readable by our own page so it can echo the value back in a header. | Strictly necessary | Session |

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
