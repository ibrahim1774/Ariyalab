import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

import { getBrowserSupabase } from '../../lib/supabase';
import { subscribeEntitlement } from '../../lib/entitlementBus';
import Pill from '../ui/Pill';
import { sharedEntitlement } from '../../lib/useLegacyPlan';

/** Credit balance pill for the app shell. Reads /api/entitlement. */
export default function CreditBadge() {
  const [entitlement, setEntitlement] = useState(null);
  const [signedIn, setSignedIn] = useState(false);

  // The first read shares the page's single /api/entitlement request; later refreshes (credits changed) ask again.
  const load = useCallback(async (first = false) => {
    try {
      if (first === true) {
        const ent = await sharedEntitlement();
        if (ent) setEntitlement(ent);
        return;
      }
      const r = await fetch('/api/entitlement');
      if (!r.ok) return;
      setEntitlement(await r.json());
    } catch {}
  }, []);

  useEffect(() => {
    const supabase = getBrowserSupabase();
    if (!supabase) return undefined;
    supabase.auth.getUser().then(({ data }) => setSignedIn(Boolean(data?.user)));
    const { data: listener } = supabase.auth.onAuthStateChange((_e, session) => {
      setSignedIn(Boolean(session?.user));
    });
    return () => listener?.subscription?.unsubscribe?.();
  }, []);

  useEffect(() => {
    if (!signedIn) {
      setEntitlement(null);
      return undefined;
    }
    load(true);
    return subscribeEntitlement(() => load());
  }, [signedIn, load]);

  if (!signedIn || !entitlement) return null;
  const n = entitlement.creditsRemaining ?? 0;
  const label = entitlement.isAdmin ? 'Unlimited' : `${n} credit${n === 1 ? '' : 's'}`;

  return (
    <Link href="/app/billing" aria-label="Credits remaining, open billing" title="Manage credits" style={{ textDecoration: 'none' }}>
      <Pill tone="accent" dot>{label}</Pill>
    </Link>
  );
}
