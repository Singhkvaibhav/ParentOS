-- Migration 020: per-user language preference.
--
-- Verification, password-reset and account-security emails were English
-- only, regardless of which language the person actually reads the site
-- in. The frontend already knows the visitor's language (i18next) at
-- signup time - this column is where that gets remembered so emails sent
-- later (a password reset days after signup) still go out in the right
-- language without the frontend having to resend it.
ALTER TABLE users ADD COLUMN IF NOT EXISTS locale TEXT NOT NULL DEFAULT 'en';
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_locale_check;
ALTER TABLE users ADD CONSTRAINT users_locale_check CHECK (locale IN ('en', 'fi'));
