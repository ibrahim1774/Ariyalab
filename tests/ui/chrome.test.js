// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import Modal from '../../components/ui/Modal';
import Toast from '../../components/ui/Toast';
import MarketingNav from '../../components/marketing/MarketingNav';
import CreditBadge from '../../components/app/CreditBadge';

let mockUser = null;
vi.mock('next/router', () => ({ useRouter: () => ({ pathname: '/', asPath: '/' }) }));
vi.mock('../../lib/supabase', () => ({
  getBrowserSupabase: () => ({
    auth: {
      getUser: () => Promise.resolve({ data: { user: mockUser } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
  }),
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  mockUser = null;
});

describe('Modal', () => {
  it('closes on Escape and backdrop click, not on clicks inside', () => {
    const onClose = vi.fn();
    render(<Modal open onClose={onClose} title="Hi">Body text</Modal>);
    fireEvent.mouseDown(screen.getByText('Body text'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(screen.getByRole('dialog').parentElement);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('renders nothing when closed', () => {
    render(<Modal open={false} onClose={() => {}}>Body</Modal>);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('Toast', () => {
  it('auto-dismisses via onClose', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(<Toast message="Saved" onClose={onClose} duration={1000} />);
    expect(screen.getByRole('status')).toHaveTextContent('Saved');
    act(() => { vi.advanceTimersByTime(999); });
    expect(onClose).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clears the timer on unmount', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const { unmount } = render(<Toast message="Saved" onClose={onClose} duration={1000} />);
    unmount();
    act(() => { vi.advanceTimersByTime(2000); });
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('MarketingNav auth state', () => {
  it('shows Login and Get Started when signed out', async () => {
    render(<MarketingNav />);
    await act(async () => {});
    expect(screen.getByText('Login')).toBeInTheDocument();
    expect(screen.getByText('Get Started')).toBeInTheDocument();
    expect(screen.queryByText('Dashboard')).toBeNull();
  });

  it('shows a Dashboard button to /app when signed in', async () => {
    mockUser = { id: 'u1' };
    render(<MarketingNav />);
    const dash = await screen.findByText('Dashboard');
    expect(dash.closest('a')).toHaveAttribute('href', '/app');
    expect(screen.queryByText('Login')).toBeNull();
  });
});

describe('CreditBadge', () => {
  it('renders nothing when signed out and does not fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(<CreditBadge />);
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows the balance when signed in', async () => {
    mockUser = { id: 'u1' };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ creditsRemaining: 5 }) }));
    render(<CreditBadge />);
    expect(await screen.findByText('5 credits')).toBeInTheDocument();
  });
});
