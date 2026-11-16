import { useEffect, useState } from 'react';

/*
 * The billing v2 offers the server sells right now (GET /api/story/pricing):
 * null while loading (one retry after a failure), else { billingV2, plans,
 * topups, yearlyDiscount }, or { billingV2: false, failed: true } when both
 * reads failed. The old funnel pages (Paywall, TopupRow) switch their
 * buttons and prices to these when billingV2 is true, so the price shown is
 * the price /api/checkout charges.
 */
export default function useV2Offers() {
  const [offers, setOffers] = useState(null);
  useEffect(() => {
    let alive = true;
    const read = () => fetch('/api/story/pricing').then((r) => (r.ok ? r.json() : Promise.reject(new Error('pricing'))));
    read()
      .catch(() => new Promise((resolve) => { setTimeout(resolve, 1500); }).then(read))
      .then((d) => {
        if (alive) setOffers({ billingV2: d.billingV2 === true, plans: d.plans, topups: d.topups, yearlyDiscount: d.yearlyDiscount || 0 });
      })
      .catch(() => {
        if (alive) setOffers({ billingV2: false, failed: true });
      });
    return () => {
      alive = false;
    };
  }, []);
  return offers;
}
