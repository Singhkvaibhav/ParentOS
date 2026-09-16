import { describe, test, expect, vi } from "vitest";
import { translateServerError } from "./errorMessages";

// A stand-in for i18next's t() that just reports what it was called with,
// so assertions can check the translation key/params chosen rather than
// depending on actual locale strings.
function fakeT() {
  return vi.fn((key, params) => (params !== undefined ? `${key}:${JSON.stringify(params)}` : key));
}

describe("translateServerError", () => {
  test("passes through a falsy error unchanged", () => {
    const t = fakeT();
    expect(translateServerError(null, t)).toBe(null);
    expect(translateServerError(undefined, t)).toBe(undefined);
    expect(translateServerError("", t)).toBe("");
    expect(t).not.toHaveBeenCalled();
  });

  test("an Error with a code translates by errors.<code>, ignoring the message", () => {
    const t = fakeT();
    const err = Object.assign(new Error("some English sentence"), { code: "listingGone" });
    const result = translateServerError(err, t);
    expect(t).toHaveBeenCalledWith("errors.listingGone", undefined);
    expect(result).toBe("errors.listingGone");
  });

  test("a coded error's meta rides along as the t() interpolation params", () => {
    const t = fakeT();
    const err = Object.assign(new Error("Title must be 140 characters or fewer."), {
      code: "titleTooLong",
      meta: { n: 140 },
    });
    translateServerError(err, t);
    expect(t).toHaveBeenCalledWith("errors.titleTooLong", { n: 140 });
  });

  test("a bare string with a code-carrying shape has no code path - falls back to STATIC/PATTERNS", () => {
    // Plain strings never have a .code (only Error objects thrown by
    // apiFetch do) - this locks in that a string always takes the
    // fallback path, never crashes trying to read .code off a string.
    const t = fakeT();
    translateServerError("Listing not found.", t);
    expect(t).toHaveBeenCalledWith("errors.listingNotFound");
  });

  test("an uncoded Error falls back to matching its message against STATIC", () => {
    const t = fakeT();
    const err = new Error("You can't buy your own listing.");
    translateServerError(err, t);
    expect(t).toHaveBeenCalledWith("errors.cantBuyOwnListing");
  });

  test("an uncoded message matching a PATTERN extracts the dynamic value", () => {
    const t = fakeT();
    translateServerError("Price must be 100.50 EUR or less.", t);
    expect(t).toHaveBeenCalledWith("errors.priceTooHigh", { amount: "100.50" });
  });

  test("an uncoded, unrecognized message is returned as-is rather than throwing or hiding it", () => {
    const t = fakeT();
    const result = translateServerError("Some brand-new backend message nobody mapped yet.", t);
    expect(result).toBe("Some brand-new backend message nobody mapped yet.");
    expect(t).not.toHaveBeenCalled();
  });

  test("an Error with no code and no message returns the (falsy) message rather than throwing", () => {
    const t = fakeT();
    const err = new Error();
    err.message = "";
    const result = translateServerError(err, t);
    expect(result).toBe("");
    expect(t).not.toHaveBeenCalled();
  });
});
