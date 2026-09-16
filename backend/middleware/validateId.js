// Validates that route param(s) look like a positive integer database id
// BEFORE a query ever runs. Without this, a non-numeric value (e.g.
// /api/v1/listings/not-a-number) reaches Postgres as a raw type-conversion
// error ("invalid input syntax for type integer"), which the generic error
// handler turns into an unhelpful 500 instead of a clean 400 - the same
// class of bug as the favorites FK-violation fix, but this one is the
// route-param version and affects most id-taking endpoints in the app.
function validateIdParams(...paramNames) {
  return (req, res, next) => {
    for (const name of paramNames) {
      const value = req.params[name];
      if (value !== undefined && !/^\d+$/.test(value)) {
        return res.status(400).json({ error: `Invalid ${name} - must be a positive integer.` });
      }
    }
    next();
  };
}

module.exports = validateIdParams;
