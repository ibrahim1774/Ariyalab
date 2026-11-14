import Head from 'next/head';
import { useState } from 'react';
import { useRouter } from 'next/router';

import AuthModal from '../../components/AuthModal';
import { safeReturnTo } from '../../lib/safeReturnTo';

export default function SignInPage() {
  const [open] = useState(true);
  const router = useRouter();
  // After sign-in go back to where the visitor was headed, else the app.
  // Same-origin paths only, so this can never be an open redirect.
  const returnTo = safeReturnTo(router.query.returnTo, '/app');
  return (
    <>
      <Head>
        <title>Sign in — Ariya Lab</title>
      </Head>
      <main style={{ minHeight: '80vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <AuthModal open={open} onClose={() => (window.location.href = '/')} initialMode="signin" redirectTo={returnTo} />
      </main>
    </>
  );
}
