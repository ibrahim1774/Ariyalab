import Head from 'next/head';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';

import styles from '../components/AuthModal.module.css';
import { getBrowserSupabase } from '../lib/supabase';

// Where the "Forgot password?" email lands. The Supabase browser client turns the link's code into a
// recovery session by itself; once there is one, the visitor sets a new password. Public route (not in
// the middleware matcher). Without a session after a short wait, the link is spent or expired.
const WAIT_MS = 2500;

export default function ResetPasswordPage() {
  const router = useRouter();
  const [state, setState] = useState('checking'); // checking | ready | expired | done
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const supabase = getBrowserSupabase();
    if (!supabase) {
      setState('expired');
      return undefined;
    }
    let alive = true;
    const ready = () => alive && setState((s) => (s === 'done' ? s : 'ready'));
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY' || (session && event === 'SIGNED_IN')) ready();
    });
    supabase.auth.getSession().then(({ data: d }) => {
      if (d?.session) ready();
    }).catch(() => {});
    const timer = setTimeout(() => alive && setState((s) => (s === 'checking' ? 'expired' : s)), WAIT_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
      data?.subscription?.unsubscribe?.();
    };
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setError('');
    if (password.length < 8) {
      setError('Use at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      const supabase = getBrowserSupabase();
      if (!supabase) throw new Error('Auth not configured. Contact support.');
      const { error: err } = await supabase.auth.updateUser({ password });
      if (err) throw err;
      setState('done');
      setTimeout(() => router.push('/app'), 1500);
    } catch (err) {
      setError(err.message || 'We could not change your password. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Head>
        <title>Reset password — Sonallo</title>
        <meta name="robots" content="noindex" />
      </Head>
      <main style={{ minHeight: '80vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
        <div className={styles.card} style={{ position: 'relative' }}>
          <header className={styles.header}>
            <span className={styles.kicker}>◆ Reset password</span>
            <h1 className={styles.title}>Choose a new password</h1>
          </header>

          {state === 'checking' && <p className={styles.subtitle} role="status">Checking your reset link…</p>}

          {state === 'expired' && (
            <>
              <div className={styles.error} role="alert">
                This reset link didn&apos;t work. Links only work once, for one hour, and in the same browser where you
                asked for them. Request a new one from the sign-in page and open the email on the same device.
              </div>
              <footer className={styles.footer}>
                <Link href="/sign-in" className={styles.link}>Back to sign in</Link>
              </footer>
            </>
          )}

          {state === 'ready' && (
            <form className={styles.form} onSubmit={submit}>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>New password</span>
                <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} className={styles.input} />
              </label>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Confirm new password</span>
                <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required minLength={8} className={styles.input} />
              </label>
              {error && <div className={styles.error} role="alert">{error}</div>}
              <button type="submit" className={styles.submitBtn} disabled={busy}>
                {busy ? 'Saving…' : 'Save new password'}
              </button>
            </form>
          )}

          {state === 'done' && (
            <div className={styles.notice} role="status">Your password is changed. Taking you to Sonallo…</div>
          )}
        </div>
      </main>
    </>
  );
}
