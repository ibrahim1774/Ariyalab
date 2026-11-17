// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const router = vi.hoisted(() => ({ pathname: '/sign-in', query: {}, push: null, isReady: true }));
vi.mock('next/router', () => ({ useRouter: () => router }));
vi.mock('../../lib/supabase', () => ({
  getBrowserSupabase: () => ({
    auth: {
      signInWithPassword: async () => ({ error: null }),
      signUp: async () => ({ error: null }),
    },
  }),
}));

const SignIn = (await import('../../pages/sign-in/index.js')).default;
const SignUp = (await import('../../pages/sign-up/index.js')).default;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  router.query = {};
});

async function submit(label) {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@example.test' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password123' } });
  fireEvent.click(screen.getByRole('button', { name: label }));
}

describe('landing after sign-in and sign-up', () => {
  it('sign-in goes to the requested page and is not sent home by the modal closing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })));
    router.push = vi.fn();
    router.query = { returnTo: '/app/billing' };
    const hrefSet = vi.fn();
    const loc = { ...window.location };
    Object.defineProperty(window, 'location', { configurable: true, value: { ...loc, set href(v) { hrefSet(v); }, get href() { return loc.href; }, origin: loc.origin } });
    render(<SignIn />);
    await submit('Sign in');
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/app/billing'));
    expect(hrefSet).not.toHaveBeenCalled();
    Object.defineProperty(window, 'location', { configurable: true, value: loc });
  });

  it('sign-in without a return page lands on /app', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })));
    router.push = vi.fn();
    render(<SignIn />);
    await submit('Sign in');
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/app'));
  });

  it('sign-up lands on /app by default and on a safe returnTo when given', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })));
    router.push = vi.fn();
    render(<SignUp />);
    await submit('Create account');
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/app'));
    cleanup();
    router.push = vi.fn();
    router.query = { returnTo: '/app/new' };
    render(<SignUp />);
    await submit('Create account');
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/app/new'));
  });

  it('an unsafe returnTo falls back to /app', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })));
    router.push = vi.fn();
    router.query = { returnTo: '//evil.com' };
    render(<SignIn />);
    await submit('Sign in');
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/app'));
  });
});
