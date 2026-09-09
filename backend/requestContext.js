const { AsyncLocalStorage } = require("async_hooks");

// Carries the current request's id through everything it triggers, without
// threading a parameter through every function signature.
//
// The request id was already generated and logged on the HTTP line, but
// nothing downstream could see it - so a Stripe failure, an AI timeout and
// the request that caused them appeared in the logs as three unrelated
// events. Correlating them meant guessing from timestamps.
//
// AsyncLocalStorage keeps the value attached across await boundaries, so
// service code doesn't have to know this exists. Deliberately NOT used for
// anything but diagnostics: passing identity or authorization implicitly
// would make it invisible where it most needs to be explicit.
const storage = new AsyncLocalStorage();

function runWithRequestContext(context, fn) {
  return storage.run(context, fn);
}

function currentRequestId() {
  return storage.getStore()?.requestId ?? null;
}

module.exports = { runWithRequestContext, currentRequestId };
