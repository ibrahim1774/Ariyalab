import { OAuthError, consentPath, decideConsent, oauthIssuer } from '../../../lib/mcp/oauth.js';
import { hasContentType, methodNotAllowed, sendErrorPage } from '../../../lib/mcp/oauthHttp.js';
import { getUserFromRequest } from '../../../lib/supabaseServer.js';

/*
 * OAuth authorization endpoint (advertised in the server metadata).
 *
 * GET: forwards the authorization request to the consent page, which
 *   validates it, requires the Supabase session and shows Allow / Deny.
 * POST (the consent form, application/x-www-form-urlencoded):
 *   request_token, decision=allow|deny. Same-origin only, needs the
 *   session of the user the request was shown to. Redirects (303) to the
 *   client's redirect_uri with code, state and iss, or error=access_denied.
 */
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET') {
    return res.redirect(302, consentPath(req.query));
  }
  if (req.method !== 'POST') return methodNotAllowed(res, 'GET, POST');

  if (!hasContentType(req, 'application/x-www-form-urlencoded')) {
    return sendErrorPage(res, 415, 'Request not accepted', 'Submit the form on the consent page.');
  }
  const origin = req.headers.origin;
  const fetchSite = req.headers['sec-fetch-site'];
  if ((origin && origin !== new URL(oauthIssuer(req)).origin) || (fetchSite && fetchSite !== 'same-origin')) {
    return sendErrorPage(res, 403, 'Request not accepted', 'The approval must come from the Ariya Lab consent page.');
  }
  const auth = await getUserFromRequest(req, res);
  if (!auth?.user) {
    return sendErrorPage(res, 401, 'Signed out', 'Your session ended. Start the connection again from Claude.');
  }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  try {
    const location = await decideConsent(
      { token: body.request_token, userId: auth.user.id, decision: body.decision === 'allow' ? 'allow' : 'deny' },
      req
    );
    return res.redirect(303, location);
  } catch (err) {
    if (err instanceof OAuthError) return sendErrorPage(res, 400, 'Request expired', err.message);
    console.error('[oauth/authorize] unexpected error', err);
    return sendErrorPage(res, 500, 'Something went wrong', 'Please start the connection again from Claude.');
  }
}

export const config = { api: { bodyParser: { sizeLimit: '8kb' } } };
