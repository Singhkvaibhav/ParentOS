import { useEffect, useState } from 'react';
import { meta } from '../api/endpoints';
import type { MarketplaceConfig } from '../api/types';

// GET /api/v1/meta/config rarely changes and several screens need it (Feed's
// category chips, Sell's category/subcategory/condition pickers, Search) -
// cached at module scope so navigating between them doesn't refetch it
// every time, mirroring what the web frontend's own useMarketplaceConfig
// hook does for the same reason.
let cached: MarketplaceConfig | null = null;
let inFlight: Promise<MarketplaceConfig> | null = null;

function load(): Promise<MarketplaceConfig> {
  if (cached) return Promise.resolve(cached);
  if (!inFlight) inFlight = meta.config().then((c) => { cached = c; return c; });
  return inFlight;
}

export function useMarketplaceConfig() {
  const [config, setConfig] = useState<MarketplaceConfig | null>(cached);
  const [loading, setLoading] = useState(!cached);

  useEffect(() => {
    if (cached) return;
    let live = true;
    load().then((c) => { if (live) setConfig(c); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []);

  return { config, loading };
}
