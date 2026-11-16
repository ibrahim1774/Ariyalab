import { useEffect, useState } from 'react';

/*
 * The billing v2 offers the server sells right now (GET /api/story/pricing):
 * null while loading or when the read fails, else { billingV2, plans, topups,
 * yearlyDiscount }. The old funnel pages (Paywall, TopupRow) switch their
 * buttons and prices to these when billingV2 is true, so the price shown is
 * the price /api/checkout charges.
 */
export default function useV2Offers() {
  const [offers, setOffers] = useState(null);
  useEffect(() => {
    let alive = true;
    fetch('/api/story/pricing')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (alive && d) setOffers({ billingV2: d.billingV2 === true, plans: d.plans, topups: d.topups, yearlyDiscount: d.yearlyDiscount || 0 });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return offers;
}
