# Legal documents

## Read this first

**These are drafts, not legal advice, and must be reviewed by a Finnish
lawyer before launch.** I am not a lawyer and cannot give legal advice.

They exist because a European consumer marketplace handling payments and
children's products has genuine legal obligations, and it's better to start
from a structured draft that names the real questions than from nothing.
Every place where a decision needs a lawyer, a factual answer about your
business, or a company detail is marked `[REVIEW]` or `[FILL IN]` rather
than being invented.

What makes this project specifically legally sensitive:

- **GDPR** — you process personal data of EU residents, including location
  and photographs taken inside people's homes.
- **Consumer protection** — Finnish and EU consumer law treats a
  professional seller very differently from a private individual selling a
  used pushchair. Which of your sellers are "traders" is a question with
  real consequences and a real answer, and it isn't one I can decide.
- **Payment services** — you take money and pay it on to sellers. Stripe
  Connect is structured to keep you out of licensed payment-institution
  territory, but whether that holds for your exact flow is a question for
  a lawyer.
- **Product safety** — a marketplace for used children's equipment will at
  some point host a recalled car seat or a cot that fails current
  standards. The EU General Product Safety Regulation (GPSR) places
  obligations on online marketplaces.
- **Accounting retention** — Finnish Kirjanpitolaki requires transaction
  records be retained (commonly six years), which is why account deletion
  anonymizes rather than deletes. See `backend/services/privacyService.js`.

## Files

| File | Covers |
|---|---|
| `privacy-policy.md` | What data is collected, why, retention, user rights |
| `terms-of-service.md` | The contract between you and users |
| `marketplace-rules.md` | What may be listed, prohibited items, safety |
| `community-guidelines.md` | Conduct, moderation, enforcement |
| `refund-policy.md` | Refunds, disputes, the withdrawal-right question |
| `cookie-policy.md` | Cookies actually set by this application |

## What is accurate

The technical descriptions are drawn from the code, not assumed. The cookie
policy lists the cookies this application genuinely sets. The data
categories in the privacy policy match what the schema actually stores and
what `/api/privacy/export` returns. If you change the code, these need
updating too — a privacy policy that misdescribes your processing is worse
than none.
