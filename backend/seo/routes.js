// Public, unauthenticated, GET-only routes that exist purely for machines
// that read HTML without running its JavaScript: search crawlers and the
// link-preview bots behind chat apps and social platforms. A real visitor
// hits these same URLs through the SPA and never notices - see render.js
// for why the response they get is the same shell either way.
//
// Mounted at the site root (not under /api) because that's where a crawler
// and the Sitemap: line in robots.txt are required to find them - nginx
// (deploy/nginx/parentos.conf) routes exactly these three paths here and
// leaves every other non-API path to the static SPA build, as before.
const express = require("express");
const listingsService = require("../services/listingsService");
const { renderShell, truncate } = require("./render");

const router = express.Router();

// No trailing slash, and no query string - a sitemap/robots.txt reference
// must be a stable absolute URL, built from FRONTEND_URL rather than
// trusting the request's own Host header (which a crawler has no reason to
// send correctly and a spoofed Host would corrupt every canonical URL on
// the page). Read once at startup like every other FRONTEND_URL use in
// this codebase (see connectService, accountSecurityService) - it doesn't
// change at runtime.
const SITE_URL = (process.env.FRONTEND_URL || "http://localhost:5173").replace(/\/$/, "");
const DEFAULT_OG_IMAGE = `${SITE_URL}/images/hero-nursery.jpg`;

router.get("/listing/:id", async (req, res) => {
  const url = `${SITE_URL}/listing/${req.params.id}`;

  if (!/^\d+$/.test(req.params.id)) {
    return res.status(404).type("html").send(renderShell({
      title: "Listing not found · Uusiksi",
      description: "This listing doesn't exist or is no longer available.",
      image: DEFAULT_OG_IMAGE,
      url,
    }));
  }

  let listing;
  try {
    listing = await listingsService.getOne(req.params.id, null);
  } catch {
    // Same shell either way (moderated, sold-and-removed, or never
    // existed) - a crawler gets a real 404 status, a share link opens the
    // SPA's own "not found" UI instead of a raw error page.
    return res.status(404).type("html").send(renderShell({
      title: "Listing not found · Uusiksi",
      description: "This listing doesn't exist or is no longer available.",
      image: DEFAULT_OG_IMAGE,
      url,
    }));
  }

  const price = `€${(listing.price_cents / 100).toFixed(0)}`;
  res.type("html").send(renderShell({
    title: `${listing.title} · ${price} · Uusiksi`,
    description: truncate(listing.description, 200) || `${listing.title} - ${price} in ${listing.area}, ${listing.city}. Buy and sell second-hand kids gear on Uusiksi.`,
    image: listing.photo_url || DEFAULT_OG_IMAGE,
    url,
    type: "product",
  }));
});

// Regenerated per-request from whatever is currently active rather than
// written to disk at build/deploy time - a listing that sells or gets
// taken down should stop being offered to crawlers on the very next
// fetch, not linger until a rebuild.
router.get("/sitemap.xml", async (req, res) => {
  const staticUrls = [
    { loc: `${SITE_URL}/`, changefreq: "daily", priority: "1.0" },
    { loc: `${SITE_URL}/marketplace`, changefreq: "hourly", priority: "0.9" },
  ];
  const listings = await listingsService.listActiveForSitemap();
  const listingUrls = listings.map((l) => ({
    loc: `${SITE_URL}/listing/${l.id}`,
    lastmod: new Date(l.created_at).toISOString(),
    changefreq: "weekly",
    priority: "0.7",
  }));

  const urlXml = (u) =>
    `  <url>\n    <loc>${u.loc}</loc>\n` +
    (u.lastmod ? `    <lastmod>${u.lastmod}</lastmod>\n` : "") +
    `    <changefreq>${u.changefreq}</changefreq>\n    <priority>${u.priority}</priority>\n  </url>`;

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    [...staticUrls, ...listingUrls].map(urlXml).join("\n") +
    `\n</urlset>\n`;

  res.type("application/xml").send(xml);
});

router.get("/robots.txt", (req, res) => {
  res.type("text/plain").send(
    [
      "User-agent: *",
      "Allow: /",
      // Signed-in-only pages: nothing to index, and a crawler that logs in
      // as nobody just gets bounced to the login state anyway.
      "Disallow: /profile",
      "Disallow: /messages",
      "Disallow: /moderation",
      "",
      `Sitemap: ${SITE_URL}/sitemap.xml`,
      "",
    ].join("\n")
  );
});

module.exports = router;
