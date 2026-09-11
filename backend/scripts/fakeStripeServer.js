const { createFakeStripe } = require("../tests/fakeStripe");

const fakeStripe = createFakeStripe();

fakeStripe
  .listen()
  .then((port) => {
    console.log(
      `Fake Stripe API on ${
        process.env.FAKE_STRIPE_HOST || "127.0.0.1"
      }:${port}`
    );
  })
  .catch((err) => {
    console.error("Failed to start fake Stripe:", err);
    process.exit(1);
  });

const shutdown = async () => {
  try {
    await fakeStripe.close();
  } finally {
    process.exit(0);
  }
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
