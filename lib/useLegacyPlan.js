import { useEffect, useState } from 'react';

/*
 * One /api/entitlement request shared by everything on the page that needs the first answer (the app shell, the /app home,
 * the credit badge). The promise is kept for a few seconds after it settles and dropped on sign-out, so a new page load
 * (fresh module) or a different person signing in asks again. Failures answer null.
 */
const KEEP_MS = 5000;
let shared = null;

export function sharedEntitlement() {
  if (!shared) {
    const p = (async () => {
      try {
        const r = await fetch('/api/entitlement');
        return r.ok ? await r.json() : null;
      } catch {
        return null;
      }
    })();
    shared = p;
    p.then(() => setTimeout(() => { if (shared === p) shared = null; }, KEEP_MS));
  }
  return shared;
}

export function _resetLegacyPlan() {
  shared = null;
}

/**
 * Returns { loaded, legacyPlan }: legacyPlan is true only when the server says the signed-in customer is on an old plan.
 * Any failure counts as false (nobody is moved or shown a link by mistake).
 */
export default function useLegacyPlan(enabled = true) {
  const [state, setState] = useState({ loaded: false, legacyPlan: false });
  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    sharedEntitlement().then((ent) => {
      if (alive) setState({ loaded: true, legacyPlan: ent?.legacyPlan === true });
    });
    return () => { alive = false; };
  }, [enabled]);
  return state;
}
