// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const router = vi.hoisted(() => ({ pathname: '/sign-up', query: {}, push: () => {}, isReady: true }));
vi.mock('next/router', () => ({ useRouter: () => router }));
vi.mock('../../lib/supabase', () => ({ getBrowserSupabase: () => ({ auth: {} }) }));

const AuthModal = (await import('../../components/AuthModal.js')).default;

const FB_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 [FBAN/FBIOS;FBAV/450.0.0.38.108]';

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  delete window.google;
});

function withGoogle() {
  const renderButton = vi.fn();
  window.google = { accounts: { id: { initialize: vi.fn(), renderButton } } };
  return renderButton;
}

describe('sign-up inside the Facebook / Instagram app', () => {
  it('shows the email notice, offers the email form and does not start Google sign-in', async () => {
    vi.stubEnv('NEXT_PUBLIC_GOOGLE_CLIENT_ID', 'client-id');
    const renderButton = withGoogle();
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(FB_UA);
    render(<AuthModal open onClose={() => {}} initialMode="signup" />);
    expect(await screen.findByRole('note')).toHaveTextContent("Google sign-in doesn't work inside the Facebook, Instagram or TikTok app. Use email, or open this page in your browser (tap ••• then Open in browser).");
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create account' })).toBeInTheDocument();
    expect(renderButton).not.toHaveBeenCalled();
  });

  it('in an ordinary browser keeps the Google button and shows no notice', async () => {
    vi.stubEnv('NEXT_PUBLIC_GOOGLE_CLIENT_ID', 'client-id');
    const renderButton = withGoogle();
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh) Safari/605.1.15');
    render(<AuthModal open onClose={() => {}} initialMode="signup" />);
    await vi.waitFor(() => expect(renderButton).toHaveBeenCalled());
    expect(screen.queryByRole('note')).toBeNull();
  });
});
