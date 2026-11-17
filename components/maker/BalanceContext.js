import { createContext, useContext, useEffect, useState } from 'react';

import { getBilling } from '../../lib/story/client';

// The credits the customer can spend right now, or null while unknown (or while billing v2 is off, when the balance is in the
// old unit and a shortfall against a v2 price would be wrong).
const BalanceContext = createContext(null);

/**
 * Hands `available` credits to every priced button under it (see NeedCredits). `balance` is the status payload's balance, which
 * the maker already polls, so the number stays fresh without another request; billing is read once to know the unit (v2).
 */
export function BalanceProvider({ balance = null, children }) {
  const [v2, setV2] = useState(null);
  const [loaded, setLoaded] = useState(null);
  useEffect(() => {
    let alive = true;
    Promise.resolve()
      .then(() => getBilling())
      .then((b) => {
        if (!alive) return;
        setV2(b?.v2 === true);
        setLoaded(typeof b?.balance?.available === 'number' ? b.balance.available : null);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  const fresh = typeof balance?.available === 'number' ? balance.available : null;
  const available = v2 === true ? (fresh ?? loaded) : null;
  return <BalanceContext.Provider value={available}>{children}</BalanceContext.Provider>;
}

/** Spendable credits, or null when unknown. */
export const useAvailable = () => useContext(BalanceContext);
