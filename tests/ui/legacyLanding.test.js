// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const router = vi.hoisted(() => ({ pathname: '/app', asPath: '/app', replace: null, push: null, events: null }));
const supa = vi.hoisted(() => ({ user: { id: 'u1' } }));
vi.mock('next/router', () => ({ useRouter: () => router }));
vi.mock('../../lib/supabase', () => ({
  getBrowserSupabase: () => ({
    auth: {
      getUser: () => Promise.resolve({ data: { user: supa.user } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signOut: async () => ({}),
    },
  }),
}));

const AppHome = (await import('../../pages/app/index.js')).default;
const AppShell = (await import('../../components/app/AppShell.js')).default;
const LegacyHome = (await import('../../pages/legacy-home.js')).default;
const { _resetInApp } = await import('../../lib/appVisit.js');

function stubFetch(entitlement) {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    if (url === '/api/entitlement') return { ok: true, status: 200, json: async () => entitlement };
    if (url === '/api/story/projects') return { ok: true, status: 200, json: async () => ({ projects: [] }) };
    return { ok: false, status: 404, json: async () => ({}) };
  }));
}

beforeEach(() => {
  router.pathname = '/app';
  router.asPath = '/app';
  router.replace = vi.fn();
  router.push = vi.fn();
  router.events = null;
  supa.user = { id: 'u1' };
  window.history.replaceState({}, '', '/app');
  _resetInApp();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const settle = () => new Promise((r) => setTimeout(r, 30));

describe('/app home for old-plan customers', () => {
  it('sends a legacyPlan customer to /legacy-home with replace', async () => {
    stubFetch({ tier: 'monthly', legacyPlan: true });
    render(<AppHome />);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/legacy-home'));
    expect(router.replace).toHaveBeenCalledTimes(1);
  });

  it('stays in the story maker with ?maker=1', async () => {
    window.history.replaceState({}, '', '/app?maker=1');
    stubFetch({ tier: 'monthly', legacyPlan: true });
    render(<AppHome />);
    await settle();
    expect(router.replace).not.toHaveBeenCalled();
    expect(await screen.findByText('No videos yet')).toBeInTheDocument();
  });

  it('stays when the customer came from another page inside /app in this tab', async () => {
    router.pathname = '/app/billing';
    router.asPath = '/app/billing';
    const { unmount } = render(<AppShell><p>x</p></AppShell>);
    unmount();
    router.pathname = '/app';
    router.asPath = '/app';
    stubFetch({ tier: 'monthly', legacyPlan: true });
    render(<AppHome />);
    await settle();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('stays when a link click leaves /app (route change start inside the app)', async () => {
    const handlers = {};
    router.events = { on: (n, f) => { handlers[n] = f; }, off() {} };
    stubFetch({ tier: 'monthly', legacyPlan: true });
    const { unmount } = render(<AppShell><p>x</p></AppShell>);
    handlers.routeChangeStart?.('/app');
    unmount();
    render(<AppHome />);
    await settle();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('still redirects after the customer signed out (a move to / is not "inside the app")', async () => {
    const handlers = {};
    router.events = { on: (n, f) => { handlers[n] = f; }, off() {} };
    stubFetch({ tier: 'monthly', legacyPlan: true });
    const { unmount } = render(<AppShell><p>x</p></AppShell>);
    handlers.routeChangeStart?.('/');
    unmount();
    render(<AppHome />);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/legacy-home'));
  });

  it.each([
    ['v2 or no plan', { tier: 'monthly', legacyPlan: false }],
    ['admin', { tier: 'admin', isAdmin: true, legacyPlan: false }],
    ['an entitlement without the field', { tier: 'none' }],
  ])('does not redirect %s', async (_n, ent) => {
    stubFetch(ent);
    render(<AppHome />);
    expect(await screen.findByText('No videos yet')).toBeInTheDocument();
    await settle();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('does not redirect when the entitlement cannot be read', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    render(<AppHome />);
    await settle();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('never redirects from a deep link (the shell on /app/p/..., /app/billing, /app/new)', async () => {
    stubFetch({ tier: 'monthly', legacyPlan: true });
    for (const path of ['/app/p/abc', '/app/billing', '/app/new']) {
      router.pathname = path;
      router.asPath = path;
      render(<AppShell><p>x</p></AppShell>);
      await settle();
      cleanup();
    }
    expect(router.replace).not.toHaveBeenCalled();
  });
});

describe('header "Classic tools" link', () => {
  it('shows for a legacyPlan customer and points at /legacy-home', async () => {
    stubFetch({ tier: 'monthly', legacyPlan: true, creditsRemaining: 3 });
    render(<AppShell><p>x</p></AppShell>);
    const link = await screen.findByRole('link', { name: 'Classic tools' });
    expect(link).toHaveAttribute('href', '/legacy-home');
  });

  it.each([
    ['v2 or no plan', { tier: 'monthly', legacyPlan: false }],
    ['admin', { tier: 'admin', isAdmin: true, legacyPlan: false }],
  ])('is not shown for %s', async (_n, ent) => {
    stubFetch(ent);
    render(<AppShell><p>x</p></AppShell>);
    await screen.findByRole('button', { name: 'Sign out' });
    await settle();
    expect(screen.queryByRole('link', { name: 'Classic tools' })).toBeNull();
  });

  it('is not shown when signed out', async () => {
    supa.user = null;
    stubFetch({ tier: 'none', legacyPlan: false });
    render(<AppShell><p>x</p></AppShell>);
    await settle();
    expect(screen.queryByRole('link', { name: 'Classic tools' })).toBeNull();
  });
});

describe('/legacy-home story maker link', () => {
  const text = /New: make animated story videos\./;

  it('shows one small link to /app?maker=1 for a legacyPlan customer', async () => {
    router.pathname = '/legacy-home';
    router.asPath = '/legacy-home';
    stubFetch({ tier: 'monthly', creditsRemaining: 5, legacyPlan: true });
    render(<LegacyHome />);
    const link = await screen.findByRole('link', { name: 'Try the new story maker' });
    expect(link).toHaveAttribute('href', '/app?maker=1');
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Try the new story maker' })).toHaveLength(1);
  });

  it.each([
    ['not on an old plan', { tier: 'monthly', creditsRemaining: 5, legacyPlan: false }],
    ['an admin', { tier: 'admin', isAdmin: true, legacyPlan: false }],
  ])('shows nothing for %s', async (_n, ent) => {
    router.pathname = '/legacy-home';
    stubFetch(ent);
    render(<LegacyHome />);
    await screen.findByText(/Turn your image into a talking, moving video/);
    expect(screen.queryByRole('link', { name: 'Try the new story maker' })).toBeNull();
  });

  it('shows nothing for a signed-out visitor', async () => {
    router.pathname = '/legacy-home';
    supa.user = null;
    stubFetch({ tier: 'none', legacyPlan: true });
    render(<LegacyHome />);
    await settle();
    expect(screen.queryByRole('link', { name: 'Try the new story maker' })).toBeNull();
  });
});
