import { useState, useEffect } from "react";
import { metaService } from "../../../services/meta";
import { categoryMeta, CATEGORY_METADATA } from "../../../constants";

// Marketplace rules come from the backend (GET /api/meta/config), which is
// the only place that decides what a valid category, condition, price or
// limit is - because it's the only place that enforces them.
//
// The frontend contributes presentation only: an id from the API is
// decorated with a label and icon from CATEGORY_METADATA.
//
// Degraded mode is deliberately asymmetric, because the two uses carry
// different risk:
//   - READ paths (browsing, filtering) fall back to the ids we happen to
//     have presentation for. A stale filter value just returns nothing
//     useful; the app stays usable.
//   - WRITE paths (the sell form) must NOT fall back. Offering a category
//     the server may reject produces a confusing failure at submit time,
//     so `loaded`/`failed` let those surfaces wait or disable instead.
const PRESENTATION_ONLY_FALLBACK = Object.keys(CATEGORY_METADATA);

export function useMarketplaceConfig() {
  const [raw, setRaw] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    metaService
      .config()
      .then((c) => { if (!cancelled) setRaw(c); })
      .catch(() => { if (!cancelled) setFailed(true); })
      .finally(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, []);

  const categoryIds = raw?.categories ?? PRESENTATION_ONLY_FALLBACK;

  return {
    // Decorated for rendering: { id, label, icon } per category.
    categories: categoryIds.map((id) => ({ id, ...categoryMeta(id) })),
    // No frontend fallback: conditions are exact strings the backend
    // validates, so guessing them would only produce rejections.
    conditions: raw?.conditions ?? [],
    deliveryFeeCents: raw?.deliveryFeeCents ?? null,
    maxPriceCents: raw?.maxPriceCents ?? null,
    limits: raw?.limits ?? null,
    // `loaded` = the request settled; `failed` distinguishes "the server
    // told us" from "we're guessing".
    loaded,
    failed,
  };
}
