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

const CUTOFF = '2026-11-25T12:00:00Z';
const call = async (body, method = 'POST') => {
  const res = makeRes();
  await handler(makeReq({ method, body }), res);
  return res;
};

beforeEach(() => {
  S.admin = true;
  S.run = async ({ log }) => {
    log('{"mode":"dry-run"}');
    log('Dry run: 2 customer(s)');
    return { ok: true, rows: [{ customerId: 'cus_1' }], count: 2, total: 50 };
  };
  runMigration.mockClear();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('POST /api/admin/migrate-legacy-credits', () => {
  it('allows only POST', async () => {
    const res = await call({ cutoff: CUTOFF }, 'GET');
    expect(res.statusCode).toBe(405);
    expect(res.headers.Allow).toBe('POST');
    expect(runMigration).not.toHaveBeenCalled();
  });

  it('sets maxDuration 300', () => {
    expect(config).toEqual({ maxDuration: 300 });
  });

  it('does nothing for a non-admin', async () => {
    S.admin = false;
    const res = await call({ cutoff: CUTOFF });
    expect(res.statusCode).toBe(403);
    expect(runMigration).not.toHaveBeenCalled();
  });

  it.each([undefined, '', 'not a date', 5, null])('rejects cutoff %j', async (cutoff) => {
    const res = await call({ cutoff });
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'cutoff_required' });
    expect(runMigration).not.toHaveBeenCalled();
  });

  it('dry run argv is exact; includeDormant adds its flag', async () => {
    const res = await call({ cutoff: CUTOFF });
    expect(res.statusCode).toBe(200);
    expect(runMigration.mock.calls[0][0].argv).toEqual([`--cutoff=${CUTOFF}`, '--allow-live']);
    expect(res.body).toMatchObject({ ok: true, mode: 'dry-run', count: 2, total: 50, report: null, summary: 'Dry run: 2 customer(s)' });
    await call({ cutoff: CUTOFF, includeDormant: true });
    expect(runMigration.mock.calls[1][0].argv).toEqual([`--cutoff=${CUTOFF}`, '--allow-live', '--include-dormant']);
  });

  it('apply needs a valid confirm', async () => {
    for (const confirm of [undefined, '', '3', 'a:b']) {
      const res = await call({ cutoff: CUTOFF, apply: true, confirm });
      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ error: 'confirm_required' });
    }
    expect(runMigration).not.toHaveBeenCalled();
    const res = await call({ cutoff: CUTOFF, apply: true, confirm: '3:120' });
    expect(res.statusCode).toBe(200);
    expect(runMigration.mock.calls[0][0].argv).toEqual([`--cutoff=${CUTOFF}`, '--allow-live', '--apply', '--confirm=3:120']);
    expect(res.body.mode).toBe('apply');
  });

  it('never passes extra body fields to argv', async () => {
    await call({
      cutoff: CUTOFF,
      allowFlagOff: true,
      report: '/etc/x',
      argv: ['--allow-flag-off', '--report=/etc/x'],
      confirm: '9:9',
    });
    const argv = runMigration.mock.calls[0][0].argv;
    expect(argv).toEqual([`--cutoff=${CUTOFF}`, '--allow-live']);
    await call({ cutoff: CUTOFF, apply: true, confirm: '3:120', allowFlagOff: true, report: '/etc/x' });
    const argv2 = runMigration.mock.calls[1][0].argv;
    expect(argv2.some((a) => a.includes('allow-flag-off') || a.includes('--report'))).toBe(false);
  });

  it('returns the in-memory report parsed, and 422 when not ok', async () => {
    S.run = async ({ log, fail, writeReport }) => {
      writeReport('some-path.json', JSON.stringify({ mode: 'apply', count: 1 }));
      fail('1 need a look');
      log('Applied: 0 of 1');
      return { ok: false, rows: [{ result: 'error' }], count: 1, total: 10, reportPath: 'some-path.json' };
    };
    const res = await call({ cutoff: CUTOFF, apply: true, confirm: '1:10' });
    expect(res.statusCode).toBe(422);
    expect(res.body).toMatchObject({
      ok: false,
      mode: 'apply',
      report: { mode: 'apply', count: 1 },
      messages: ['1 need a look'],
      summary: 'Applied: 0 of 1',
    });
  });

  it('answers 500 migration_failed on an exception', async () => {
    S.run = async () => {
      throw new Error('boom');
    };
    const res = await call({ cutoff: CUTOFF });
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'migration_failed', message: 'boom' });
  });
});
