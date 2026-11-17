import { useCallback, useEffect, useRef, useState } from 'react';

import { getQuote } from '../../lib/story/client';

/**
 * The server's quote for starting these shots, read as soon as the ids are known, so the button already carries the price
 * (the same number /generate checks confirmTotal against). `ids` empty: no quote, nothing to press.
 * -> { quote, error, loading, reload }. A 409 needs_rebuild comes back as error.code 'needs_rebuild' (not as a failure to show).
 */
export default function useStartQuote(projectId, ids, { enabled = true, key = '' } = {}) {
  const [quote, setQuote] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const run = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  const sig = ids.join(',');

  const reload = useCallback(async () => {
    if (!projectId || !sig || !enabled) {
      setQuote(null);
      setError(null);
      return null;
    }
    const mine = ++run.current;
    setLoading(true);
    try {
      const next = await getQuote(projectId, sig.split(','));
      if (alive.current && mine === run.current) {
        setQuote(next);
        setError(null);
      }
      return next;
    } catch (err) {
      if (alive.current && mine === run.current) {
        setQuote(null);
        setError(err);
      }
      return null;
    } finally {
      if (alive.current && mine === run.current) setLoading(false);
    }
  }, [projectId, sig, enabled]);

  useEffect(() => { reload(); }, [reload, key]);
  return { quote, error, loading, reload };
}
