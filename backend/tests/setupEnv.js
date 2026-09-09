// Runs before any test file is loaded (see package.json's jest.setupFiles),
// so required env vars are in place before server.js/db.js are required by
// a test - including the boot-time JWT_SECRET check, which would otherwise
// exit the process before a single test runs.
//
// Tests run against a real, separate Postgres database (parentos_test),
// not the dev one - see tests/dbReset.js for how each test file gets a
// clean slate.
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-for-jest-do-not-use-in-production";
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || "postgres://postgres:postgres@localhost:5432/parentos_test";
process.env.ANTHROPIC_API_KEY = "sk-test-placeholder";
process.env.CORS_ORIGINS = "http://localhost:5173";
// The `stripe` package is mocked in tests that need it (see
// transactions.test.js), so these values are never used for a real network
// call - they only need to be present so getStripe() doesn't refuse to run.
process.env.STRIPE_SECRET_KEY = "sk_test_fake_for_tests";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_fake_for_tests";
process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_fake_for_tests";
