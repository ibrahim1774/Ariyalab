// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const router = vi.hoisted(() => ({ pathname: '/app', asPath: '/app', push: null }));
const supa = vi.hoisted(() => ({ user: null, signOut: null }));
vi.mock('next/router', () => ({ useRouter: () => router }));
vi.mock('../../lib/supabase', () => ({
  getBrowserSupabase: () => ({
    auth: {
      getUser: () => Promise.resolve({ data: { user: supa.user } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signOut: supa.signOut,
    },
  }),
}));

const AppShell = (await import('../../components/app/AppShell.js')).default;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  supa.user = null;
});

describe('app shell sign out', () => {
  it('shows Sign out when signed in; clicking signs out and goes to /', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })));
    supa.user = { id: 'u1' };
    supa.signOut = vi.fn(async () => ({}));
    router.push = vi.fn();
    render(<AppShell><p>x</p></AppShell>);
    const btn = await screen.findByRole('button', { name: 'Sign out' });
    fireEvent.click(btn);
    await waitFor(() => expect(supa.signOut).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/'));
  });

  it('is not shown when signed out', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })));
    supa.user = null;
    render(<AppShell><p>x</p></AppShell>);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
  });
});
