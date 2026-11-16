import { useEffect, useState } from 'react';

/*
 * The billing v2 offers the server sells right now (GET /api/story/pricing):
 * null while loading (one retry after a failure), else { billingV2, plans,
 * topups, yearlyDiscount }, or { failed: true, retry } when both reads failed:
 * then nothing is sold from this page (never the legacy prices, which may not
 * be what checkout charges) until `retry()` reads them. The old funnel pages (Paywall, TopupRow) switch their
 * buttons and prices to these when billingV2 is true, so the price shown is
 * the price /api/checkout charges.
 */
export default function useV2Offers() {
  const [offers, setOffers] = useState(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    setOffers(null);
    const read = () => fetch('/api/story/pricing').then((r) => (r.ok ? r.json() : Promise.reject(new Error('pricing'))));
    read()
      .catch(() => new Promise((resolve) => { setTimeout(resolve, 1500); }).then(read))
      .then((d) => {
        if (alive) setOffers({ billingV2: d.billingV2 === true, plans: d.plans, topups: d.topups, yearlyDiscount: d.yearlyDiscount || 0 });
      })
      .catch(() => {
        if (alive) setOffers({ failed: true, retry: () => setAttempt((n) => n + 1) });
      });
    return () => {
      alive = false;
    };
  }, [attempt]);
  return offers;
}
