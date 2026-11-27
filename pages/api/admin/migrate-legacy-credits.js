import { requireAdmin } from '../../../lib/adminGate';

/*
 * RETIRED. The legacy credit migration is disabled permanently: Ariya Lab customers stay on
 * ariyalab.online and their legacy (customer metadata) credits are never moved to the ledger.
 * Classic does not know about the ledger, so a migrated balance could be spent twice (once there,
 * once here). The script (scripts/migrate-legacy-credits.mjs) stays in the repo but refuses to run
 * unless ALLOW_LEGACY_MIGRATION is set. The admin gate stays first, so non-admins still get 401/403.
 */

export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  const gate = await requireAdmin(req, res);
  if (!gate) return undefined;
  return res.status(410).json({
    error: 'disabled',
    reason: 'Ariya Lab customers stay on ariyalab.online; their legacy credits are never moved to the ledger.',
  });
}
