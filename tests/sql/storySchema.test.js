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
        where table_schema = 'public' and table_type = 'BASE TABLE' and table_name like 'story\\_%'
          and table_name not like 'story\\_oauth\\_%'
        order by table_name`
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      'story_assets', 'story_brand', 'story_cast', 'story_chat', 'story_jobs', 'story_project_assets',
      'story_projects', 'story_references', 'story_renders', 'story_scripts', 'story_shots', 'story_usage', 'story_voices',
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

  it('keeps mode and quality consistent', async () => {
    await expect(
      db.query(`insert into story_projects (user_id, quality, mode) values ($1, 'pro_talking', 'narrated')`, [USER_A])
    ).rejects.toThrow(/story_projects_mode_quality/);
    await expect(
      db.query(`insert into story_projects (user_id, quality, mode) values ($1, 'standard', 'talking')`, [USER_A])
    ).rejects.toThrow(/story_projects_mode_quality/);
    const ok = await one(`insert into story_projects (user_id, quality, mode) values ($1, 'pro_talking', 'talking') returning mode`, [USER_A]);
    expect(ok.mode).toBe('talking');
  });

  it('consistent_cast is a boolean that is never null and defaults to true', async () => {
    const row = await one(`insert into story_projects (user_id) values ($1) returning consistent_cast`, [USER_A]);
    expect(row.consistent_cast).toBe(true);
    await expect(db.query(`insert into story_projects (user_id, consistent_cast) values ($1, null)`, [USER_A])).rejects.toThrow(/null/);
    const off = await one(`insert into story_projects (user_id, consistent_cast) values ($1, false) returning consistent_cast`, [USER_A]);
    expect(off.consistent_cast).toBe(false);
  });

  it('accepts 7 and 120 seconds', async () => {
    for (const seconds of [7, 120]) {
      const row = await one(`insert into story_projects (user_id, seconds) values ($1, $2) returning seconds`, [USER_A, seconds]);
      expect(row.seconds).toBe(seconds);
    }
  });

  it('rejects seconds outside 7 to 120', async () => {
    await expect(db.query(`insert into story_projects (user_id, seconds) values ($1, 6)`, [USER_A])).rejects.toThrow(/check/);
    await expect(db.query(`insert into story_projects (user_id, seconds) values ($1, 121)`, [USER_A])).rejects.toThrow(/check/);
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

  it('deleting a project removes only its asset links, not the assets', async () => {
    const { project } = await seedProject(USER_A);
    const asset = await one(
      `insert into story_assets (user_id, kind, url, in_brand_kit) values ($1, 'logo', 'https://example.test/l.png', true) returning *`,
      [USER_A]
    );
    await db.query(`insert into story_project_assets (project_id, asset_id, role) values ($1, $2, 'logo')`, [project.id, asset.id]);
    await expect(
      db.query(`insert into story_project_assets (project_id, asset_id, role) values ($1, $2, 'banner')`, [project.id, asset.id])
    ).rejects.toThrow(/check/);
    await db.query(`delete from story_projects where id = $1`, [project.id]);
    expect((await one(`select count(*)::int as n from story_project_assets where asset_id = $1`, [asset.id])).n).toBe(0);
    expect((await one(`select count(*)::int as n from story_assets where id = $1`, [asset.id])).n).toBe(1);
  });

  it('has the columns later tasks rely on', async () => {
    const { rows } = await db.query(
      `select table_name || '.' || column_name || ':' || data_type as c from information_schema.columns
        where table_schema = 'public' and table_name like 'story\\_%'`
    );
    const cols = rows.map((r) => r.c);
    for (const c of [
      'story_renders.warnings:jsonb',
      'story_references.rights_confirmed_at:timestamp with time zone',
      'story_references.rights_statement:text',
      'story_shots.cast_ids:ARRAY',
      'story_shots.ref_asset_ids:ARRAY',
      'story_shots.footage:jsonb',
      'story_shots.inset:jsonb',
      'story_assets.in_brand_kit:boolean',
      'story_projects.files_expire_at:timestamp with time zone',
      'story_projects.narration_key:text',
      'story_projects.music_key:text',
      'story_projects.thumbnail_key:text',
      'story_shots.still_key:text',
      'story_shots.clip_key:text',
      'story_cast.image_key:text',
      'story_renders.storage_key:text',
      'story_references.storage_key:text',
      'story_assets.storage_key:text',
    ]) expect(cols, c).toContain(c);
    expect(cols.some((c) => c.startsWith('story_assets.project_id:'))).toBe(false);
  });

  it('allows status expired and indexes the retention query', async () => {
    const p = await one(
      `insert into story_projects (user_id, status, files_expire_at) values ($1, 'expired', now() - interval '1 day') returning status`,
      [USER_A]
    );
    expect(p.status).toBe('expired');
    const idx = await one(`select indexdef from pg_indexes where indexname = 'story_projects_files_expire_idx'`);
    expect(idx.indexdef).toMatch(/\(files_expire_at\) WHERE \(\(files_expire_at IS NOT NULL\) AND \(status <> 'expired'/);
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

  it('clients cannot insert, update or delete any story table', async () => {
    const { project, shot, job } = await seedProject(USER_A);
    const asset = await one(`insert into story_assets (user_id, kind, url) values ($1, 'logo', 'u') returning id`, [USER_A]);
    await db.query(`insert into story_scripts (project_id, version) values ($1, 1)`, [project.id]);
    await db.query(`insert into story_brand (user_id) values ($1) on conflict do nothing`, [USER_A]);
    const inserts = {
      story_projects: [`insert into story_projects (user_id, title) values ($1, 'Mine')`, [USER_A]],
      story_scripts: [`insert into story_scripts (project_id, version) values ($1, 7)`, [project.id]],
      story_assets: [`insert into story_assets (user_id, kind, url) values ($1, 'logo', 'u')`, [USER_A]],
      story_shots: [`insert into story_shots (project_id, ord) values ($1, 5)`, [project.id]],
      story_jobs: [`insert into story_jobs (project_id, user_id, kind) values ($1, $2, 'clip')`, [project.id, USER_A]],
      story_references: [`insert into story_references (project_id, source_type) values ($1, 'link')`, [project.id]],
      story_cast: [`insert into story_cast (project_id, name) values ($1, 'X')`, [project.id]],
      story_brand: [`insert into story_brand (user_id) values ($1)`, [randomUUID()]],
      story_voices: [`insert into story_voices (user_id, name, provider, consent_at, consent_statement) values ($1, 'v', 'p', now(), 's')`, [USER_A]],
      story_renders: [`insert into story_renders (project_id, version) values ($1, 1)`, [project.id]],
      story_chat: [`insert into story_chat (project_id, role, content) values ($1, 'user', '"x"')`, [project.id]],
      story_usage: [`insert into story_usage (user_id, action) values ($1, 'x')`, [USER_A]],
      story_project_assets: [`insert into story_project_assets (project_id, asset_id, role) values ($1, $2, 'logo')`, [project.id, asset.id]],
    };
    const owned = {
      story_projects: ['id = $1', project.id],
      story_scripts: ['project_id = $1', project.id],
      story_assets: ['id = $1', asset.id],
      story_shots: ['id = $1', shot.id],
      story_jobs: ['id = $1', job.id],
      story_references: ['project_id = $1', project.id],
      story_cast: ['project_id = $1', project.id],
      story_brand: ['user_id = $1', USER_A],
      story_voices: ['user_id = $1', USER_A],
      story_renders: ['project_id = $1', project.id],
      story_chat: ['project_id = $1', project.id],
      story_usage: ['user_id = $1', USER_A],
      story_project_assets: ['project_id = $1', project.id],
    };
    for (const [table, [sql, params]] of Object.entries(inserts)) {
      await expect(asUser(USER_A, sql, params), `${table} insert`).rejects.toThrow(/permission denied/);
      const [cond, value] = owned[table];
      await expect(
        asUser(USER_A, `update ${table} set ${table === 'story_usage' ? 'count = 0' : 'created_at = now()'} where ${cond}`, [value]),
        `${table} update`
      ).rejects.toThrow(/permission denied/);
      await expect(asUser(USER_A, `delete from ${table} where ${cond}`, [value]), `${table} delete`).rejects.toThrow(
        /permission denied/
      );
    }
  });

  it('clients read only the public job columns', async () => {
    const { project, job } = await seedProject(USER_A);
    await db.query(
      `update story_jobs set payload = '{"prompt":"secret"}', provider_task_id = 't1', hold_id = $2, cost_credits = 9 where id = $1`,
      [job.id, randomUUID()]
    );
    for (const col of ['payload', 'provider_task_id', 'hold_id', 'cost_credits', 'provider', '*']) {
      await expect(asUser(USER_A, `select ${col} from story_jobs where id = $1`, [job.id]), col).rejects.toThrow(
        /permission denied/
      );
    }
    const pub = await asUser(USER_A, `select * from story_jobs_public where project_id = $1`, [project.id]);
    expect(pub.rows).toHaveLength(1);
    expect(Object.keys(pub.rows[0]).sort()).toEqual(
      ['created_at', 'error', 'id', 'kind', 'project_id', 'shot_id', 'status', 'updated_at']
    );
    const other = await asUser(USER_B, `select * from story_jobs_public where project_id = $1`, [project.id]);
    expect(other.rows).toHaveLength(0);
  });

  it('anon sees nothing', async () => {
    await seedProject(USER_A);
    await expect(asRole('anon', `select * from story_projects`)).rejects.toThrow(/permission denied/);
  });

  it('only service_role may execute the story functions', async () => {
    await expect(
      asUser(USER_A, `select * from story_claim_jobs($1, 5)`, [randomUUID()])
    ).rejects.toThrow(/permission denied/);
    await expect(
      asUser(USER_A, `select story_delete_project($1, $2)`, [USER_A, randomUUID()])
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

describe('story_delete_project', () => {
  it('deletes only the owner’s idle project and refuses in-flight work', async () => {
    const { project, job } = await seedProject(USER_A);
    expect((await one(`select story_delete_project($1, $2) as ok`, [USER_B, project.id])).ok).toBe(false);
    await expect(db.query(`select story_delete_project($1, $2)`, [USER_A, project.id])).rejects.toThrow('project_busy');
    await db.query(`update story_jobs set status = 'running' where id = $1`, [job.id]);
    await expect(db.query(`select story_delete_project($1, $2)`, [USER_A, project.id])).rejects.toThrow('project_busy');
    await db.query(`update story_jobs set status = 'failed' where id = $1`, [job.id]);
    expect((await one(`select story_delete_project($1, $2) as ok`, [USER_A, project.id])).ok).toBe(true);
    expect((await one(`select count(*)::int as n from story_projects where id = $1`, [project.id])).n).toBe(0);
    expect((await one(`select story_delete_project($1, $2) as ok`, [USER_A, project.id])).ok).toBe(false);
  });
});
