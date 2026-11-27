// pages/api/admin/migrate-legacy-credits.js: admin-gated, argv built on the
// server from validated fields only. The gate and the script are mocked.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeReq, makeRes } from '../helpers/apiMock';

const S = vi.hoisted(() => ({ admin: true, run: null }));

vi.mock('../../lib/adminGate', () => ({
  requireAdmin: vi.fn(async (_req, res) => {
    if (!S.admin) {
      res.status(403).json({ error: 'Forbidden' });
      return null;
    }
    return { user: { id: 'admin', email: 'admin@example.test' }, supabase: {} };
  }),
}));
vi.mock('../../scripts/migrate-legacy-credits.mjs', () => ({
  runMigration: vi.fn((opts) => S.run(opts)),
}));

const { default: handler, config } = await import('../../pages/api/admin/migrate-legacy-credits.js');
const { runMigration } = await import('../../scripts/migrate-legacy-credits.mjs');

const call = async (body, method = 'POST') => {
  const res = makeRes();
  await handler(makeReq({ method, body }), res);
  return res;
};

beforeEach(() => {
  S.admin = true;
  runMigration.mockClear();
});

describe('/api/admin/migrate-legacy-credits (retired)', () => {
  it('sets maxDuration 300', () => {
    expect(config).toEqual({ maxDuration: 300 });
  });

  it('keeps the admin gate first: a non-admin gets the gate answer, not 410', async () => {
    S.admin = false;
    const res = await call({ cutoff: '2026-11-25T12:00:00Z' });
    expect(res.statusCode).toBe(403);
    expect(runMigration).not.toHaveBeenCalled();
  });

  it.each(['POST', 'GET', 'PUT', 'DELETE'])('answers 410 disabled to an admin for %s and never runs the migration', async (method) => {
    const res = await call({ cutoff: '2026-11-25T12:00:00Z', apply: true, confirm: '1:1' }, method);
    expect(res.statusCode).toBe(410);
    expect(res.body).toEqual({
      error: 'disabled',
      reason: 'Ariya Lab customers stay on ariyalab.online; their legacy credits are never moved to the ledger.',
    });
    expect(runMigration).not.toHaveBeenCalled();
  });
});
