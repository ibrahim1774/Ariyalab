import { describe, expect, it, vi } from 'vitest';

// Captures the cookie adapter lib/supabaseServer.js hands to @supabase/ssr.
let adapter = null;
vi.mock('@supabase/ssr', () => ({
  createServerClient: (_url, _key, { cookies }) => {
    adapter = cookies;
    return {};
  },
}));

const { createSupabaseServer } = await import('../../lib/supabaseServer.js');

function fakeRes(initial) {
  const headers = initial === undefined ? {} : { 'set-cookie': initial };
  return {
    setHeader: (name, value) => {
      headers[name.toLowerCase()] = value;
    },
    getHeader: (name) => headers[name.toLowerCase()],
    headers,
  };
}

describe('createSupabaseServer cookies (M8)', () => {
  it('appends every Set-Cookie in order instead of overwriting', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://x.supabase.test');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon');
    const res = fakeRes('existing=1; Path=/');
    createSupabaseServer({ headers: {} }, res);
    adapter.set('sb-auth-token.0', 'aaa', {});
    adapter.set('sb-auth-token.1', 'bbb', {});
    adapter.remove('sb-old', {});
    const cookies = res.headers['set-cookie'];
    expect(Array.isArray(cookies)).toBe(true);
    expect(cookies[0]).toBe('existing=1; Path=/');
    expect(cookies[1]).toMatch(/^sb-auth-token\.0=aaa/);
    expect(cookies[2]).toMatch(/^sb-auth-token\.1=bbb/);
    expect(cookies[3]).toMatch(/^sb-old=;.*Max-Age=0/);
    vi.unstubAllEnvs();
  });

  it('works with a response that has no getHeader', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://x.supabase.test');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon');
    const headers = {};
    createSupabaseServer({ headers: {} }, { setHeader: (n, v) => { headers[n] = v; } });
    adapter.set('a', '1', {});
    expect(headers['Set-Cookie']).toEqual([expect.stringMatching(/^a=1/)]);
    vi.unstubAllEnvs();
  });
});
