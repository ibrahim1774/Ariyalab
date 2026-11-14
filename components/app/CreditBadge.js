import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

import { subscribeEntitlement } from '../../lib/entitlementBus';
import Pill from '../ui/Pill';

/** Credit balance pill for the app shell. Reads /api/entitlement. */
export default function CreditBadge() {
  const [entitlement, setEntitlement] = useState(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/entitlement');
      if (!r.ok) return;
      setEntitlement(await r.json());
    } catch {}
  }, []);

  useEffect(() => {
    load();
    return subscribeEntitlement(load);
  }, [load]);

  if (!entitlement) return null;
  const n = entitlement.creditsRemaining ?? 0;
  const label = entitlement.isAdmin ? 'Unlimited' : `${n} credit${n === 1 ? '' : 's'}`;

  return (
    <Link href="/app/billing" aria-label="Credits remaining, open billing" title="Manage credits" style={{ textDecoration: 'none' }}>
      <Pill tone="accent" dot>{label}</Pill>
    </Link>
  );
}
