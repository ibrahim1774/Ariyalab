import { getSupabaseAdmin } from '../supabaseServer.js';

/*
 * The one database accessor for lib/story/*. Every story module reaches the
 * story_ tables through storyDb(), never through supabase-js or SQL directly.
 *
 * Production: backed by the service-role Supabase client (bypasses RLS, so
 * callers enforce ownership). Tests: setStoryDb(pgliteHandle) with any
 * { query(sql, params) } handle (tests/helpers/db.js createTestDb()).
 * tests/story/db.test.js runs the same assertions against both adapters.
 *
 * Interface (identical on both backends; every method is async):
 *
 *   select(table, match = {}, { columns, order, limit } = {})  -> rows[]
 *   insert(table, rowOrRows)                                   -> inserted rows[], in order
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
 *   limit:   positive integer, default 1000 (DEFAULT_LIMIT). A limit above
 *            1000 needs an order (the supabase path pages through PostgREST's
 *            1000-row cap with it).
 *   params:  rpc parameters by SQL name, e.g. { p_project, p_limit }.
 *
 * undefined is never a value: a match, patch or insert row holding
 * undefined throws a TypeError (use null for SQL NULL). A key missing from
 * an insert row gets the column default, also in a bulk insert whose rows
 * have different keys. A bulk insert is one statement: all rows or none.
 *
 * Values: jsonb columns take and return plain JS values (objects, arrays,
 * strings); uuid[] / text[] columns take and return JS arrays. On the way
 * out, timestamptz columns are ISO strings with milliseconds and 'Z'
 * ('2026-11-14T20:02:41.416Z') and date columns are 'YYYY-MM-DD'.
 * Tables must be in STORY_TABLES and functions in STORY_RPCS; column names
 * must be plain identifiers. Backend errors are thrown as Errors with the
 * SQL error message ('project_busy', ...) and .code/.details when known.
 * There are no multi-statement transactions: anything that must be atomic
 * across statements belongs in a SQL function called through rpc.
 */

export const STORY_TABLES = Object.freeze([
  'story_projects',
  'story_references',
  'story_scripts',
  'story_cast',
  'story_shots',
  'story_assets',
  'story_project_assets',
  'story_brand',
  'story_voices',
  'story_jobs',
  'story_renders',
  'story_chat',
  'story_usage',
  // OAuth server for the MCP connector (lib/mcp/oauth.js only).
  'story_oauth_clients',
  'story_oauth_requests',
  'story_oauth_codes',
  'story_oauth_tokens',
  'story_oauth_registrations',
]);

// Function name -> 'set' (returns rows) or 'scalar' (returns one value).
export const STORY_RPCS = Object.freeze({
  story_claim_jobs: 'set',
  story_usage_take: 'scalar',
  story_delete_project: 'scalar',
  story_oauth_take_code: 'set',
  story_oauth_issue_code_tokens: 'set',
  story_oauth_rotate_refresh: 'set',
  story_oauth_registration_take: 'scalar',
});

// Column names normalised on the way out (all story_ tables). The schema
// test checks these lists against information_schema.
export const TIMESTAMP_COLUMNS = Object.freeze([
  'created_at', 'updated_at', 'run_after', 'locked_until', 'consent_at', 'rights_confirmed_at', 'files_expire_at',
  'started_at', // story_jobs (runner)
  // story_oauth_ tables
  'metadata_fetched_at', 'expires_at', 'used_at', 'revoked_at', 'rotated_at', 'access_expires_at', 'refresh_expires_at',
]);
export const DATE_COLUMNS = Object.freeze(['day']);

export const DEFAULT_LIMIT = 1000;
const PAGE_SIZE = 1000;

const IDENT = /^[a-z_][a-z0-9_]*$/;
const TIMESTAMPS = new Set(TIMESTAMP_COLUMNS);
const DATES = new Set(DATE_COLUMNS);

function checkTable(table) {
  if (!STORY_TABLES.includes(table)) throw new Error(`storyDb: unknown table ${String(table)}`);
}
function checkColumn(name) {
  if (typeof name !== 'string' || !IDENT.test(name)) throw new Error(`storyDb: bad column ${String(name)}`);
  return name;
}
function checkDefined(obj, what) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) throw new TypeError(`storyDb: ${what}.${k} is undefined (use null for NULL)`);
  }
}
function checkMatch(match, required) {
  if (match === null || typeof match !== 'object' || Array.isArray(match)) {
    throw new TypeError('storyDb: match must be an object');
  }
  const keys = Object.keys(match);
  if (required && keys.length === 0) throw new Error('storyDb: update/remove need a non-empty match');
  keys.forEach(checkColumn);
  checkDefined(match, 'match');
  for (const [k, v] of Object.entries(match)) {
    if (Array.isArray(v) && v.some((x) => x === undefined || x === null)) {
      throw new TypeError(`storyDb: match.${k} list holds null/undefined`);
    }
  }
  return keys;
}
function checkPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new TypeError('storyDb: patch must be an object');
  const cols = Object.keys(patch).map(checkColumn);
  if (cols.length === 0) throw new Error('storyDb: empty patch');
  checkDefined(patch, 'patch');
  return cols;
}
function parseOrder(order) {
  if (order === undefined || order === null) return [];
  const list = Array.isArray(order) ? order : [order];
  return list.map((item) => {
    const desc = typeof item === 'string' && item.startsWith('-');
    return { column: checkColumn(desc ? item.slice(1) : item), ascending: !desc };
  });
}
function checkLimit(limit, orderBy) {
  if (limit === undefined || limit === null) return DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) throw new Error('storyDb: limit must be a positive integer');
  if (limit > PAGE_SIZE && orderBy.length === 0) throw new Error('storyDb: a limit above 1000 needs an order');
  return limit;
}
function rowsOf(rowOrRows) {
  const rows = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows];
  if (rows.length === 0) throw new Error('storyDb: nothing to insert');
  for (const r of rows) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw new TypeError('storyDb: rows must be objects');
    Object.keys(r).forEach(checkColumn);
    checkDefined(r, 'row');
  }
  return rows;
}
function checkRpc(fn, params) {
  if (!Object.hasOwn(STORY_RPCS, fn)) throw new Error(`storyDb: unknown function ${String(fn)}`);
  Object.keys(params || {}).forEach(checkColumn);
}
const matchesNothing = (match) => Object.values(match).some((v) => Array.isArray(v) && v.length === 0);

function normalizeValue(column, value) {
  if (value === null || value === undefined) return value ?? null;
  if (TIMESTAMPS.has(column)) return new Date(value).toISOString();
  if (DATES.has(column)) return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
  if (value instanceof Date) return value.toISOString();
  return value;
}
function normalizeRow(row) {
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, normalizeValue(k, v)]));
}
const normalizeRows = (rows) => (rows || []).map(normalizeRow);

// ---------------------------------------------------------------- PGlite

/** Adapter over a PGlite-style { query(sql, params) } handle. */
export function createPgAdapter(handle) {
  const typeCache = new Map(); // table -> Map(column -> data_type)

  async function columnTypes(table) {
    if (!typeCache.has(table)) {
      const { rows } = await handle.query(
        `select column_name, data_type from information_schema.columns
          where table_schema = 'public' and table_name = $1 order by ordinal_position`,
        [table]
      );
      typeCache.set(table, new Map(rows.map((r) => [r.column_name, r.data_type])));
    }
    return typeCache.get(table);
  }

  async function toParam(table, column, value) {
    const types = await columnTypes(table);
    if (!types.has(column)) throw new Error(`storyDb: unknown column ${table}.${column}`);
    if (value === null) return null;
    const type = types.get(column);
    if (type === 'jsonb' || type === 'json') return JSON.stringify(value);
    return value;
  }

  async function where(table, match, params) {
    const parts = [];
    for (const [col, value] of Object.entries(match)) {
      if (value === null) {
        parts.push(`${col} is null`);
      } else if (Array.isArray(value)) {
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
      const lim = checkLimit(limit, orderBy);
      if (matchesNothing(match)) return [];
      const params = [];
      let sql = `select ${cols} from public.${table}${await where(table, match, params)}`;
      if (orderBy.length) sql += ` order by ${orderBy.map((o) => `${o.column} ${o.ascending ? 'asc' : 'desc'}`).join(', ')}`;
      sql += ` limit ${lim}`;
      const { rows } = await handle.query(sql, params);
      return normalizeRows(rows);
    },

    async insert(table, rowOrRows) {
      checkTable(table);
      const rows = rowsOf(rowOrRows);
      const types = await columnTypes(table);
      let cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
      if (cols.length === 0) cols = [types.keys().next().value];
      const params = [];
      const tuples = [];
      for (const row of rows) {
        const cells = [];
        for (const c of cols) {
          if (!Object.hasOwn(row, c)) {
            if (!types.has(c)) throw new Error(`storyDb: unknown column ${table}.${c}`);
            cells.push('default');
          } else {
            params.push(await toParam(table, c, row[c]));
            cells.push(`$${params.length}`);
          }
        }
        tuples.push(`(${cells.join(', ')})`);
      }
      const sql = `insert into public.${table} (${cols.join(', ')}) values ${tuples.join(', ')} returning *`;
      const { rows: inserted } = await handle.query(sql, params);
      return normalizeRows(inserted);
    },

    async update(table, match, patch) {
      checkTable(table);
      checkMatch(match, true);
      const cols = checkPatch(patch);
      if (matchesNothing(match)) return [];
      const params = [];
      const sets = [];
      for (const c of cols) {
        params.push(await toParam(table, c, patch[c]));
        sets.push(`${c} = $${params.length}`);
      }
      const sql = `update public.${table} set ${sets.join(', ')}${await where(table, match, params)} returning *`;
      const { rows } = await handle.query(sql, params);
      return normalizeRows(rows);
    },

    async remove(table, match) {
      checkTable(table);
      checkMatch(match, true);
      if (matchesNothing(match)) return [];
      const params = [];
      const sql = `delete from public.${table}${await where(table, match, params)} returning *`;
      const { rows } = await handle.query(sql, params);
      return normalizeRows(rows);
    },

    async rpc(fn, params = {}) {
      checkRpc(fn, params);
      const entries = Object.entries(params).filter(([, v]) => v !== undefined);
      const args = entries.map(([k], i) => `${k} => $${i + 1}`).join(', ');
      const values = entries.map(([, v]) => v);
      if (STORY_RPCS[fn] === 'set') {
        const { rows } = await handle.query(`select * from public.${fn}(${args})`, values);
        return normalizeRows(rows);
      }
      const { rows } = await handle.query(`select public.${fn}(${args}) as result`, values);
      return normalizeValue('result', rows[0]?.result ?? null);
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
    if (value === null) q = q.is(col, null);
    else if (Array.isArray(value)) q = q.in(col, value);
    else q = q.eq(col, value);
  }
  return q;
}

/** Adapter over a supabase-js client (the service-role client in production). */
export function createSupabaseAdapter(client) {
  return {
    async select(table, match = {}, { columns, order, limit } = {}) {
      checkTable(table);
      checkMatch(match, false);
      const cols = columns?.length ? columns.map(checkColumn).join(',') : '*';
      const orderBy = parseOrder(order);
      const lim = checkLimit(limit, orderBy);
      if (matchesNothing(match)) return [];
      const out = [];
      // PostgREST returns at most 1000 rows per request: page with range().
      for (let from = 0; from < lim; from += PAGE_SIZE) {
        const to = Math.min(lim, from + PAGE_SIZE) - 1;
        let q = applyMatch(client.from(table).select(cols), match);
        for (const o of orderBy) q = q.order(o.column, { ascending: o.ascending });
        const { data, error } = await q.range(from, to);
        raise(error);
        out.push(...(data || []));
        if (!data || data.length < to - from + 1) break;
      }
      return normalizeRows(out);
    },

    async insert(table, rowOrRows) {
      checkTable(table);
      const rows = rowsOf(rowOrRows);
      // defaultToNull: false -> a key missing from a row gets the column default.
      const { data, error } = await client.from(table).insert(rows, { defaultToNull: false }).select();
      raise(error);
      return normalizeRows(data);
    },

    async update(table, match, patch) {
      checkTable(table);
      checkMatch(match, true);
      checkPatch(patch);
      if (matchesNothing(match)) return [];
      const { data, error } = await applyMatch(client.from(table).update(patch), match).select();
      raise(error);
      return normalizeRows(data);
    },

    async remove(table, match) {
      checkTable(table);
      checkMatch(match, true);
      if (matchesNothing(match)) return [];
      const { data, error } = await applyMatch(client.from(table).delete(), match).select();
      raise(error);
      return normalizeRows(data);
    },

    async rpc(fn, params = {}) {
      checkRpc(fn, params);
      const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined));
      const { data, error } = await client.rpc(fn, clean);
      raise(error);
      if (STORY_RPCS[fn] === 'set') return normalizeRows(data);
      return normalizeValue('result', data ?? null);
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
