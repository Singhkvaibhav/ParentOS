// Turns the built SPA's index.html into a page with real per-listing
// <title>/description/Open Graph tags, for the crawlers and link-preview
// bots (Googlebot, Slackbot, WhatsApp, iMessage, Twitter/X, Facebook) that
// don't execute JavaScript and would otherwise only ever see the static
// "Uusiksi - ParentOS" shell every page shares. A real browser gets the
// exact same HTML - the SPA's own script tag is untouched, so it boots and
// client-side-renders normally either way. This is not a second app to
// maintain; it's the same shell with a smarter <head>.
const fs = require("fs");
const path = require("path");
const logger = require("../logger");

// The frontend's build output. docker-compose.yml mounts the same
// ./frontend/dist the nginx proxy serves into this container read-only, at
// this path - see the `api` service's volumes there.
const DIST_DIR = process.env.FRONTEND_DIST_DIR || path.resolve(__dirname, "../../frontend/dist");
const INDEX_PATH = path.join(DIST_DIR, "index.html");

// Cached with the file's mtime as the cache key rather than re-reading on
// every request: this route is crawler/share-link traffic, not the app's
// main path, but a listing going viral shouldn't mean stat()-ing disk per
// hit. A stale cache is impossible - any deploy that changes index.html
// changes its mtime, which invalidates this on the very next request.
let cached = null; // { mtimeMs, html }

function readTemplate() {
  const stat = fs.statSync(INDEX_PATH); // throws if the dist build isn't mounted - see notFoundShell's caller
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.html;
  const html = fs.readFileSync(INDEX_PATH, "utf8");
  cached = { mtimeMs: stat.mtimeMs, html };
  return html;
}

// Best-effort: if the frontend build isn't mounted (e.g. a dev backend run
// with no frontend built yet), fall back to a minimal shell rather than
// 500ing - the route still works, just without the SPA taking over after
// load. Logged once per occurrence so a genuinely missing mount in
// production is visible rather than silently degrading.
function readTemplateOrFallback() {
  try {
    return readTemplate();
  } catch (e) {
    logger.warn("seo_template_unavailable", { err: e.message, path: INDEX_PATH });
    return "<!doctype html><html><head></head><body><div id=\"root\"></div></body></html>";
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function escapeAttr(str) {
  return escapeHtml(str);
}

// Truncates on a word boundary so a description never ends mid-word in a
// search result or a chat link preview.
function truncate(str, max) {
  const clean = String(str || "").replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max).replace(/\s+\S*$/, "")}…`;
}

// Builds the full <head> replacement for one page. `image` and `url` must
// already be absolute - social platforms ignore relative og:image/og:url.
function metaTags({ title, description, image, url, type = "website" }) {
  const tags = [
    `<title>${escapeHtml(title)}</title>`,
    `<meta name="description" content="${escapeAttr(description)}" />`,
    `<link rel="canonical" href="${escapeAttr(url)}" />`,
    `<meta property="og:type" content="${type}" />`,
    `<meta property="og:site_name" content="Uusiksi" />`,
    `<meta property="og:title" content="${escapeAttr(title)}" />`,
    `<meta property="og:description" content="${escapeAttr(description)}" />`,
    `<meta property="og:url" content="${escapeAttr(url)}" />`,
    `<meta property="og:image" content="${escapeAttr(image)}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${escapeAttr(title)}" />`,
    `<meta name="twitter:description" content="${escapeAttr(description)}" />`,
    `<meta name="twitter:image" content="${escapeAttr(image)}" />`,
  ];
  return tags.join("\n    ");
}

// index.html ships its own baseline <title>/description/OG/Twitter tags
// (see frontend/index.html) as the fallback for every page that ISN'T a
// listing. Those must be stripped here, not just appended past - most
// crawlers and link-preview bots use the FIRST og:title/og:description tag
// they find, so leaving the generic pair in place would silently win over
// the real per-listing ones this function exists to inject.
function stripBaselineMeta(html) {
  return html
    .replace(/<title>.*?<\/title>\s*/is, "")
    .replace(/<meta\s+name=["']description["'][^>]*>\s*/gi, "")
    .replace(/<meta\s+property=["']og:[^"']*["'][^>]*>\s*/gi, "")
    .replace(/<meta\s+name=["']twitter:[^"']*["'][^>]*>\s*/gi, "")
    .replace(/<!--[\s\S]*?-->\s*/g, "");
}

function renderShell(meta) {
  const html = stripBaselineMeta(readTemplateOrFallback());
  return html.replace("</head>", `${metaTags(meta)}\n  </head>`);
}

module.exports = { renderShell, truncate, INDEX_PATH };
