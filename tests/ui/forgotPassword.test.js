// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const router = vi.hoisted(() => ({ pathname: '/sign-in', query: {}, push: () => {}, isReady: true }));
const auth = vi.hoisted(() => ({
  resetPasswordForEmail: null,
  updateUser: null,
  session: null,
  listener: null,
}));
vi.mock('next/router', () => ({ useRouter: () => router }));
vi.mock('../../lib/supabase', () => ({
  getBrowserSupabase: () => ({
    auth: {
      signInWithPassword: async () => ({ error: null }),
      signUp: async () => ({ error: null }),
      resetPasswordForEmail: (...a) => auth.resetPasswordForEmail(...a),
      updateUser: (...a) => auth.updateUser(...a),
      getSession: async () => ({ data: { session: auth.session } }),
      onAuthStateChange: (cb) => {
        auth.listener = cb;
        return { data: { subscription: { unsubscribe() {} } } };
      },
    },
  }),
}));

const SignIn = (await import('../../pages/sign-in/index.js')).default;
const ResetPassword = (await import('../../pages/reset-password.js')).default;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  auth.session = null;
  auth.listener = null;
});

describe('Forgot password on sign-in', () => {
  it('sends the reset email with a redirect to /reset-password and says so', async () => {
    auth.resetPasswordForEmail = vi.fn(async () => ({ error: null }));
    render(<SignIn />);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@example.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Forgot password?' }));
    await waitFor(() => expect(auth.resetPasswordForEmail).toHaveBeenCalledWith('a@example.test', { redirectTo: `${window.location.origin}/reset-password` }));
    expect(await screen.findByRole('status')).toHaveTextContent(/a@example\.test/);
  });

  it('asks for the email first when the field is empty, and shows a failure', async () => {
    auth.resetPasswordForEmail = vi.fn(async () => ({ error: { message: 'Email rate limit exceeded' } }));
    render(<SignIn />);
    fireEvent.click(screen.getByRole('button', { name: 'Forgot password?' }));
    expect(await screen.findByText(/Type your email above first/)).toBeInTheDocument();
    expect(auth.resetPasswordForEmail).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@example.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Forgot password?' }));
    expect(await screen.findByText('Email rate limit exceeded')).toBeInTheDocument();
  });
});

describe('/reset-password', () => {
  it('lets a visitor with a recovery session set a new password and confirms it', async () => {
    auth.session = { user: { id: 'u1' } };
    auth.updateUser = vi.fn(async () => ({ error: null }));
    render(<ResetPassword />);
    const pw = await screen.findByLabelText('New password');
    fireEvent.change(pw, { target: { value: 'a-new-password' } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'a-new-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save new password' }));
    await waitFor(() => expect(auth.updateUser).toHaveBeenCalledWith({ password: 'a-new-password' }));
    expect(await screen.findByText(/Your password is changed/)).toBeInTheDocument();
  });

  it('refuses mismatched or short passwords without calling Supabase, and shows a server error', async () => {
    auth.session = { user: { id: 'u1' } };
    auth.updateUser = vi.fn(async () => ({ error: { message: 'New password should be different from the old password.' } }));
    render(<ResetPassword />);
    const pw = await screen.findByLabelText('New password');
    fireEvent.change(pw, { target: { value: 'a-new-password' } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'another-password' } });
    fireEvent.submit(pw.closest('form'));
    expect(await screen.findByText('The two passwords do not match.')).toBeInTheDocument();
    expect(auth.updateUser).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'a-new-password' } });
    fireEvent.submit(pw.closest('form'));
    expect(await screen.findByText(/should be different/)).toBeInTheDocument();
  });

  it('shows the form when the recovery event arrives, and an expired-link message when no session ever does', async () => {
    render(<ResetPassword />);
    expect(screen.getByText(/Checking your reset link/)).toBeInTheDocument();
    await act(async () => auth.listener('PASSWORD_RECOVERY', { user: { id: 'u1' } }));
    expect(await screen.findByLabelText('New password')).toBeInTheDocument();
    cleanup();

    vi.useFakeTimers();
    render(<ResetPassword />);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.getByRole('alert')).toHaveTextContent(/expired or was already used/);
    expect(screen.getByRole('link', { name: 'Back to sign in' })).toHaveAttribute('href', '/sign-in');
  });
});
