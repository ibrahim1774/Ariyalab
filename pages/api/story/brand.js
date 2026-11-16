import { getUserFromRequest } from '../../../lib/supabaseServer.js';
import { sendError } from '../../../lib/story/errors.js';
import { getBrand, saveBrand } from '../../../lib/story/assets.js';

/*
 * The customer's brand text: what they offer, who it is for, the tone, words to avoid, colours and the logo.
 * New videos start with the offer and audience filled in; the tone and the avoid words guide every script.
 *
 *   GET /api/story/brand                                  -> { brand: { offer, audience, tone, avoid: [word], colors: ['#rrggbb'], logo } }
 *   PUT /api/story/brand  { offer?, audience?, tone?, avoid?, colors?, logoAssetId? } -> { brand }   (a field left out is kept)
 */
export const config = { api: { bodyParser: { sizeLimit: '32kb' } } };

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'PUT') {
    res.setHeader('Allow', 'GET, PUT');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  const session = await getUserFromRequest(req, res);
  if (!session) return res.status(401).json({ error: 'unauthorized', message: 'Authentication required.' });
  const userId = session.user.id;
  try {
    if (req.method === 'GET') return res.status(200).json({ brand: await getBrand({ userId }) });
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    return res.status(200).json({ brand: await saveBrand({ userId, patch: body }) });
  } catch (err) {
    return sendError(res, err);
  }
}
