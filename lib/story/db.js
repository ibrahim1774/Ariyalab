import { getSupabaseAdmin } from '../supabaseServer.js';

/*
 * The one database accessor for lib/story/*. Every story module reaches the
 * story_ tables through storyDb(), never through supabase-js or SQL directly.
 *
 * Production: backed by the service-role Supabase client (bypasses RLS, so
 * callers enforce ownership). Tests: setStoryDb(pgliteHandle) with any
 * { query(sql, params) } handle (tests/helpers/db.js createTestDb()).
 *
 * Interface (identical on both backends; every method is async):
 *
 *   select(table, match = {}, { columns, order, limit } = {})  -> rows[]
 *   insert(table, rowOrRows)                                   -> inserted rows[]
 *   update(table, match, patch)                                -> updated rows[]
 *   remove(table, match)                                       -> deleted rows[]
 *   rpc(fn, params)                                            -> rows[] for set-returning
 *                                                                 functions, else the value
 *
 *   match:   { column: value }, ANDed. value null -> IS NULL, array -> IN
 *            (an empty array matches nothing), anything else -> =.
 *            update and remove refuse an empty match.
 *   columns: array of column names (default all).
 *   order:   'col' or ['col', '-other']; a leading '-' sorts descending.
 *   limit:   positive integer.
 *   params:  rpc parameters by SQL name, e.g. { p_project, p_limit }.
 *
 * Values: jsonb columns take and return plain JS values (objects, arrays,
 * strings); text[] columns take and return JS arrays; timestamps come back
 * as ISO strings. Tables must be in STORY_TABLES and functions in
 * STORY_RPCS; column names must be plain identifiers. Errors are thrown as
 * they come from the backend (PGlite error, or the PostgREST error object
 * wrapped in an Error with .code/.details).
 */

export const STORY_TABLES = Object.freeze([
  'story_projects',
  'story_references',
  'story_scripts',
  'story_cast',
  'story_shots',
  'story_assets',
  'story_brand',
  'story_voices',
  'story_jobs',
  'story_renders',
  'story_chat',
  'story_usage',
]);

// Function name -> 'set' (returns rows) or 'scalar' (returns one value).
export const STORY_RPCS = Object.freeze({
  story_claim_jobs: 'set',
  story_usage_take: 'scalar',
});

const IDENT = /^[a-z_][a-z0-9_]*$/;

function checkTable(table) {
  if (!STORY_TABLES.includes(table)) throw new Error(`storyDb: unknown table ${String(table)}`);
}
function checkColumn(name) {
  if (typeof name !== 'string' || !IDENT.test(name)) throw new Error(`storyDb: bad column ${String(name)}`);
  return name;
}
function checkMatch(match, required) {
  if (match === null || typeof match !== 'object' || Array.isArray(match)) {
    throw new Error('storyDb: match must be an object');
  }
  const keys = Object.keys(match);
  if (required && keys.length === 0) throw new Error('storyDb: update/remove need a non-empty match');
  keys.forEach(checkColumn);
  return keys;
}
function parseOrder(order) {
  if (order === undefined || order === null) return [];
  const list = Array.isArray(order) ? order : [order];
  return list.map((item) => {
    const desc = typeof item === 'string' && item.startsWith('-');
    return { column: checkColumn(desc ? item.slice(1) : item), ascending: !desc };
  });
}
function checkLimit(limit) {
  if (limit === undefined || limit === null) return null;
  if (!Number.isInteger(limit) || limit < 1) throw new Error('storyDb: limit must be a positive integer');
  return limit;
}
function rowsOf(rowOrRows) {
  const rows = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows];
  if (rows.length === 0) throw new Error('storyDb: nothing to insert');
  for (const r of rows) {
    if (!r || typeof r !== 'object') throw new Error('storyDb: rows must be objects');
    Object.keys(r).forEach(checkColumn);
  }
  return rows;
}
function checkRpc(fn, params) {
  if (!Object.hasOwn(STORY_RPCS, fn)) throw new Error(`storyDb: unknown function ${String(fn)}`);
  Object.keys(params || {}).forEach(checkColumn);
}

// ---------------------------------------------------------------- PGlite

/** Adapter over a PGlite-style { query(sql, params) } handle. */
export function createPgAdapter(handle) {
  const typeCache = new Map(); // table -> Map(column -> data_type)

  async function columnTypes(table) {
    if (!typeCache.has(table)) {
      const { rows } = await handle.query(
        `select column_name, data_type from information_schema.columns
          where table_schema = 'public' and table_name = $1`,
        [table]
      );
      typeCache.set(table, new Map(rows.map((r) => [r.column_name, r.data_type])));
    }
    return typeCache.get(table);
  }

  async function toParam(table, column, value) {
    const types = await columnTypes(table);
    if (!types.has(column)) throw new Error(`storyDb: unknown column ${table}.${column}`);
    if (value === undefined || value === null) return null;
    const type = types.get(column);
    if (type === 'jsonb' || type === 'json') return JSON.stringify(value);
    return value;
  }

  const normalizeValue = (v) => (v instanceof Date ? v.toISOString() : v);
  const normalize = (rows) =>
    rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, normalizeValue(v)])));

  async function where(table, match, params) {
    const parts = [];
    for (const [col, value] of Object.entries(match)) {
      if (value === null || value === undefined) {
        parts.push(`${col} is null`);
      } else if (Array.isArray(value)) {
        if (value.length === 0) {
          parts.push('false');
          continue;
        }
        const marks = [];
        for (const v of value) {
          params.push(await toParam(table, col, v));
          marks.push(`$${params.length}`);
        }
        parts.push(`${col} in (${marks.join(', ')})`);
      } else {
        params.push(await toParam(table, col, value));
        parts.push(`${col} = $${params.length}`);
      }
    }
    return parts.length ? ` where ${parts.join(' and ')}` : '';
  }

  return {
    async select(table, match = {}, { columns, order, limit } = {}) {
      checkTable(table);
      checkMatch(match, false);
      const cols = columns?.length ? columns.map(checkColumn).join(', ') : '*';
      const orderBy = parseOrder(order);
      const lim = checkLimit(limit);
      const params = [];
      let sql = `select ${cols} from public.${table}${await where(table, match, params)}`;
      if (orderBy.length) sql += ` order by ${orderBy.map((o) => `${o.column} ${o.ascending ? 'asc' : 'desc'}`).join(', ')}`;
      if (lim) sql += ` limit ${lim}`;
      const { rows } = await handle.query(sql, params);
      return normalize(rows);
    },

    async insert(table, rowOrRows) {
      checkTable(table);
      const rows = rowsOf(rowOrRows);
      const out = [];
      for (const row of rows) {
        const cols = Object.keys(row);
        const params = [];
        for (const c of cols) params.push(await toParam(table, c, row[c]));
        const sql = cols.length
          ? `insert into public.${table} (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')}) returning *`
          : `insert into public.${table} default values returning *`;
        const { rows: inserted } = await handle.query(sql, params);
        out.push(...inserted);
      }
      return normalize(out);
    },

    async update(table, match, patch) {
      checkTable(table);
      checkMatch(match, true);
      const cols = Object.keys(patch || {}).map(checkColumn);
      if (cols.length === 0) throw new Error('storyDb: empty patch');
      const params = [];
      const sets = [];
      for (const c of cols) {
        params.push(await toParam(table, c, patch[c]));
        sets.push(`${c} = $${params.length}`);
      }
      const sql = `update public.${table} set ${sets.join(', ')}${await where(table, match, params)} returning *`;
      const { rows } = await handle.query(sql, params);
      return normalize(rows);
    },

    async remove(table, match) {
      checkTable(table);
      checkMatch(match, true);
      const params = [];
      const sql = `delete from public.${table}${await where(table, match, params)} returning *`;
      const { rows } = await handle.query(sql, params);
      return normalize(rows);
    },

    async rpc(fn, params = {}) {
      checkRpc(fn, params);
      const entries = Object.entries(params).filter(([, v]) => v !== undefined);
      const args = entries.map(([k], i) => `${k} => $${i + 1}`).join(', ');
      const values = entries.map(([, v]) => v);
      if (STORY_RPCS[fn] === 'set') {
        const { rows } = await handle.query(`select * from public.${fn}(${args})`, values);
        return normalize(rows);
      }
      const { rows } = await handle.query(`select public.${fn}(${args}) as result`, values);
      return normalizeValue(rows[0]?.result ?? null);
    },
  };
}

// ---------------------------------------------------------------- supabase-js

function raise(error) {
  if (!error) return;
  throw Object.assign(new Error(error.message || 'database error'), {
    code: error.code,
    details: error.details,
    hint: error.hint,
  });
}

function applyMatch(query, match) {
  let q = query;
  for (const [col, value] of Object.entries(match)) {
    if (value === null || value === undefined) q = q.is(col, null);
    else if (Array.isArray(value)) q = q.in(col, value);
    else q = q.eq(col, value);
  }
  return q;
}

// PostgREST rejects `in.()`, so a match with an empty list short-circuits.
const matchesNothing = (match) => Object.values(match).some((v) => Array.isArray(v) && v.length === 0);

/** Adapter over a supabase-js client (the service-role client in production). */
export function createSupabaseAdapter(client) {
  return {
    async select(table, match = {}, { columns, order, limit } = {}) {
      checkTable(table);
      checkMatch(match, false);
      const cols = columns?.length ? columns.map(checkColumn).join(',') : '*';
      const orderBy = parseOrder(order);
      const lim = checkLimit(limit);
      if (matchesNothing(match)) return [];
      let q = applyMatch(client.from(table).select(cols), match);
      for (const o of orderBy) q = q.order(o.column, { ascending: o.ascending });
      if (lim) q = q.limit(lim);
      const { data, error } = await q;
      raise(error);
      return data || [];
    },

    async insert(table, rowOrRows) {
      checkTable(table);
      const rows = rowsOf(rowOrRows);
      const { data, error } = await client.from(table).insert(rows).select();
      raise(error);
      return data || [];
    },

    async update(table, match, patch) {
      checkTable(table);
      checkMatch(match, true);
      const cols = Object.keys(patch || {}).map(checkColumn);
      if (cols.length === 0) throw new Error('storyDb: empty patch');
      if (matchesNothing(match)) return [];
      const { data, error } = await applyMatch(client.from(table).update(patch), match).select();
      raise(error);
      return data || [];
    },

    async remove(table, match) {
      checkTable(table);
      checkMatch(match, true);
      if (matchesNothing(match)) return [];
      const { data, error } = await applyMatch(client.from(table).delete(), match).select();
      raise(error);
      return data || [];
    },

    async rpc(fn, params = {}) {
      checkRpc(fn, params);
      const { data, error } = await client.rpc(fn, params);
      raise(error);
      if (STORY_RPCS[fn] === 'set') return data || [];
      return data ?? null;
    },
  };
}

// ---------------------------------------------------------------- selection

let injected = null;

/** Tests pass a PGlite-style { query } handle (or a ready adapter); null restores production. */
export function setStoryDb(db) {
  if (!db) injected = null;
  else if (typeof db.select === 'function' && typeof db.rpc === 'function') injected = db;
  else injected = createPgAdapter(db);
}

let production = null;

/** The accessor every lib/story module uses. */
export function storyDb() {
  if (injected) return injected;
  if (!production) production = createSupabaseAdapter(getSupabaseAdmin());
  return production;
}
