import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '../helpers/db.js';

let db;

beforeAll(async () => {
  db = await createTestDb();
}, 60_000);

afterAll(async () => {
  await db?.close();
});

const one = async (sql, params) => (await db.query(sql, params)).rows[0];

const USER_A = randomUUID();
const USER_B = randomUUID();

async function seedProject(userId) {
  const p = await one(
    `insert into story_projects (user_id, title) values ($1, 'Seed') returning *`,
    [userId]
  );
  const shot = await one(
    `insert into story_shots (project_id, ord, description) values ($1, 0, 'A barber smiles') returning *`,
    [p.id]
  );
  const job = await one(
    `insert into story_jobs (project_id, user_id, shot_id, kind) values ($1, $2, $3, 'still') returning *`,
    [p.id, userId, shot.id]
  );
  return { project: p, shot, job };
}

const asUser = async (user, sql, params) => {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${user}', false);`);
  try {
    return await db.query(sql, params);
  } finally {
    await db.exec("reset role; select set_config('request.jwt.claim.sub', '', false);");
  }
};

const asRole = async (role, sql, params) => {
  await db.exec(`set role ${role};`);
  try {
    return await db.query(sql, params);
  } finally {
    await db.exec('reset role;');
  }
};

describe('story schema', () => {
  it('creates every story table', async () => {
    const { rows } = await db.query(
      `select table_name from information_schema.tables
        where table_schema = 'public' and table_name like 'story\\_%' order by table_name`
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      'story_assets', 'story_brand', 'story_cast', 'story_chat', 'story_jobs', 'story_projects',
      'story_references', 'story_renders', 'story_scripts', 'story_shots', 'story_usage', 'story_voices',
    ]);
  });

  it('applies project defaults', async () => {
    const p = await one(`insert into story_projects (user_id) values ($1) returning *`, [USER_A]);
    expect(p).toMatchObject({
      step: 'brief', status: 'draft', mode: 'narrated', aspect: '9:16', quality: 'standard',
      seconds: 30, fee_charged: false, rerolls_used: 0, reference_id: null,
    });
  });

  it.each([
    ['purpose', 'crypto'],
    ['style', 'photoreal'],
    ['aspect', '4:3'],
    ['quality', 'ultra'],
    ['mode', 'silent'],
    ['step', 'publish'],
    ['status', 'paused'],
  ])('rejects an unknown project %s', async (column, value) => {
    await expect(
      db.query(`insert into story_projects (user_id, ${column}) values ($1, $2)`, [USER_A, value])
    ).rejects.toThrow(/check constraint/);
  });

  it('rejects seconds outside 15 to 75', async () => {
    await expect(db.query(`insert into story_projects (user_id, seconds) values ($1, 10)`, [USER_A])).rejects.toThrow(/check/);
    await expect(db.query(`insert into story_projects (user_id, seconds) values ($1, 76)`, [USER_A])).rejects.toThrow(/check/);
  });

  it('checks shot status and source, job kind and status', async () => {
    const { project } = await seedProject(USER_A);
    await expect(
      db.query(`insert into story_shots (project_id, ord, status) values ($1, 1, 'done')`, [project.id])
    ).rejects.toThrow(/check/);
    await expect(
      db.query(`insert into story_shots (project_id, ord, source) values ($1, 1, 'stock')`, [project.id])
    ).rejects.toThrow(/check/);
    await expect(
      db.query(`insert into story_jobs (project_id, user_id, kind) values ($1, $2, 'upscale')`, [project.id, USER_A])
    ).rejects.toThrow(/check/);
    await expect(
      db.query(`insert into story_jobs (project_id, user_id, kind, status) values ($1, $2, 'clip', 'paused')`, [project.id, USER_A])
    ).rejects.toThrow(/check/);
  });

  it('deleting a project cascades to its children', async () => {
    const { project } = await seedProject(USER_A);
    await db.query(`insert into story_scripts (project_id, version, scenes) values ($1, 1, '[]')`, [project.id]);
    await db.query(`insert into story_cast (project_id, name) values ($1, 'Sam')`, [project.id]);
    await db.query(`insert into story_chat (project_id, role, content) values ($1, 'user', '"hi"')`, [project.id]);
    await db.query(`delete from story_projects where id = $1`, [project.id]);
    for (const t of ['story_shots', 'story_jobs', 'story_scripts', 'story_cast', 'story_chat']) {
      const r = await one(`select count(*)::int as n from ${t} where project_id = $1`, [project.id]);
      expect(r.n, t).toBe(0);
    }
  });

  it('keeps updated_at current on update', async () => {
    const { project } = await seedProject(USER_A);
    await db.query(`update story_projects set updated_at = now() - interval '1 day' where id = $1`, [project.id]);
    await db.query(`update story_projects set title = 'New' where id = $1`, [project.id]);
    const p = await one(`select updated_at > now() - interval '1 minute' as fresh from story_projects where id = $1`, [project.id]);
    expect(p.fresh).toBe(true);
  });
});

describe('row level security', () => {
  it('a user cannot read another user’s project, shots or jobs', async () => {
    const { project, shot, job } = await seedProject(USER_A);
    for (const [table, id] of [['story_projects', project.id], ['story_shots', shot.id], ['story_jobs', job.id]]) {
      const own = await asUser(USER_A, `select id from ${table} where id = $1`, [id]);
      expect(own.rows, `${table} owner`).toHaveLength(1);
      const other = await asUser(USER_B, `select id from ${table} where id = $1`, [id]);
      expect(other.rows, `${table} other`).toHaveLength(0);
    }
  });

  it('a user cannot write story_shots or story_jobs at all', async () => {
    const { project, shot, job } = await seedProject(USER_A);
    await expect(
      asUser(USER_A, `insert into story_shots (project_id, ord) values ($1, 5)`, [project.id])
    ).rejects.toThrow(/permission denied/);
    await expect(
      asUser(USER_A, `update story_shots set clip_url = 'x' where id = $1`, [shot.id])
    ).rejects.toThrow(/permission denied/);
    await expect(
      asUser(USER_A, `insert into story_jobs (project_id, user_id, kind) values ($1, $2, 'clip')`, [project.id, USER_A])
    ).rejects.toThrow(/permission denied/);
    await expect(
      asUser(USER_A, `update story_jobs set status = 'done' where id = $1`, [job.id])
    ).rejects.toThrow(/permission denied/);
    await expect(asUser(USER_A, `delete from story_jobs where id = $1`, [job.id])).rejects.toThrow(/permission denied/);
  });

  it('owners may insert and update their own project, but not billing columns', async () => {
    const { rows } = await asUser(
      USER_A,
      `insert into story_projects (user_id, title) values ($1, 'Mine') returning id`,
      [USER_A]
    );
    const id = rows[0].id;
    await asUser(USER_A, `update story_projects set title = 'Renamed' where id = $1`, [id]);
    expect((await one(`select title from story_projects where id = $1`, [id])).title).toBe('Renamed');
    await expect(
      asUser(USER_A, `update story_projects set fee_charged = true where id = $1`, [id])
    ).rejects.toThrow(/permission denied/);
    await expect(
      asUser(USER_A, `insert into story_projects (user_id, fee_charged) values ($1, true)`, [USER_A])
    ).rejects.toThrow(/permission denied/);
  });

  it('a user cannot create a project or script for someone else', async () => {
    await expect(
      asUser(USER_B, `insert into story_projects (user_id) values ($1)`, [USER_A])
    ).rejects.toThrow(/row-level security/);
    const { project } = await seedProject(USER_A);
    await expect(
      asUser(USER_B, `insert into story_scripts (project_id, version, scenes) values ($1, 9, '[]')`, [project.id])
    ).rejects.toThrow(/row-level security/);
    const upd = await asUser(USER_B, `update story_projects set title = 'hijack' where id = $1 returning id`, [project.id]);
    expect(upd.rows).toHaveLength(0);
  });

  it('owners can write scripts and assets for themselves', async () => {
    const { project } = await seedProject(USER_A);
    await asUser(USER_A, `insert into story_scripts (project_id, version, scenes) values ($1, 1, '[]')`, [project.id]);
    await asUser(
      USER_A,
      `insert into story_assets (user_id, kind, url) values ($1, 'logo', 'https://example.test/l.png')`,
      [USER_A]
    );
    const scripts = await asUser(USER_A, `select id from story_scripts where project_id = $1`, [project.id]);
    expect(scripts.rows).toHaveLength(1);
  });

  it('anon sees nothing', async () => {
    await seedProject(USER_A);
    await expect(asRole('anon', `select * from story_projects`)).rejects.toThrow(/permission denied/);
  });

  it('only service_role may execute the story functions', async () => {
    await expect(
      asUser(USER_A, `select * from story_claim_jobs($1, 5)`, [randomUUID()])
    ).rejects.toThrow(/permission denied/);
    const r = await asRole('service_role', `select * from story_claim_jobs($1, 5)`, [randomUUID()]);
    expect(r.rows).toEqual([]);
  });
});

describe('story_claim_jobs', () => {
  it('claims only due queued jobs of the project, oldest first, once', async () => {
    const { project, job: first } = await seedProject(USER_A);
    const later = await one(
      `insert into story_jobs (project_id, user_id, kind, created_at) values ($1, $2, 'clip', now() + interval '1 second') returning *`,
      [project.id, USER_A]
    );
    const future = await one(
      `insert into story_jobs (project_id, user_id, kind, run_after) values ($1, $2, 'clip', now() + interval '1 hour') returning *`,
      [project.id, USER_A]
    );
    const due = await one(
      `insert into story_jobs (project_id, user_id, kind, run_after, created_at) values ($1, $2, 'clip', now() - interval '1 minute', now() + interval '2 seconds') returning *`,
      [project.id, USER_A]
    );
    const other = await seedProject(USER_B);

    const claimed = (await db.query(`select * from story_claim_jobs($1, 10)`, [project.id])).rows;
    expect(claimed.map((j) => j.id)).toEqual([first.id, later.id, due.id]);
    for (const j of claimed) {
      expect(j.status).toBe('running');
      expect(j.attempts).toBe(1);
      expect(new Date(j.locked_until).getTime()).toBeGreaterThan(Date.now() + 60_000);
    }
    expect(claimed.map((j) => j.id)).not.toContain(future.id);
    expect(claimed.map((j) => j.id)).not.toContain(other.job.id);

    const again = (await db.query(`select * from story_claim_jobs($1, 10)`, [project.id])).rows;
    expect(again).toEqual([]);
  });

  it('respects the limit', async () => {
    const { project } = await seedProject(USER_A);
    await db.query(`insert into story_jobs (project_id, user_id, kind) values ($1, $2, 'clip'), ($1, $2, 'clip')`, [project.id, USER_A]);
    const claimed = (await db.query(`select * from story_claim_jobs($1, 2)`, [project.id])).rows;
    expect(claimed).toHaveLength(2);
  });

  it('uses for update skip locked and has the claim and webhook indexes', async () => {
    const fn = await one(`select prosrc from pg_proc where proname = 'story_claim_jobs'`);
    expect(fn.prosrc).toMatch(/for update skip locked/i);
    const { rows } = await db.query(`select indexname, indexdef from pg_indexes where tablename = 'story_jobs'`);
    const defs = rows.map((r) => r.indexdef).join('\n');
    expect(defs).toMatch(/\(project_id, created_at\) WHERE \(status = 'queued'/);
    expect(defs).toMatch(/\(provider, provider_task_id\)/);
  });
});

describe('story_usage_take', () => {
  it('counts up to the limit and then refuses', async () => {
    const user = randomUUID();
    const take = async () => (await one(`select story_usage_take($1, 'project', 2) as ok`, [user])).ok;
    expect(await take()).toBe(true);
    expect(await take()).toBe(true);
    expect(await take()).toBe(false);
    const r = await one(`select count from story_usage where user_id = $1 and action = 'project'`, [user]);
    expect(r.count).toBe(2);
  });
});
