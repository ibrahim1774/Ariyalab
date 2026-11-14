import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

let mockUser = null;
let tabsEnabled = false;
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: { getUser: async () => ({ data: { user: mockUser } }) },
    from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: { feature_tabs_enabled: tabsEnabled } }) }) }) }),
  }),
}));

const { middleware } = await import('../../middleware.js');
const run = (path) => middleware(new NextRequest(`https://app.test${path}`));

beforeEach(() => {
  mockUser = null;
  tabsEnabled = false;
});

describe('middleware', () => {
  it('sends a signed-out visitor from /app/x?y=1 to sign-in with the return path kept', async () => {
    const res = await run('/app/x?y=1');
    expect(res.status).toBe(307);
    const loc = new URL(res.headers.get('location'));
    expect(loc.pathname).toBe('/sign-in');
    expect(loc.searchParams.get('returnTo')).toBe('/app/x?y=1');
  });

  it('leaves /api/story/pricing public', async () => {
    const res = await run('/api/story/pricing');
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });

  it('leaves the provider webhook and the story cron outside the matcher (they check their own secrets)', async () => {
    const { config } = await import('../../middleware.js');
    const { pathToRegexp } = await import('next/dist/compiled/path-to-regexp');
    for (const path of ['/api/webhooks/kie', '/api/cron/story-tick']) {
      expect(config.matcher.some((m) => pathToRegexp(m).test(path)), path).toBe(false);
    }
  });

  it('answers 401 JSON to other /api/story paths without a session', async () => {
    const res = await run('/api/story/billing');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Authentication required.' });
  });

  it('lets a signed-in user through to /app and /api/story', async () => {
    mockUser = { id: 'u', email: 'a@example.test' };
    expect((await run('/app')).headers.get('location')).toBeNull();
    expect((await run('/api/story/billing')).status).toBe(200);
  });

  it('sends a signed-in non-admin to /app/tools from a gated tab when the flag is off', async () => {
    mockUser = { id: 'u', email: 'a@example.test' };
    const res = await run('/face-swap');
    expect(new URL(res.headers.get('location')).pathname).toBe('/app/tools');
  });

  it('sends a signed-out visitor to the homepage from a gated tab when the flag is off', async () => {
    const res = await run('/face-swap');
    expect(new URL(res.headers.get('location')).pathname).toBe('/');
  });

  it('lets non-admins through when the flag is on', async () => {
    mockUser = { id: 'u', email: 'a@example.test' };
    tabsEnabled = true;
    expect((await run('/face-swap')).headers.get('location')).toBeNull();
  });

  it('leaves the OAuth server, its discovery documents and the consent page to their own auth', async () => {
    const { config } = await import('../../middleware.js');
    const { pathToRegexp } = await import('next/dist/compiled/path-to-regexp');
    const paths = [
      '/api/oauth/token', '/api/oauth/register', '/api/oauth/authorize',
      '/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource/api/mcp',
      '/oauth/consent', '/api/mcp',
    ];
    expect(config.matcher.some((m) => pathToRegexp(m).test('/api/story/billing'))).toBe(true);
    for (const path of paths) {
      expect(config.matcher.some((m) => pathToRegexp(m).test(path)), path).toBe(false);
      const res = await run(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('location'), path).toBeNull();
    }
  });
});
