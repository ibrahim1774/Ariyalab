import { requireAdmin } from '../../../lib/adminGate';
import { runMigration } from '../../../scripts/migrate-legacy-credits.mjs';

/*
 * Admin route that runs the legacy credit migration on the server, where the
 * live Stripe key and the Supabase service role key already are.
 *
 *   POST { cutoff, includeDormant?, apply?, confirm? }
 *
 * Dry run by default. Applying needs `confirm` ("<customers>:<credits>") from
 * a dry run. Only those fields are read; the argv is built here, never taken
 * from the body, and --allow-flag-off / --report are never passed. The report
 * is kept in memory and returned (no file system on Vercel).
 */

export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const gate = await requireAdmin(req, res);
  if (!gate) return undefined;

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const cutoff = typeof body.cutoff === 'string' ? body.cutoff.trim() : '';
  if (!cutoff || !Number.isFinite(Date.parse(cutoff))) {
    return res.status(400).json({ error: 'cutoff_required' });
  }
  const includeDormant = body.includeDormant === true;
  const apply = body.apply === true;
  const confirm = typeof body.confirm === 'string' ? body.confirm.trim() : '';
  if (apply && !/^\d+:\d+$/.test(confirm)) {
    return res.status(400).json({ error: 'confirm_required' });
  }

  const argv = [`--cutoff=${cutoff}`, '--allow-live'];
  if (includeDormant) argv.push('--include-dormant');
  if (apply) argv.push('--apply', `--confirm=${confirm}`);

  const logs = [];
  const messages = [];
  let reportBody = null;
  try {
    const out = await runMigration({
      argv,
      log: (line) => {
        logs.push(line);
      },
      fail: (line) => {
        messages.push(line);
        console.error('[admin/migrate-legacy-credits]', line);
      },
      writeReport: (_path, content) => {
        reportBody = content;
      },
    });
    const summary = logs.length ? logs[logs.length - 1] : null;
    if (summary) console.info('[admin/migrate-legacy-credits]', summary);
    let report = null;
    if (reportBody) {
      try {
        report = JSON.parse(reportBody);
      } catch {
        report = null;
      }
    }
    return res.status(out.ok ? 200 : 422).json({
      ok: Boolean(out.ok),
      mode: apply ? 'apply' : 'dry-run',
      count: out.count,
      total: out.total,
      rows: out.rows,
      report,
      messages,
      summary,
    });
  } catch (err) {
    console.error('[admin/migrate-legacy-credits] failed', err);
    return res.status(500).json({ error: 'migration_failed', message: err?.message || String(err) });
  }
}
