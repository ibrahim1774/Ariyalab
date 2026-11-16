import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { setCreditsDb, grantCredits, holdCredits, settleHold, getBalance, holdRemaining } from '../../lib/credits.js';
import { setStoryDb } from '../../lib/story/db.js';
import { sweepStaleHolds } from '../../lib/story/holdSweeper.js';
import storyHoldsCron from '../../pages/api/cron/story-holds.js';

let db;
beforeAll(async () => {
  db = await createTestDb();
  setCreditsDb(db);
  setStoryDb(db);
  process.env.CRON_SECRET = 'cron_test_secret';
}, 60_000);
afterAll(async () => {
  setCreditsDb(null);
  setStoryDb(null);
  await db?.close();
});

const noRecover = async () => {};
async function account(credits = 1000) {
  const userId = randomUUID();
  await grantCredits({ userId, currency: 'video', amount: credits, bucket: 'topup', reason: 'test_grant', ref: `seed:${userId}` });
  return userId;
}
async function project(userId, extra = {}) {
  const { rows } = await db.query('insert into public.story_projects (user_id) values ($1) returning id', [userId]);
  const id = rows[0].id;
  for (const [k, v] of Object.entries(extra)) {
    await db.query(`update public.story_projects set ${k} = $2 where id = $1`, [id, v]);
  }
  return id;
}
async function hold(userId, projectId, amount, { ageMinutes = 120 } = {}) {
  const holdId = randomUUID();
  await holdCredits({ userId, currency: 'video', amount, projectId, holdId });
  await db.query(`update public.credit_holds set created_at = now() - make_interval(mins => $2) where id = $1`, [holdId, ageMinutes]);
  return holdId;
}
async function job(userId, projectId, holdId, { status = 'queued', cost = 30, applied = false, payload = {} } = {}) {
  const { rows } = await db.query(
    `insert into public.story_jobs (project_id, user_id, kind, status, hold_id, cost_credits, payload, applied_at)
     values ($1, $2, 'clip', $3, $4, $5, $6::jsonb, case when $7 then now() else null end) returning id`,
    [projectId, userId, status, holdId, cost, JSON.stringify(payload), applied]
  );
  return rows[0].id;
}
const available = async (userId) => (await getBalance(userId, 'video')).available;

describe('stale story-hold sweeper (backstop)', () => {
  it('Task 14 path-A reset that lost its compare and set: a full hold with no jobs and no row is released in full', async () => {
    const user = await account();
    const p = await project(user);
    const h = await hold(user, p, 150);
    expect(await available(user)).toBe(850);
    const summary = await sweepStaleHolds({ recover: noRecover });
    expect(summary.released).toBeGreaterThanOrEqual(1);
    expect(await holdRemaining(h)).toEqual({ remaining: 0, status: 'closed' });
    expect(await available(user)).toBe(1000);
  });

  it('releaseUnowned under-release and the releaseClaim/settleLostClaim over-hold: the remainder after every job applied is released, the settled share stays spent', async () => {
    const user = await account();
    const p = await project(user);
    const h = await hold(user, p, 100);
    const j = await job(user, p, h, { status: 'done', cost: 30 });
    await settleHold({ holdId: h, amount: 30, reason: 'story_clip', ref: `job:${j}:settle` });
    await db.query('update public.story_jobs set applied_at = now() where id = $1', [j]);
    await sweepStaleHolds({ recover: noRecover });
    expect(await holdRemaining(h)).toEqual({ remaining: 0, status: 'closed' });
    expect(await available(user)).toBe(970);
  });

  it('Task 16 N5 (request killed between the last enqueue and the fee settle): the stale claim is recovered, the fee part released, the queued job keeps its share', async () => {
    const user = await account();
    const claimId = randomUUID();
    const p = await project(user);
    const h = await hold(user, p, 120); // 90 fee + one 30-credit clip
    await db.query(
      `update public.story_projects set gen_claim_id = $2, gen_hold_id = $3, gen_claimed_at = now() - interval '1 hour', gen_shots = '[]'::jsonb where id = $1`,
      [p, claimId, h]
    );
    await job(user, p, h, { status: 'queued', cost: 30, payload: { claimId } });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await sweepStaleHolds(); // the real stall recoveries run first
    err.mockRestore();
    expect(await holdRemaining(h)).toEqual({ remaining: 30, status: 'active' });
    const { rows } = await db.query('select gen_claim_id from public.story_projects where id = $1', [p]);
    expect(rows[0].gen_claim_id).toBeNull();
    expect(await available(user)).toBe(970);
  });

  describe('never releases a hold that can still settle or is owned elsewhere', () => {
    it('a queued or running job, or a finished job whose share is not applied yet', async () => {
      const user = await account();
      const p = await project(user);
      const h1 = await hold(user, p, 60);
      await job(user, p, h1, { status: 'running' });
      const h2 = await hold(user, p, 60);
      await job(user, p, h2, { status: 'done', cost: 30, applied: false });
      await sweepStaleHolds({ recover: noRecover });
      expect((await holdRemaining(h1)).remaining).toBe(60);
      expect((await holdRemaining(h2)).remaining).toBe(60);
    });

    it('an open claim, a still claim, a cast round, an audio claim or a voice', async () => {
      const user = await account();
      const p = await project(user);
      const gen = await hold(user, p, 10);
      await db.query(`update public.story_projects set gen_claim_id = gen_random_uuid(), gen_hold_id = $2, gen_claimed_at = now() where id = $1`, [p, gen]);
      const audio = await hold(user, p, 10);
      await db.query(`update public.story_projects set audio_claims = jsonb_build_object('music', jsonb_build_object('id', gen_random_uuid(), 'hold_id', $2::text, 'at', now())) where id = $1`, [p, audio]);
      const cast = await hold(user, p, 10);
      await db.query(`insert into public.story_cast (project_id, name, hold_id) values ($1, 'Mia', $2)`, [p, cast]);
      const still = await hold(user, p, 10);
      await db.query(`insert into public.story_shots (project_id, ord, still_hold_id, still_claimed_at) values ($1, 0, $2, now())`, [p, still]).catch(async () => {
        // story_shots needs a scene id in some schemas: fill the required columns generically.
        const { rows } = await db.query(`select column_name from information_schema.columns where table_name = 'story_shots' and is_nullable = 'NO' and column_default is null`);
        throw new Error(`story_shots requires: ${rows.map((r) => r.column_name).join(', ')}`);
      });
      await sweepStaleHolds({ recover: noRecover });
      for (const h of [gen, audio, cast, still]) expect((await holdRemaining(h)).remaining).toBe(10);
    });

    it('a young hold, an old-tools hold (no project) and a voice hold are left alone', async () => {
      const user = await account();
      const p = await project(user);
      const young = await hold(user, p, 10, { ageMinutes: 5 });
      const tools = await hold(user, null, 10);
      await db.query(`select public.credit_legacy_hold_open($1, $2, 'video', 10, 'image-to-video')`, [tools, user]);
      await sweepStaleHolds({ recover: noRecover, olderThanMinutes: 1 }); // the 30-minute floor still applies
      expect((await holdRemaining(young)).remaining).toBe(10);
      expect((await holdRemaining(tools)).remaining).toBe(10);
      // Even called directly with a 0-minute age, the SQL keeps its own floor and its own checks.
      const { rows } = await db.query('select public.story_release_orphan_hold($1, 0) as n', [young]);
      expect(rows[0].n).toBe(0);
    });

    it('a second run changes nothing', async () => {
      const user = await account();
      const p = await project(user);
      await hold(user, p, 40);
      await sweepStaleHolds({ recover: noRecover });
      const before = await db.query('select count(*)::int as n from public.credit_ledger where user_id = $1', [user]);
      const again = await sweepStaleHolds({ recover: noRecover });
      const after = await db.query('select count(*)::int as n from public.credit_ledger where user_id = $1', [user]);
      expect(after.rows[0].n).toBe(before.rows[0].n);
      expect(again.credits).toBe(0);
      expect(await available(user)).toBe(1000);
    });
  });

  it('the cron needs CRON_SECRET', async () => {
    const res = { statusCode: 200, headers: {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, setHeader() {} };
    await storyHoldsCron({ method: 'GET', headers: { authorization: 'Bearer wrong' } }, res);
    expect(res.statusCode).toBe(401);
    await storyHoldsCron({ method: 'GET', headers: { authorization: 'Bearer cron_test_secret' } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
