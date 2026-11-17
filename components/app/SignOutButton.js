import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';

import { getBrowserSupabase } from '../../lib/supabase';
import { signOutAndGoHome } from '../../lib/signOut';
import styles from './AppShell.module.css';

/** "Sign out" for the app header. Only shown while someone is signed in. */
export default function SignOutButton() {
  const router = useRouter();
  const [signedIn, setSignedIn] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const supabase = getBrowserSupabase();
    if (!supabase) return undefined;
    supabase.auth.getUser().then(({ data }) => setSignedIn(Boolean(data?.user)));
    const { data: listener } = supabase.auth.onAuthStateChange((_e, session) => {
      setSignedIn(Boolean(session?.user));
    });
    return () => listener?.subscription?.unsubscribe?.();
  }, []);

  if (!signedIn) return null;
  return (
    <button
      type="button"
      className={styles.signOut}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try { await signOutAndGoHome(router); } finally { setBusy(false); }
      }}
    >
      Sign out
    </button>
  );
}
