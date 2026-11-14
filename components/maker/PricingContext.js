import { createContext, useContext, useEffect, useState } from 'react';

import { DEFAULTS } from '../../lib/pricingConstants';
import { getPricing } from '../../lib/story/client';

const PricingContext = createContext(DEFAULTS);

const merge = (server) => ({
  ...DEFAULTS,
  ...server,
  perSecond: { ...DEFAULTS.perSecond, ...(server?.perSecond || {}) },
  included: { ...DEFAULTS.included, ...(server?.included || {}) },
});

/**
 * Loads GET /api/story/pricing once and hands the numbers to every price shown in the maker. The built in
 * numbers only stand in while it loads (or if it fails); a server quote always wins over both.
 */
export function PricingProvider({ children }) {
  const [pricing, setPricing] = useState(DEFAULTS);
  useEffect(() => {
    let alive = true;
    Promise.resolve()
      .then(() => getPricing())
      .then((data) => {
        if (alive && data?.pricing) setPricing(merge(data.pricing));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return <PricingContext.Provider value={pricing}>{children}</PricingContext.Provider>;
}

export const usePricing = () => useContext(PricingContext);
