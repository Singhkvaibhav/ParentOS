const transactionsService = require("../services/transactionsService");
const logger = require("../logger");

const { OrderTransitionError } = require("../services/orderStateMachine");

function handleServiceError(res, e) {
  if (e instanceof transactionsService.TransactionError) return res.status(e.status).json({ error: e.message });
  // An invalid transition is a client mistake (confirming an unpaid order,
  // fulfilling a completed one), not a server fault. Without this it fell
  // through to the global handler and was logged as `unhandled_error` with
  // a stack trace - which in production means error tracking fills with
  // non-errors and real faults get lost in the noise.
  if (e instanceof OrderTransitionError) return res.status(e.status).json({ error: e.message });
  throw e;
}

async function checkout(req, res) {
  try {
    res.status(201).json(await transactionsService.checkout(req.user.id, req.body));
  } catch (e) {
    handleServiceError(res, e);
  }
}

async function webhook(req, res) {
  try {
    await transactionsService.handleWebhook(req.body, req.headers["stripe-signature"]);
    res.json({ received: true });
  } catch (e) {
    if (e.message?.includes("Stripe isn't configured")) return res.status(503).send(e.message);
    logger.error("stripe_webhook_error", { requestId: req.id, err: e });
    res.status(400).send(`Webhook Error: ${e.message}`);
  }
}

async function confirmReceipt(req, res) {
  try {
    const transaction = await transactionsService.confirmReceipt(req.user.id, req.params.id);
    res.json({ transaction });
  } catch (e) {
    handleServiceError(res, e);
  }
}

async function markFulfilled(req, res) {
  try {
    const transaction = await transactionsService.markFulfilled(req.user.id, req.params.id);
    res.json({ transaction });
  } catch (e) {
    handleServiceError(res, e);
  }
}

async function raiseDispute(req, res) {
  try {
    const transaction = await transactionsService.raiseDispute(req.user.id, req.params.id, req.body.reason);
    res.json({ transaction });
  } catch (e) {
    handleServiceError(res, e);
  }
}

async function history(req, res) {
  try {
    res.json({ events: await transactionsService.history(req.user.id, req.params.id) });
  } catch (e) {
    handleServiceError(res, e);
  }
}

async function resolveDispute(req, res) {
  try {
    const transaction = await transactionsService.resolveDispute(req.user.id, req.params.id, req.body);
    res.json({ transaction });
  } catch (e) {
    handleServiceError(res, e);
  }
}

async function mine(req, res) {
  res.json({ transactions: await transactionsService.mine(req.user.id) });
}

module.exports = { checkout, webhook, confirmReceipt, markFulfilled, raiseDispute, resolveDispute, history, mine };
