import { requireAdmin } from '../../../lib/adminGate';
import { getFeatureTabsEnabled, setFeatureTabsEnabled } from '../../../lib/featureFlags';

export default async function handler(req, res) {
  // ADMIN_EMAILS and a confirmed email (lib/adminGate.js).
  if (!(await requireAdmin(req, res))) return undefined;

  if (req.method === 'GET') {
    const enabled = await getFeatureTabsEnabled();
    return res.status(200).json({ enabled });
  }

  if (req.method === 'POST') {
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'Body must be { enabled: boolean }.' });
    }
    try {
      const value = await setFeatureTabsEnabled(enabled);
      return res.status(200).json({ enabled: value });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
