// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, waitFor, cleanup } from '@testing-library/react';

let query = {};
const replace = vi.fn();
const router = { replace, push: vi.fn(), pathname: '/' };
vi.mock('next/router', () => ({ useRouter: () => { router.query = query; return router; } }));
let authProps = null;
vi.mock('../../components/AuthModal', () => ({ default: (p) => { authProps = p; return null; } }));
const supabase = { auth: { getUser: async () => ({ data: { user: { id: 'u', email: 'a@example.test' } } }) } };
vi.mock('../../lib/supabase', () => ({ getBrowserSupabase: () => supabase }));
vi.mock('../../components/Paywall', () => ({ default: () => null }));
vi.mock('../../components/TopupRow', () => ({ default: () => null }));

const SignIn = (await import('../../pages/sign-in/index.js')).default;
const Dashboard = (await import('../../pages/dashboard/index.js')).default;

afterEach(() => {
  cleanup();
  replace.mockClear();
  authProps = null;
  query = {};
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});

describe('sign-in return path', () => {
  it('defaults to /app', () => {
    render(<SignIn />);
    expect(authProps.redirectTo).toBe('/app');
  });
  it('keeps a safe returnTo and drops an unsafe one', () => {
    query = { returnTo: '/app/billing' };
    render(<SignIn />);
    expect(authProps.redirectTo).toBe('/app/billing');
    cleanup();
    query = { returnTo: '/\\evil.com' };
    render(<SignIn />);
    expect(authProps.redirectTo).toBe('/app');
  });
});

describe('/dashboard', () => {
  it('redirects to /app when there is no checkout to finalize', async () => {
    render(<Dashboard />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/app'));
  });

  it('ignores an unsafe returnTo', async () => {
    window.history.replaceState({}, '', '/dashboard?returnTo=%2F%255Cevil.com');
    render(<Dashboard />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/app'));
  });

  it('stays to confirm a paid checkout, then continues to returnTo', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const fetchMock = vi.fn(async (url) => ({ ok: true, json: async () => (String(url).includes('confirm') ? { meta: {} } : {}) }));
    vi.stubGlobal('fetch', fetchMock);
    window.history.replaceState({}, '', '/dashboard?paid=1&session_id=cs_1&returnTo=%2Fapp%2Fbilling');
    render(<Dashboard />);
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/api/checkout/confirm?session_id=cs_1'))).toBe(true));
    expect(replace).not.toHaveBeenCalledWith('/app');
    await vi.advanceTimersByTimeAsync(700);
    expect(replace).toHaveBeenCalledWith('/app/billing');
    vi.useRealTimers();
  });
});
