import { useEffect, useState } from 'react';
import { getBrowserSupabase } from '../../lib/supabase';

/** Where "Make your first video" goes: the maker when signed in, sign up otherwise. */
export default function useStartHref() {
  const [href, setHref] = useState('/sign-up');
  useEffect(() => {
    const supabase = getBrowserSupabase();
    if (!supabase) return undefined;
    let alive = true;
    supabase.auth.getSession().then(({ data }) => {
      if (alive && data?.session) setHref('/app/new');
    }).catch(() => {});
    return () => { alive = false; };
  }, []);
  return href;
}
