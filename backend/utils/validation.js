// Companion to middleware/validateId.js, for ids supplied in a JSON request
// body (checkout's listingId, a review's revieweeId, etc.) rather than a
// URL route param - same underlying problem (an untrusted value reaching
// Postgres as a raw type-conversion error instead of a clean validation
// error), different place the value comes from.
//
// Takes the caller's own typed Error class so the thrown error still gets
// handled the normal way by that module's controller.
function parseId(value, fieldName, ErrorClass) {
  if (value === undefined || value === null || !/^\d+$/.test(String(value))) {
    throw new ErrorClass(400, `Invalid ${fieldName} - must be a positive integer.`);
  }
  return Number(value);
}

module.exports = { parseId };
