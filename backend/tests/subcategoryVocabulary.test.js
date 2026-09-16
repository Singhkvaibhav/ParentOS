require("../tests/setupEnv");

// The subcategory taxonomy (Stage 1 of the category redesign) is
// deliberately duplicated - not looked up from one shared source - in
// four places: the Postgres CHECK constraint (migration 021), the
// backend's own validation list (config.js), the frontend's presentation
// labels (constants.js), and the two locale files' translations. That's
// the same tradeoff already made for categories and conditions, and it's
// fine as long as an id added to one is added to all the others - which
// is exactly what nothing was checking. Without this test, adding a
// subcategory to config.js but forgetting the CHECK constraint means
// listing creation passes JS validation and then fails at INSERT time
// with an opaque Postgres constraint-violation 500; forgetting the
// frontend label just silently falls back to an ugly derived string.
const fs = require("fs");
const path = require("path");
const { SUBCATEGORIES } = require("../config");

const REPO_ROOT = path.join(__dirname, "..", "..");

function sorted(arr) {
  return [...arr].sort();
}

function extractMigrationLists() {
  const sql = fs.readFileSync(
    path.join(__dirname, "..", "database", "migrations", "021_listing_subcategories.sql"),
    "utf8"
  );
  const result = {};
  const re = /\(category = '(\w+)' AND subcategory IN \(([^)]*)\)\)/g;
  let m;
  while ((m = re.exec(sql))) {
    const [, category, list] = m;
    result[category] = list
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.slice(1, -1)); // strip the surrounding single quotes
  }
  return result;
}

function extractConstantsLists() {
  const src = fs.readFileSync(path.join(REPO_ROOT, "frontend", "src", "constants.js"), "utf8");
  const block = src.match(/export const SUBCATEGORY_LABELS = \{([\s\S]*?)\n\};/)[1];
  const result = {};
const categoryRe = /(\w+): {([\s\S]*?)\n\x20\x20},/g;
  let m;
  while ((m = categoryRe.exec(block))) {
    const [, category, body] = m;
    const idRe = /(?:"([\w-]+)"|^\s*(\w+)):/gm;
    const ids = [];
    let idm;
    while ((idm = idRe.exec(body))) ids.push(idm[1] || idm[2]);
    result[category] = ids;
  }
  return result;
}

function extractLocaleLists(lang) {
  const localePath = path.join(REPO_ROOT, "frontend", "src", "i18n", "locales", `${lang}.json`);
  const json = JSON.parse(fs.readFileSync(localePath, "utf8"));
  const subs = json.subcategories || {};
  const result = {};
  for (const category of Object.keys(subs)) result[category] = Object.keys(subs[category]);
  return result;
}

describe("subcategory vocabulary agrees across every place it's duplicated", () => {
  test("config.js, the migration's CHECK constraint, and the frontend's presentation labels list the same categories and ids", () => {
    const fromMigration = extractMigrationLists();
    const fromConstants = extractConstantsLists();

    expect(sorted(Object.keys(fromMigration))).toEqual(sorted(Object.keys(SUBCATEGORIES)));
    expect(sorted(Object.keys(fromConstants))).toEqual(sorted(Object.keys(SUBCATEGORIES)));

    for (const category of Object.keys(SUBCATEGORIES)) {
      expect(sorted(fromMigration[category] || [])).toEqual(sorted(SUBCATEGORIES[category]));
      expect(sorted(fromConstants[category] || [])).toEqual(sorted(SUBCATEGORIES[category]));
    }
  });

  test.each(["en", "fi"])("the %s locale file translates every subcategory id config.js defines", (lang) => {
    const fromLocale = extractLocaleLists(lang);
    for (const category of Object.keys(SUBCATEGORIES)) {
      expect(sorted(fromLocale[category] || [])).toEqual(sorted(SUBCATEGORIES[category]));
    }
  });
});
