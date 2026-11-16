import { getUserFromRequest } from '../../../lib/supabaseServer.js';
import { sendError } from '../../../lib/story/errors.js';
import { clientIp, createVoice, deleteVoice, listVoicesFor, retryVoice } from '../../../lib/story/voices.js';

/*
 * The customer's cloned voices (private to them; every lookup filters by their id).
 *
 *   GET    /api/story/voices            -> { voices, presets, price, statement, limits }
 *   POST   /api/story/voices            { name, consent: true, sampleAssetId, expected_credits? }  -> 201 { voice, charged }
 *   POST   /api/story/voices            { retry: <voice id>, expected_credits? }                    -> 201 { voice, charged }
 *   DELETE /api/story/voices?id=<id>    -> { deleted: true }
 *
 * A clone is one paid provider call made inside this request, so the route gets the whole function (maxDuration 300):
 * the sample download is capped at 90 s and the provider call at 180 s. The price is held first, settled when the voice
 * was made and released when it was not (lib/story/voices.js). The consent statement and the address are recorded by the
 * server; whatever statement the browser sends is ignored.
 */
export const config = { api: { bodyParser: { sizeLimit: '16kb' } }, maxDuration: 300 };

export default async function handler(req, res) {
  if (!['GET', 'POST', 'DELETE'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  const session = await getUserFromRequest(req, res);
  if (!session) return res.status(401).json({ error: 'unauthorized', message: 'Authentication required.' });
  const userId = session.user.id;
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  try {
    if (req.method === 'GET') return res.status(200).json(await listVoicesFor({ userId }));
    if (req.method === 'DELETE') return res.status(200).json(await deleteVoice({ userId, id: String(req.query?.id ?? '') }));
    const expectedCredits = body.expected_credits;
    if (body.retry !== undefined) {
      return res.status(201).json(await retryVoice({ userId, user: session.user, id: String(body.retry), expectedCredits }));
    }
    return res.status(201).json(await createVoice({
      userId, user: session.user, name: body.name, consent: body.consent, sampleAssetId: body.sampleAssetId, expectedCredits, ip: clientIp(req),
    }));
  } catch (err) {
    return sendError(res, err);
  }
}
