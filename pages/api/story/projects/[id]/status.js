import { getUserFromRequest } from '../../../../../lib/supabaseServer.js';
import { sendError } from '../../../../../lib/story/errors.js';
import { getProjectStatus } from '../../../../../lib/story/status.js';

/*
 * GET /api/story/projects/[id]/status -> { project, shots, cast, jobs, balance, render, audio, rerolls }
 * (lib/story/status.js). The maker polls it every 3 s while work is running.
 * It also runs one runner tick for the project, so it has its own file and a
 * maxDuration that covers the tick. This static route wins over [action].js.
 */

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  const session = await getUserFromRequest(req, res);
  if (!session) return res.status(401).json({ error: 'unauthorized', message: 'Authentication required.' });
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  try {
    const body = await getProjectStatus({ userId: session.user.id, projectId: String(req.query?.id ?? '') });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(body);
  } catch (err) {
    return sendError(res, err);
  }
}
