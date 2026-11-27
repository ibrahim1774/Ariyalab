import { useEffect, useState } from 'react';
import Head from 'next/head';

import Button from '../../components/ui/Button';
import Card from '../../components/ui/Card';
import {
  OAuthError,
  consentDetails,
  consentPath,
  createConsentRequest,
  validateAuthorizeRequest,
} from '../../lib/mcp/oauth.js';
import { getUserFromRequest } from '../../lib/supabaseServer.js';
import styles from '../../styles/OAuthConsent.module.css';

/*
 * OAuth consent page for the MCP connector. GET /api/oauth/authorize
 * forwards here with the authorization request in the query.
 *
 * Order: read the Supabase session; validate the request (a metadata
 * document client never seen before is fetched only for a signed-in
 * visitor); on any error show an error card, with a "Return to <host>"
 * link when the redirect URI is valid (never an automatic redirect before
 * the user has chosen); signed out -> /sign-in with a returnTo back to
 * this request; then store a consent request bound to the user and render
 * Allow / Deny. The form posts to /api/oauth/authorize with the single-use
 * request token. Framing is forbidden (headers here and in next.config.js,
 * and the form is not rendered inside a frame).
 *
 * Identity: only VERIFIED_CLIENTS get a name in the headline; any other
 * app is headlined by its redirect host and labelled "Unverified app".
 * Client-supplied values render as plain text.
 */
export default function OAuthConsentPage({ error = null, details = null, email = '', requestToken = '' }) {
  // Headers forbid framing on a full load; this also covers arriving here by
  // client-side navigation (sign-in uses router.push).
  const [framed, setFramed] = useState(() => typeof window !== 'undefined' && window.top !== window.self);
  useEffect(() => {
    if (window.top !== window.self) setFramed(true);
  }, []);
  return (
    <>
      <Head>
        <title>{`${error ? 'Connection error' : 'Allow access'} · Sonallo`}</title>
        <meta name="robots" content="noindex" />
        <meta name="referrer" content="same-origin" />
      </Head>
      <main className={styles.page}>
        <Card className={styles.card}>
          <p className={styles.brand}>Sonallo</p>
          {error ? (
            <>
              <h1 className={styles.title}>{error.title}</h1>
              <p className={styles.text}>{error.message}</p>
              {error.returnUrl && (
                <p className={styles.actions}>
                  <a className={styles.returnLink} href={error.returnUrl} rel="noreferrer">
                    Return to {error.returnHost}
                  </a>
                </p>
              )}
            </>
          ) : (
            <>
              {details.verified ? (
                <h1 className={styles.title}>
                  Allow <span className={styles.client}>{details.headline}</span> to use your Sonallo account?
                </h1>
              ) : (
                <>
                  <p className={styles.unverified}>Unverified app</p>
                  <h1 className={styles.title}>
                    Allow an app at <span className={styles.client}>{details.headline}</span> to use your Sonallo account?
                  </h1>
                  {details.clientName && <p className={styles.meta}>It calls itself {details.clientName}.</p>}
                  {details.clientIdHost && <p className={styles.meta}>Its details come from {details.clientIdHost}.</p>}
                  <p className={styles.meta}>We could not confirm who made it. Only allow it if you trust it.</p>
                </>
              )}
              {details.clientUri && <p className={styles.meta}>App website: {details.clientUri}</p>}
              <div className={styles.access}>
                <p className={styles.label}>It will be able to</p>
                <p className={styles.text}>{details.access}.</p>
              </div>
              <p className={styles.meta}>Signed in as {email}</p>
              <p className={styles.meta}>After you choose, you go back to {details.redirectHost}.</p>
              {details.loopbackOnly && (
                <p className={styles.warning} role="note">
                  This app runs on a computer, not a website. Only allow it if you started this connection yourself.
                </p>
              )}
              {framed ? (
                <p className={styles.warning} role="alert">
                  Open this page in its own window to continue.
                </p>
              ) : (
                <form method="post" action="/api/oauth/authorize" className={styles.actions}>
                  <input type="hidden" name="request_token" value={requestToken} />
                  <Button type="submit" name="decision" value="deny" variant="ghost" arrow={false}>
                    Deny
                  </Button>
                  <Button type="submit" name="decision" value="allow">
                    Allow
                  </Button>
                </form>
              )}
            </>
          )}
        </Card>
      </main>
    </>
  );
}

/** Anti-framing and no caching (the page carries a single-use token). */
function setConsentHeaders(res) {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  res.setHeader('Cache-Control', 'no-store');
  // same-origin, not no-referrer: under no-referrer a same-origin form POST is
  // sent with `Origin: null`, which the approval endpoint rejects.
  res.setHeader('Referrer-Policy', 'same-origin');
}

function signInRedirect(query) {
  return { redirect: { destination: `/sign-in?returnTo=${encodeURIComponent(consentPath(query))}`, permanent: false } };
}

export async function getServerSideProps({ req, res, query }) {
  setConsentHeaders(res);
  const auth = await getUserFromRequest(req, res);
  let validated;
  try {
    validated = await validateAuthorizeRequest(query, req, { allowFetch: Boolean(auth?.user) });
  } catch (err) {
    if (!(err instanceof OAuthError)) throw err;
    if (err.error === 'client_not_cached') return signInRedirect(query);
    res.statusCode = 400;
    const error = { title: 'This connection cannot continue', message: err.message };
    if (err.redirect) {
      error.returnUrl = err.redirect;
      error.returnHost = new URL(err.redirect).host;
    }
    return { props: { error } };
  }

  if (!auth?.user) return signInRedirect(query);

  const requestToken = await createConsentRequest(validated.params, auth.user.id);
  return {
    props: {
      details: consentDetails(validated.client, validated.params),
      email: auth.user.email || '',
      requestToken,
    },
  };
}
