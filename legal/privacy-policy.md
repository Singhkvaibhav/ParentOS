# Privacy Policy — DRAFT

**[REVIEW] Not legal advice. Have a Finnish lawyer review before publishing.**

Controller: **[FILL IN: legal entity name, business ID, address]**
Contact: **[FILL IN]**
Last updated: [FILL IN]

## What this covers

This describes what the service actually stores, taken from the database
schema rather than from a template. If the schema changes, this must change
with it — a privacy policy that misdescribes processing is worse than none.

## Data we hold

**Account** — name, email address, password (stored only as a bcrypt hash,
never in readable form), whether your email is verified, account creation
date, notification preferences.

**Listings** — title, description, category, condition, price, photographs,
and the city/neighbourhood you select. See "Location and photographs" below.

**Messages** — the content of messages you send to other users.

**Transactions** — what was bought and sold, amounts, our commission,
delivery method, and the status timeline. Payment card details are handled
by Stripe and **never reach our servers**.

**Reviews** — ratings and comments you write, and those written about you.

**Security** — sign-in attempts (time, IP address, browser user-agent,
success or failure) and active sessions. Used to detect account takeover
and to show you where your account has been used.

**Reports** — content you report, and reports made about you.

## Location and photographs — please read

Two things deserve specific attention because this is a marketplace for
children's items, and listings are usually photographed at home.

**Location is deliberately approximate.** You select a city and
neighbourhood, not an address. Distances shown to buyers are computed from
the neighbourhood, not from your home.

**Photograph metadata is removed.** Phone photographs commonly embed the
GPS coordinates where they were taken — which, for a photo of a cot in a
living room, is a home address. Every uploaded image is re-encoded before
it is published, which strips this metadata. Images uploaded directly are
held in a non-public area until that processing completes.

## Analytics and session recordings

We use PostHog to understand how the site is used — which pages are
visited, which features get used, and where people run into trouble.
**This is off by default.** Nothing is sent to PostHog until you accept
the cookie banner shown on your first visit, and you can decline it —
the site works identically either way, this is genuinely optional.

If you accept, this can include a recording of your session (mouse
movement, clicks, page navigation) so we can see how the interface
actually behaves for a real visitor, not just what we intended it to do.
Two things are deliberately excluded from that recording regardless of
whether you accept: every form field on the site (the sell form, your
profile, the message box) has its typed content masked before it ever
reaches PostHog, and the Messages inbox pauses recording entirely for as
long as it's open, because the content of a private conversation between
two users is not ours to send to a third party for this purpose.

We identify you to PostHog by your internal account number only — never
your name or email address.

**[REVIEW: confirm the legal basis - this is most likely consent (Art.
6(1)(a)) given the opt-in design above, but confirm rather than assume,
and confirm whether Finnish ePrivacy rules require anything further for
the session-recording cookie specifically.]**

## Why we process it, and on what basis

**[REVIEW: confirm each legal basis.]**

| Purpose | Basis |
|---|---|
| Running your account, listings, messages, purchases | Performance of a contract (Art. 6(1)(b)) |
| Fraud prevention, moderation, platform safety | Legitimate interests (Art. 6(1)(f)) |
| Keeping transaction records | Legal obligation (Art. 6(1)(c)) — Finnish accounting law |
| Notification emails about your activity | Performance of a contract; you can turn email off |
| Marketing email | Consent (Art. 6(1)(a)) — **[FILL IN if you send any]** |

## Who we share it with

- **Stripe** — payments and seller payouts. Stripe is a controller in its
  own right for payment data.
- **Other users** — your display name, listings, reviews, approximate
  location, and trust signals are visible to other users. Your email
  address is not.
- **PostHog** — product analytics and, if you accept the cookie banner,
  session recordings of how you use the site. See "Analytics and session
  recordings" below. **[REVIEW: confirm PostHog's hosting region (EU or
  US) and whether an SCC/data processing agreement is in place if outside
  the EEA.]**
- **[FILL IN]** — email delivery provider.
- **[FILL IN]** — hosting and object storage, and their locations.

**[REVIEW: list every processor, and confirm transfer mechanisms for any
processor outside the EEA.]**

## How long we keep it

| Data | Retention |
|---|---|
| Account and listings | While your account is open |
| Messages | **[FILL IN]** |
| Transaction records | **[REVIEW: commonly six years under Kirjanpitolaki]**, retained in anonymized form after account deletion |
| Sign-in history | **[FILL IN]** |
| Reports and moderation records | **[FILL IN]** |

## Your rights

You can exercise these yourself, without contacting us:

- **Access and portability (Art. 15, 20)** — download everything we hold
  about you as a JSON file from your profile.
- **Erasure (Art. 17)** — delete your account from your profile.

Also available on request at **[FILL IN]**: rectification, restriction,
objection, and withdrawing consent.

### What deletion actually does

We do not simply delete your row, and you should know why.

Your name, email, password, messages, sign-in history, saved items and
notifications are erased or anonymized. Your listings are removed.

**Transaction records are kept**, because accounting law requires it. They
are stripped of your personal data first — what remains is that a sale of a
certain value happened on a certain date, no longer connected to you.

**Reviews you wrote about others are kept**, without your name attached.
They are other users' information about *them*, and allowing anyone to
erase unfavourable reviews by deleting their account would make the review
system worthless.

Deletion is refused while you have an order in progress, because
disappearing mid-transaction would leave the other party with no
counterparty and no recourse. Complete or resolve open orders first.

## Complaints

You may lodge a complaint with the Finnish Data Protection Ombudsman
(Tietosuojavaltuutetun toimisto), tietosuoja.fi.

## Children

This service is for adults buying and selling children's items. It is not
intended for use by children, and accounts may not be created by anyone
under **[FILL IN: 18? 16? confirm — Finland's GDPR digital-consent age is
13, but your terms may set a higher contractual age]**.
