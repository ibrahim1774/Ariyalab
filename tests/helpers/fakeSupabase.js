// A stand-in for the supabase-js client, backed by a PGlite handle, that
// follows PostgREST's semantics for the calls lib/story/db.js makes:
//   - insert(rows, { defaultToNull = true }): columns are the union of the
//     rows' keys; a missing key is NULL unless defaultToNull is false, then
//     the column default. One statement.
//   - filters eq / is / in (an empty `in` list is a request error), order,
//     limit, range; a select returns at most MAX_ROWS rows (max-rows).
//   - .select() after insert/update/delete returns the affected rows.
//   - results are JSON as PostgREST sends it: timestamptz as
//     '2026-11-14T20:02:41.416123+00:00', date as 'YYYY-MM-DD'.
//   - errors resolve as { data: null, error: { message, code, details } }.
//   - rpc(fn, params): named arguments; set-returning functions give rows.
export const MAX_ROWS = 1000;

export function createFakeSupabase(handle) {
  const types = new Map();
  async function columnTypes(table) {
    if (!types.has(table)) {
      const { rows } = await handle.query(
        `select column_name, data_type from information_schema.columns where table_schema = 'public' and table_name = $1`,
        [table]
      );
      types.set(table, new Map(rows.map((r) => [r.column_name, r.data_type])));
    }
    return types.get(table);
  }

  const toJson = (type, v) => {
    if (v === null || v === undefined) return null;
    if (v instanceof Date) {
      if (type === 'date') return v.toISOString().slice(0, 10);
      return v.toISOString().replace('Z', '000+00:00');
    }
    return v;
  };
  const toJsonRows = (map, rows) =>
    rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, toJson(map.get(k), v)])));
  const toParam = (type, v) => (v === null ? null : type === 'jsonb' || type === 'json' ? JSON.stringify(v) : v);

  function builder(table) {
    const st = { op: null, cols: '*', filters: [], orders: [], limit: null, range: null, returning: false };
    const b = {
      select(cols = '*') {
        if (st.op) st.returning = true;
        else {
          st.op = 'select';
          st.cols = cols;
        }
        return b;
      },
      insert(rows, { defaultToNull = true } = {}) {
        Object.assign(st, { op: 'insert', rows: Array.isArray(rows) ? rows : [rows], defaultToNull });
        return b;
      },
      update(patch) {
        Object.assign(st, { op: 'update', patch });
        return b;
      },
      delete() {
        st.op = 'delete';
        return b;
      },
      eq: (c, v) => (st.filters.push(['eq', c, v]), b),
      is: (c, v) => (st.filters.push(['is', c, v]), b),
      in: (c, v) => (st.filters.push(['in', c, v]), b),
      order: (c, { ascending = true } = {}) => (st.orders.push([c, ascending]), b),
      limit: (n) => ((st.limit = n), b),
      range: (from, to) => ((st.range = [from, to]), b),
      then(resolve, reject) {
        return run(table, st).then(resolve, reject);
      },
    };
    return b;
  }

  async function run(table, st) {
    try {
      const map = await columnTypes(table);
      const params = [];
      const p = (col, v) => {
        params.push(toParam(map.get(col), v));
        return `$${params.length}`;
      };
      const where = () => {
        const parts = st.filters.map(([op, c, v]) => {
          if (op === 'is') return `${c} is null`;
          if (op === 'in') {
            if (v.length === 0) throw Object.assign(new Error('failed to parse filter (in.())'), { code: 'PGRST100' });
            return `${c} in (${v.map((x) => p(c, x)).join(', ')})`;
          }
          return `${c} = ${p(c, v)}`;
        });
        return parts.length ? ` where ${parts.join(' and ')}` : '';
      };
      let sql;
      if (st.op === 'select') {
        sql = `select ${st.cols === '*' ? '*' : st.cols.split(',').join(', ')} from public.${table}${where()}`;
        if (st.orders.length) sql += ` order by ${st.orders.map(([c, a]) => `${c} ${a ? 'asc' : 'desc'}`).join(', ')}`;
        let offset = 0;
        let count = st.limit ?? MAX_ROWS;
        if (st.range) {
          offset = st.range[0];
          count = st.range[1] - st.range[0] + 1;
        }
        sql += ` limit ${Math.min(count, MAX_ROWS)} offset ${offset}`;
      } else if (st.op === 'insert') {
        const cols = [...new Set(st.rows.flatMap((r) => Object.keys(r)))];
        const tuples = st.rows.map(
          (r) =>
            `(${cols
              .map((c) => (Object.hasOwn(r, c) ? p(c, r[c] ?? null) : st.defaultToNull ? 'null' : 'default'))
              .join(', ')})`
        );
        sql = `insert into public.${table} (${cols.join(', ')}) values ${tuples.join(', ')}`;
      } else if (st.op === 'update') {
        // supabase-js serialises the patch as JSON: undefined keys are dropped.
        const sets = Object.entries(st.patch)
          .filter(([, v]) => v !== undefined)
          .map(([c, v]) => `${c} = ${p(c, v)}`);
        sql = `update public.${table} set ${sets.join(', ')}${where()}`;
      } else if (st.op === 'delete') {
        sql = `delete from public.${table}${where()}`;
      }
      if (st.op !== 'select' && st.returning) sql += ' returning *';
      const { rows } = await handle.query(sql, params);
      return { data: st.op === 'select' || st.returning ? toJsonRows(map, rows) : null, error: null };
    } catch (err) {
      return { data: null, error: { message: err.message, code: err.code, details: err.detail ?? null } };
    }
  }

  return {
    from: (table) => builder(table),
    async rpc(fn, params = {}) {
      try {
        const { rows: meta } = await handle.query(
          `select proretset, prorettype::regtype::text as ret from pg_proc where proname = $1`,
          [fn]
        );
        const entries = Object.entries(params);
        const args = entries.map(([k], i) => `${k} => $${i + 1}`).join(', ');
        const values = entries.map(([, v]) => v);
        if (meta[0]?.proretset) {
          const { rows } = await handle.query(`select * from public.${fn}(${args})`, values);
          const ret = meta[0].ret;
          return { data: toJsonRows(await columnTypes(ret.replace(/^public\./, '')), rows), error: null };
        }
        const { rows } = await handle.query(`select public.${fn}(${args}) as result`, values);
        return { data: toJson(meta[0]?.ret, rows[0].result), error: null };
      } catch (err) {
        return { data: null, error: { message: err.message, code: err.code, details: err.detail ?? null } };
      }
    },
  };
}
