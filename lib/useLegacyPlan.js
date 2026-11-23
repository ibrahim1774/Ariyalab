import { useEffect, useState } from 'react';

/**
 * Reads /api/entitlement once and returns { loaded, legacyPlan }: legacyPlan is true only when the server says the
 * signed-in customer is on an old plan. Any failure counts as false (nobody is moved or shown a link by mistake).
 */
export default function useLegacyPlan(enabled = true) {
  const [state, setState] = useState({ loaded: false, legacyPlan: false });
  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    (async () => {
      let legacyPlan = false;
      try {
        const r = await fetch('/api/entitlement');
        if (r.ok) legacyPlan = (await r.json())?.legacyPlan === true;
      } catch {}
      if (alive) setState({ loaded: true, legacyPlan });
    })();
    return () => { alive = false; };
  }, [enabled]);
  return state;
}
