/**
 * Waits for a plan lookup (lib/currentPlan.js) for at most `ms`. Resolves { plan } (a plan or null), or { unknown: true }
 * when it fails or is too slow. Never rejects, so a slow or failing Stripe cannot hold a page or a portal click back.
 */
export function planWithin(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ unknown: true }), ms);
    promise.then(
      (plan) => { clearTimeout(timer); resolve({ plan }); },
      () => { clearTimeout(timer); resolve({ unknown: true }); }
    );
  });
}
