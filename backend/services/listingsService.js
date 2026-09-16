const { query, hasPostgis } = require("../db");
const { findArea, haversineKm } = require("../areaData");
const { MARKETPLACE, LIMITS, CATEGORY_SET, CONDITION_SET, SUBCATEGORY_SETS } = require("../config");
const { deleteImage } = require("../storage");
const { summarize } = require("./trustService");

// The seller's trust columns come along with the join that was already
// happening for their name - no extra query, and it means a buyer can
// judge a seller from the listing card without opening their profile.
const LISTING_SELECT = `
  SELECT listings.*,
         users.name AS seller_name,
         users.verified AS seller_verified,
         users.rating_sum AS seller_rating_sum,
         users.rating_count AS seller_rating_count,
         users.completed_sales_count AS seller_completed_sales,
         users.created_at AS seller_created_at
  FROM listings
  JOIN users ON users.id = listings.seller_id
`;

const KM_PER_DEGREE_LAT = 111; // approximate, fine at this precision for a bounding-box prefilter

// Vocabularies and limits all come from config.js now - see the note there
// on why these live in one place (a category added here but not in the
// frontend's copy silently creates listings no filter can match).

// Validates the free-form fields shared by create and update. Returns the
// cleaned values rather than mutating, so callers can't accidentally use
// the unvalidated originals.
function validateListingFields({ category, title, priceCents, sizeOrAge, condition, description, subcategory }, { partial = false } = {}) {
  const cleaned = {};

  if (category !== undefined) {
    if (!CATEGORY_SET.has(category)) {
      throw new ListingError(400, `Invalid category - must be one of: ${[...CATEGORY_SET].join(", ")}.`);
    }
    cleaned.category = category;
  }

  // Cleaned but not yet checked against a category here - which category
  // this needs to be valid for depends on whether this is a create (where
  // `category` above is always present) or a partial update that isn't
  // also changing category (where the caller must check it against the
  // listing's existing category instead). See assertValidSubcategory and
  // its call sites in create()/update().
  if (subcategory !== undefined) {
    cleaned.subcategory = subcategory === null || subcategory === "" ? null : String(subcategory).trim();
  }

  if (title !== undefined) {
    const trimmed = String(title).trim();
    if (!trimmed) throw new ListingError(400, "Title is required.", "titleRequired");
    if (trimmed.length > LIMITS.titleLength) throw new ListingError(400, `Title must be ${LIMITS.titleLength} characters or fewer.`, "titleTooLong", { n: LIMITS.titleLength });
    cleaned.title = trimmed;
  }

  if (priceCents !== undefined) {
    const cents = Math.round(Number(priceCents));
    if (!Number.isFinite(cents) || cents <= 0) throw new ListingError(400, "Price must be a positive amount.", "priceMustBePositive");
    if (cents > MARKETPLACE.maxPriceCents) throw new ListingError(400, `Price must be ${MARKETPLACE.maxPriceCents / 100} EUR or less.`, "priceTooHigh", { amount: MARKETPLACE.maxPriceCents / 100 });
    cleaned.priceCents = cents;
  }

  if (condition !== undefined) {
    if (!CONDITION_SET.has(condition)) {
      throw new ListingError(400, `Invalid condition - must be one of: ${[...CONDITION_SET].join(", ")}.`);
    }
    cleaned.condition = condition;
  }

  if (sizeOrAge !== undefined && sizeOrAge !== null) {
    const trimmed = String(sizeOrAge).trim();
    if (trimmed.length > LIMITS.sizeOrAgeLength) throw new ListingError(400, `Size/age must be ${LIMITS.sizeOrAgeLength} characters or fewer.`, "sizeOrAgeTooLong", { n: LIMITS.sizeOrAgeLength });
    cleaned.sizeOrAge = trimmed;
  }

  if (description !== undefined && description !== null) {
    const trimmed = String(description).trim();
    if (trimmed.length > LIMITS.descriptionLength) throw new ListingError(400, `Description must be ${LIMITS.descriptionLength} characters or fewer.`, "descriptionTooLong", { n: LIMITS.descriptionLength });
    cleaned.description = trimmed;
  }

  if (!partial) {
    for (const required of ["category", "title", "priceCents", "condition"]) {
      if (cleaned[required] === undefined) throw new ListingError(400, "Missing required listing fields.", "missingListingFields");
    }
  }

  return cleaned;
}

// Separate from validateListingFields because the category to check
// against isn't always in the same payload - a partial update that only
// touches subcategory has to be checked against the listing's *existing*
// category instead. null/undefined subcategory is always fine (it means
// "not set" or "explicitly cleared").
function assertValidSubcategory(category, subcategory) {
  if (subcategory == null) return;
  const allowed = SUBCATEGORY_SETS[category];
  if (!allowed || !allowed.has(subcategory)) {
    throw new ListingError(
      400,
      `Invalid subcategory for '${category}' - must be one of: ${[...(allowed || [])].join(", ")}.`
    );
  }
}

class ListingError extends Error {
  constructor(status, message, code = null, meta = null) {
    super(message);
    this.status = status;
    this.code = code;
    if (meta) this.meta = meta;
  }
}

// Attaches a compact seller trust summary and strips the raw aggregate
// columns, which are an implementation detail of the join rather than
// something the API should expose.
function withSellerTrust(row) {
  if (!row) return row;
  const {
    seller_rating_sum, seller_rating_count, seller_completed_sales, seller_created_at,
    ...rest
  } = row;

  return {
    ...rest,
    seller_verified: !!row.seller_verified,
    sellerTrust: summarize({
      verified: row.seller_verified,
      created_at: seller_created_at,
      rating_sum: seller_rating_sum,
      rating_count: seller_rating_count,
      completed_sales_count: seller_completed_sales,
    }),
  };
}

function clampPaging(limit, offset) {
  return {
    limit: Math.min(Math.max(Number(limit) || LIMITS.defaultPageSize, 1), LIMITS.maxPageSize),
    offset: Math.max(Number(offset) || 0, 0),
  };
}

// One consistent pagination envelope for every list endpoint. Previously
// the non-distance path returned no `total` at all while the distance path
// did, so a client couldn't reliably tell how many results existed or
// whether to render a "next page" control.
function paginationMeta({ total, limit, offset }) {
  return {
    limit,
    offset,
    total,
    hasMore: offset + limit < total,
  };
}

// Public browse: only shows listings that are actually available right now.
// Postgres has real trig functions (unlike SQLite), but exact distance
// scoring still isn't pushed into SQL here - the bounding box (backed by
// idx_listings_latlng) already does the expensive part of narrowing rows
// before JS ever touches them.
async function list({ category, subcategory, condition, q, lat, lng, maxDistance, limit, offset }) {
  const { limit: lim, offset: off } = clampPaging(limit, offset);

  // moderated_at IS NULL excludes listings a moderator has taken down -
  // they stay in the database (for the audit trail and any linked
  // transactions) but must not appear in browsing.
  let sql = `${LISTING_SELECT} WHERE listings.status = 'active' AND listings.moderated_at IS NULL`;
  const params = [];
  if (category && category !== "all") { params.push(category); sql += ` AND category = $${params.length}`; }
  if (subcategory && subcategory !== "all") { params.push(subcategory); sql += ` AND subcategory = $${params.length}`; }
  if (condition && condition !== "all") { params.push(condition); sql += ` AND condition = $${params.length}`; }

  // (P2 #16) Full-text search against the indexed search_vector column
  // instead of the old `ILIKE '%term%'`, which couldn't use an index and
  // scanned every active listing.
  //
  // Each term gets `:*` appended so it prefix-matches - a search box is
  // typically read as-you-type, and users expect "strol" to find
  // "stroller". Terms are ANDed, so extra words narrow rather than widen
  // the results, which is what people expect from a search box.
  let searchQuery = null;
  let searchParamIndex = null;
  if (q && String(q).trim()) {
    const terms = String(q)
      .trim()
      .split(/\s+/)
      .map((t) => t.replace(/[^\p{L}\p{N}]/gu, "")) // strip tsquery operators; a user typing "&" or "!" means it literally
      .filter(Boolean)
      .map((t) => `${t}:*`);

    if (terms.length > 0) {
      searchQuery = terms.join(" & ");
      params.push(searchQuery);
      // Remember WHICH placeholder holds the query - ts_rank in the ORDER
      // BY needs to reference the same one, and computing that position
      // arithmetically later would silently break the moment another
      // filter (e.g. the bounding box) pushes params in between.
      searchParamIndex = params.length;
      sql += ` AND search_vector @@ to_tsquery('simple', $${searchParamIndex})`;
    }
  }

  const hasLocation = lat && lng;
  const ref = hasLocation ? { lat: Number(lat), lng: Number(lng) } : null;
  const boundedDistance = hasLocation && maxDistance && maxDistance !== "any" ? Number(maxDistance) : null;

  // --- Spatial path (PostGIS available) ---------------------------------
  //
  // Distance filtering, ordering AND pagination all happen in the database
  // via a GiST-indexed ST_DWithin. The fallback below has to pull the
  // whole bounding box into Node to sort it, so it can't paginate in SQL -
  // this path returns exactly the page requested.
  if (hasLocation && hasPostgis()) {
    params.push(ref.lng, ref.lat);
    const pointIndex = params.length; // $n-1 = lng, $n = lat
    const originSql = `ST_SetSRID(ST_MakePoint($${pointIndex - 1}, $${pointIndex}), 4326)::geography`;

    let spatialSql = sql + ` AND listings.geog IS NOT NULL`;
    if (boundedDistance != null) {
      params.push(boundedDistance * 1000); // ST_DWithin on geography works in metres
      spatialSql += ` AND ST_DWithin(listings.geog, ${originSql}, $${params.length})`;
    }

    params.push(lim, off);
    const paged =
      spatialSql.replace(
        "SELECT listings.*,",
        `SELECT COUNT(*) OVER () AS total_count,
                ST_Distance(listings.geog, ${originSql}) / 1000 AS distance_km,
                listings.*,`
      ) +
      ` ORDER BY listings.geog <-> ${originSql} LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const { rows } = await query(paged, params);
    const total = rows.length > 0 ? Number(rows[0].total_count) : 0;
    const listings = rows.map((row) => {
      const distanceKm = row.distance_km == null ? null : Math.round(Number(row.distance_km) * 100) / 100;
      delete row.total_count;
      delete row.distance_km;
      return { ...withSellerTrust(row), distanceKm };
    });
    return { listings, ...paginationMeta({ total, limit: lim, offset: off }) };
  }

  // --- Fallback path (no PostGIS) ---------------------------------------
  if (boundedDistance != null) {
    const deltaLat = boundedDistance / KM_PER_DEGREE_LAT;
    const kmPerDegreeLng = KM_PER_DEGREE_LAT * Math.cos((ref.lat * Math.PI) / 180) || 1;
    const deltaLng = boundedDistance / kmPerDegreeLng;
    params.push(ref.lat - deltaLat, ref.lat + deltaLat, ref.lng - deltaLng, ref.lng + deltaLng);
    const [a, b, c, d] = [params.length - 3, params.length - 2, params.length - 1, params.length];
    sql += ` AND listings.lat BETWEEN $${a} AND $${b} AND listings.lng BETWEEN $${c} AND $${d}`;
  }

  if (!hasLocation) {
    // COUNT(*) OVER () computes the total matching rows in the SAME query
    // as the page itself - a window function evaluated before LIMIT
    // applies. The obvious alternative (a separate SELECT COUNT(*)) means
    // running the filters twice and risks the two queries disagreeing if
    // a listing changes between them.
    params.push(lim, off);
    // When there's a search query, order by relevance (title matches
    // outrank description matches via the setweight in migration 004) and
    // use recency only as a tiebreak. Without a query there's nothing to
    // rank against, so newest-first is the sensible default.
    const orderBy = searchParamIndex
      ? `ORDER BY ts_rank(search_vector, to_tsquery('simple', $${searchParamIndex})) DESC, listings.created_at DESC`
      : "ORDER BY listings.created_at DESC";

    const paged = sql.replace(
      "SELECT listings.*,",
      "SELECT COUNT(*) OVER () AS total_count, listings.*,"
    ) + ` ${orderBy} LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const { rows } = await query(paged, params);
    const total = rows.length > 0 ? Number(rows[0].total_count) : 0;
    const listings = rows.map((row) => {
      // total_count is a per-row artefact of the window function, not part
      // of a listing - strip it before it reaches the API response.
      delete row.total_count;
      return withSellerTrust(row);
    });
    return { listings, ...paginationMeta({ total, limit: lim, offset: off }) };
  }

  const { rows: bounded } = await query(sql, params);
  let withDistance = bounded.map(withSellerTrust).map((r) => ({ ...r, distanceKm: haversineKm(ref, r) }));
  if (boundedDistance != null) {
    withDistance = withDistance.filter((r) => r.distanceKm != null && r.distanceKm <= boundedDistance);
  }
  withDistance.sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));
  const page = withDistance.slice(off, off + lim);
  return { listings: page, ...paginationMeta({ total: withDistance.length, limit: lim, offset: off }) };
}

// (P1 #5) A moderated listing was excluded from browse but still
// retrievable by anyone who had its id - so a link shared before the
// takedown kept working, which defeats the point of removing it.
//
// `viewerId` lets the two legitimate exceptions through: the seller (who
// needs to see why their listing was removed) and a moderator (who needs
// to review it). Everyone else gets the same 404 as a listing that never
// existed - deliberately not a 403, which would confirm it exists.
async function getOne(id, viewerId = null) {
  const { rows } = await query(`${LISTING_SELECT} WHERE listings.id = $1`, [id]);
  const listing = rows[0];
  if (!listing) throw new ListingError(404, "Listing not found.", "listingNotFound");

  if (listing.moderated_at) {
    let allowed = false;
    if (viewerId) {
      if (listing.seller_id === viewerId) allowed = true;
      else {
        const { rows: adminRows } = await query("SELECT is_admin FROM users WHERE id = $1", [viewerId]);
        allowed = !!adminRows[0]?.is_admin;
      }
    }
    if (!allowed) throw new ListingError(404, "Listing not found.", "listingNotFound");
  }

  return withSellerTrust(listing);
}

async function mine(sellerId) {
  const { rows } = await query(`${LISTING_SELECT} WHERE listings.seller_id = $1 ORDER BY listings.created_at DESC`, [sellerId]);
  return rows.map(withSellerTrust);
}

async function create(sellerId, { category, title, priceCents, sizeOrAge, condition, city, area, description, photoUrl, photoThumbUrl, subcategory }) {
  const clean = validateListingFields({ category, title, priceCents, sizeOrAge, condition, description, subcategory });
  assertValidSubcategory(clean.category, clean.subcategory);
  if (!city || !area) throw new ListingError(400, "Missing required listing fields.", "missingListingFields");
  const loc = findArea(city, area);
  if (!loc) throw new ListingError(400, "Unknown city/area combination.");

  const { rows } = await query(
    `INSERT INTO listings (seller_id, category, subcategory, title, price_cents, size_or_age, condition, city, area, pincode, lat, lng, description, photo_url, photo_thumb_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING id`,
    [sellerId, clean.category, clean.subcategory || null, clean.title, clean.priceCents, clean.sizeOrAge || "Not specified", clean.condition, city, loc.area, loc.pincode, loc.lat, loc.lng, clean.description || "No description added.", photoUrl || null, photoThumbUrl || null]
  );
  return getOne(rows[0].id, sellerId);
}

async function requireOwnedListing(id, sellerId) {
  const { rows } = await query("SELECT * FROM listings WHERE id = $1", [id]);
  const listing = rows[0];
  if (!listing) throw new ListingError(404, "Listing not found.", "listingNotFound");
  if (listing.seller_id !== sellerId) throw new ListingError(403, "Not your listing.", "notYourListing");
  return listing;
}

async function update(id, sellerId, { category, title, priceCents, sizeOrAge, condition, city, area, description, photoUrl, photoThumbUrl, subcategory }) {
  const listing = await requireOwnedListing(id, sellerId);
  // Same rules as create, but only for the fields actually being changed -
  // an edit shouldn't be able to sneak in a value create would reject.
  const clean = validateListingFields({ category, title, priceCents, sizeOrAge, condition, description, subcategory }, { partial: true });

  if (clean.subcategory !== undefined) {
    // Checked against the NEW category if this update is also changing
    // it, otherwise against the listing's existing one - validateListingFields
    // can't do this itself since a partial update may not include category
    // at all.
    assertValidSubcategory(clean.category ?? listing.category, clean.subcategory);
  }

  const fields = [];
  const params = [];
  function set(column, value) { params.push(value); fields.push(`${column} = $${params.length}`); }

  if (clean.category !== undefined) set("category", clean.category);
  if (clean.subcategory !== undefined) {
    set("subcategory", clean.subcategory);
  } else if (clean.category !== undefined && listing.subcategory && !SUBCATEGORY_SETS[clean.category]?.has(listing.subcategory)) {
    // Category changed without an explicit new subcategory, and the old
    // one doesn't belong to the new category - clear it rather than
    // letting the DB reject the update outright on the CHECK constraint
    // (migration 021) with an opaque error the seller didn't cause.
    set("subcategory", null);
  }
  if (clean.title !== undefined) set("title", clean.title);
  if (clean.priceCents !== undefined) set("price_cents", clean.priceCents);
  if (clean.sizeOrAge !== undefined) set("size_or_age", clean.sizeOrAge);
  if (clean.condition !== undefined) set("condition", clean.condition);
  if (clean.description !== undefined) set("description", clean.description);
  if (photoUrl !== undefined) set("photo_url", photoUrl);
  if (photoThumbUrl !== undefined) set("photo_thumb_url", photoThumbUrl);

  if (city !== undefined && area !== undefined) {
    const loc = findArea(city, area);
    if (!loc) throw new ListingError(400, "Unknown city/area combination.");
    set("city", city);
    set("area", loc.area);
    set("pincode", loc.pincode);
    set("lat", loc.lat);
    set("lng", loc.lng);
  }

  if (fields.length === 0) throw new ListingError(400, "No fields to update.", "noFieldsToUpdate");

  params.push(listing.id);
  await query(`UPDATE listings SET ${fields.join(", ")} WHERE id = $${params.length}`, params);

  // (P1 #11) If the photo was replaced, the old file is now referenced by
  // nothing - delete it. Only when it actually changed: an update that
  // leaves photoUrl alone (or re-sends the same one) must not delete the
  // image the listing is still using.
  if (photoUrl !== undefined && listing.photo_url && listing.photo_url !== photoUrl) {
    await deleteImage(listing.photo_url);
  }

  return getOne(listing.id, sellerId);
}

// Deleting is blocked if a buyer has already messaged about the item, so
// that buyer's conversation history doesn't get orphaned - mark it sold
// instead in that case. Otherwise a straightforward delete (and clean up
// any favorites pointing at it, which have no standalone value - though
// ON DELETE CASCADE on favorites.listing_id already does this for us now
// that we're on Postgres with real FK enforcement).
async function remove(id, sellerId) {
  const listing = await requireOwnedListing(id, sellerId);

  const { rows } = await query("SELECT COUNT(*) AS n FROM conversations WHERE listing_id = $1", [listing.id]);
  if (Number(rows[0].n) > 0) {
    throw new ListingError(409, "This listing has buyer messages - mark it sold instead of deleting, so buyers keep their conversation history.", "listingHasMessages");
  }

  await query("DELETE FROM listings WHERE id = $1", [listing.id]);

  // (P1 #11) Clean up the stored image too - otherwise every deleted
  // listing leaves its photo behind forever, quietly accumulating storage
  // cost for files nothing references. Deliberately after the delete and
  // best-effort: the listing being gone is what the user asked for, and a
  // failed file cleanup shouldn't turn that into an error.
  if (listing.photo_url) await deleteImage(listing.photo_url);
}

// Valid manual (seller-initiated) status transitions. Automated transitions
// (checkout's atomic active->reserved claim, and the webhook/expiry-sweep's
// reserved->sold / reserved->active) live in transactionsService.js and
// aren't governed by this table - this is specifically what a *seller
// clicking a button* is allowed to do.
const VALID_TRANSITIONS = {
  active: new Set(["reserved", "sold"]),
  reserved: new Set(["active", "sold"]),
  sold: new Set(["active"]), // relist only
};

// The dangerous case this exists to prevent: a buyer starts checkout
// (listing -> 'reserved', a real Stripe PaymentIntent now exists), the
// seller clicks "Relist" or "Mark sold" while that payment is still in
// flight, and either a second buyer can now buy the same item, or the
// original payment later succeeds via webhook against a listing that's
// already been sold to someone else. Blocking any manual transition while
// a 'pending' transaction exists on this listing closes that window
// entirely - the pending transaction has to resolve (paid, cancelled, or
// expired) before a seller can manually touch the listing's status again.
async function assertNoPendingTransaction(listingId) {
  const { rows } = await query("SELECT id FROM transactions WHERE listing_id = $1 AND status = 'pending'", [listingId]);
  if (rows.length > 0) {
    throw new ListingError(409, "This listing has a payment in progress - wait for it to complete or expire before changing its status.", "listingPaymentInProgress");
  }
}

async function setStatus(id, sellerId, targetStatus, { bumpCreatedAt = false } = {}) {
  const listing = await requireOwnedListing(id, sellerId);
  if (!VALID_TRANSITIONS[listing.status]?.has(targetStatus)) {
    throw new ListingError(409, `Can't change a '${listing.status}' listing to '${targetStatus}'.`);
  }
  await assertNoPendingTransaction(id);

  // A seller must not be able to relist their way out of a moderation
  // decision - the takedown lives in a separate column precisely so their
  // own status actions can't clear it.
  if (listing.moderated_at) {
    throw new ListingError(403, "This listing was removed by a moderator and can't be changed.", "listingRemoved");
  }

  // reserved_at must track status exactly (enforced by a CHECK constraint -
  // see migration 002). A seller manually reserving an item sets the
  // timestamp just like checkout does, which also means a manual
  // reservation is subject to the same expiry sweep rather than sitting
  // reserved forever. Any other status clears it.
  const reservedAt = targetStatus === "reserved" ? "now()" : "NULL";
  const createdAt = bumpCreatedAt ? ", created_at = now()" : "";
  await query(
    `UPDATE listings SET status = $1, reserved_at = ${reservedAt}${createdAt} WHERE id = $2`,
    [targetStatus, id]
  );
  return getOne(id, sellerId);
}

const reserve = (id, sellerId) => setStatus(id, sellerId, "reserved");
const markSold = (id, sellerId) => setStatus(id, sellerId, "sold");

// Relisting reactivates the item AND bumps created_at, so it resurfaces at
// the top of the marketplace feed rather than reappearing buried under
// newer listings. Only valid from 'sold' (see VALID_TRANSITIONS) - a
// 'reserved' listing should resolve via the actual payment outcome, not a
// manual relist.
const relist = (id, sellerId) => setStatus(id, sellerId, "active", { bumpCreatedAt: true });

// Lean projection for the sitemap (see seo/routes.js) - just enough to
// build a URL and a <lastmod>, not the full listing (seller trust fields,
// description, etc.) a sitemap has no use for.
async function listActiveForSitemap() {
  const { rows } = await query(
    "SELECT id, created_at FROM listings WHERE status = 'active' AND moderated_at IS NULL ORDER BY created_at DESC"
  );
  return rows;
}

module.exports = { ListingError, list, getOne, mine, create, update, remove, reserve, markSold, relist, listActiveForSitemap };
