require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });

process.env.TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  "postgres://postgres:postgres@localhost:5432/parentos_test";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-for-jest-do-not-use-in-production";
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.ANTHROPIC_API_KEY = "sk-test-placeholder";
process.env.CORS_ORIGINS = "http://localhost:5173";
// The `stripe` package is mocked in tests that need it (see
// transactions.test.js), so these values are never used for a real network
// call - they only need to be present so getStripe() doesn't refuse to run.
process.env.STRIPE_SECRET_KEY = "sk_test_fake_for_tests";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_fake_for_tests";
process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_fake_for_tests";
