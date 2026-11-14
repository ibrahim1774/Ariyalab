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
 * Order: validate the request (bad client or redirect_uri -> error card,
 * never a redirect; anything else -> error redirect to the client), then
 * require the Supabase session (signed out -> /sign-in with a returnTo
 * back to this request), then store a consent request bound to the user
 * and render Allow / Deny. The form posts to /api/oauth/authorize with
 * the single-use request token. Framing is forbidden (headers here and in
 * next.config.js).
 *
 * Client-supplied values (client name, client URI) render as plain text.
 */
export default function OAuthConsentPage({ error = null, details = null, email = '', requestToken = '' }) {
  return (
    <>
      <Head>
        <title>{error ? 'Connection error' : 'Allow access'} · Ariya Lab</title>
        <meta name="robots" content="noindex" />
        <meta name="referrer" content="no-referrer" />
      </Head>
      <main className={styles.page}>
        <Card className={styles.card}>
          <p className={styles.brand}>Ariya Lab</p>
          {error ? (
            <>
              <h1 className={styles.title}>{error.title}</h1>
              <p className={styles.text}>{error.message}</p>
            </>
          ) : (
            <>
              <h1 className={styles.title}>
                Allow <span className={styles.client}>{details.clientName}</span> to use your account?
              </h1>
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
              <form method="post" action="/api/oauth/authorize" className={styles.actions}>
                <input type="hidden" name="request_token" value={requestToken} />
                <Button type="submit" name="decision" value="deny" variant="ghost" arrow={false}>
                  Deny
                </Button>
                <Button type="submit" name="decision" value="allow">
                  Allow
                </Button>
              </form>
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
  res.setHeader('Referrer-Policy', 'no-referrer');
}

export async function getServerSideProps({ req, res, query }) {
  setConsentHeaders(res);
  let validated;
  try {
    validated = await validateAuthorizeRequest(query, req);
  } catch (err) {
    if (!(err instanceof OAuthError)) throw err;
    if (err.redirect) return { redirect: { destination: err.redirect, permanent: false } };
    res.statusCode = 400;
    return { props: { error: { title: 'This connection cannot continue', message: err.message } } };
  }

  const auth = await getUserFromRequest(req, res);
  if (!auth?.user) {
    return {
      redirect: { destination: `/sign-in?returnTo=${encodeURIComponent(consentPath(query))}`, permanent: false },
    };
  }

  const requestToken = await createConsentRequest(validated.params, auth.user.id);
  return {
    props: {
      details: consentDetails(validated.client, validated.params),
      email: auth.user.email || '',
      requestToken,
    },
  };
}
