import { describe, expect, it, vi } from 'vitest';

// listStaleHolds against a recorded PostgREST builder (the production path): the keyset cursor is sent
// as the database's own timestamp text, double-quoted, and never URL-encoded here (postgrest-js encodes
// the whole filter once).
const calls = vi.hoisted(() => []);
vi.mock('../lib/supabaseServer', () => {
  const builder = () => {
    const b = {};
    for (const m of ['select', 'eq', 'lt', 'not', 'order', 'limit']) b[m] = (...args) => { calls.push([m, ...args]); return b; };
    b.or = (filter) => { calls.push(['or', filter]); return b; };
    b.then = (resolve) => resolve({ data: [], error: null });
    return b;
  };
  return { getSupabaseAdmin: () => ({ from: () => builder() }) };
});

const { listStaleHolds, setCreditsDb } = await import('../lib/credits.js');

describe('listStaleHolds cursor (PostgREST path)', () => {
  it('sends the raw microsecond timestamp quoted, not encoded', async () => {
    setCreditsDb(null);
    await listStaleHolds({
      olderThanMinutes: 30, projectOnly: true, limit: 2,
      after: { createdAt: '2026-11-16T10:00:00.123456+00:00', id: '00000000-0000-4000-8000-000000000001' },
    });
    const or = calls.find((c) => c[0] === 'or')[1];
    expect(or).toBe(
      'created_at.gt."2026-11-16T10:00:00.123456+00:00",and(created_at.eq."2026-11-16T10:00:00.123456+00:00",id.gt.00000000-0000-4000-8000-000000000001)'
    );
    expect(or).not.toMatch(/%[0-9A-F]{2}/);
    expect(calls).toContainEqual(['not', 'project_id', 'is', null]);
  });
});
