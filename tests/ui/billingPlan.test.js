// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import BillingPage from '../../pages/app/billing';
import { PLANS_V2, TOPUPS_V2 } from '../../lib/pricing';

vi.mock('next/router', () => ({ useRouter: () => ({ pathname: '/app/billing', asPath: '/app/billing' }) }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const RENEWS = '2027-03-15T12:00:00.000Z';
function stub(plan, portal = async () => ({ ok: true, status: 200, json: async () => ({ url: 'https://billing.stripe.test/x' }) })) {
  const calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    calls.push(url);
    if (url === '/api/story/billing') return { ok: true, status: 200, json: async () => ({ v2: true, balance: { plan: 5, topup: 0, held: 0, available: 5 }, history: [], plan }) };
    if (url === '/api/story/pricing') return { ok: true, status: 200, json: async () => ({ plans: PLANS_V2, topups: TOPUPS_V2, yearlyDiscount: 0.15 }) };
    if (url === '/api/billing/portal') return portal(url, init);
    return { ok: false, status: 404, json: async () => ({}) };
  }));
  return calls;
}

describe('/app/billing plan state', () => {
  it('no plan: no current-plan line, every plan reads "Choose plan"', async () => {
    stub(null);
    render(<BillingPage />);
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Choose plan' })).toHaveLength(3));
    expect(screen.queryByTestId('current-plan')).toBeNull();
    expect(screen.queryByRole('button', { name: /your plan/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /switch to/i })).toBeNull();
  });

  it('monthly plan: name, monthly, renewal date; its button is "Your plan" (disabled), the others "Switch to"', async () => {
    stub({ plan: 'creator', interval: 'month', status: 'active', renewsAt: RENEWS, endsAt: null });
    render(<BillingPage />);
    const line = await screen.findByTestId('current-plan');
    expect(line).toHaveTextContent('Creator');
    expect(line).toHaveTextContent(/monthly/i);
    expect(line).toHaveTextContent(/renews on/i);
    expect(line).toHaveTextContent('2027');
    expect(line).not.toHaveTextContent(/ends on/i);
    const mine = await screen.findByRole('button', { name: 'Your plan' });
    expect(mine).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Switch to Starter' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Switch to Studio' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Choose plan' })).toBeNull();
  });

  it('yearly plan: opens on the yearly tab, shows yearly, and the other period\'s card of the same plan is a switch', async () => {
    stub({ plan: 'studio', interval: 'year', status: 'active', renewsAt: RENEWS, endsAt: null });
    render(<BillingPage />);
    expect(await screen.findByTestId('current-plan')).toHaveTextContent(/yearly/i);
    expect(await screen.findByRole('button', { name: 'Your plan' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Monthly' }));
    expect(screen.queryByRole('button', { name: 'Your plan' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Switch to Studio' })).toBeEnabled();
  });

  it('cancellation pending: "Ends on <date>" instead of the renewal line', async () => {
    stub({ plan: 'creator', interval: 'month', status: 'active', renewsAt: RENEWS, endsAt: RENEWS });
    render(<BillingPage />);
    const line = await screen.findByTestId('current-plan');
    expect(line).toHaveTextContent(/ends on/i);
    expect(line).toHaveTextContent('2027');
    expect(line).not.toHaveTextContent(/renews on/i);
  });

  it('"Switch to" opens the portal, not checkout', async () => {
    const calls = stub({ plan: 'creator', interval: 'month', status: 'active', renewsAt: RENEWS, endsAt: null });
    delete window.location;
    window.location = { href: '' };
    render(<BillingPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Switch to Starter' }));
    await waitFor(() => expect(calls).toContain('/api/billing/portal'));
    expect(calls).not.toContain('/api/checkout');
    await waitFor(() => expect(window.location.href).toBe('https://billing.stripe.test/x'));
  });

  it('v2 off: no plan line and buttons keep "Choose plan"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ v2: false, balance: { available: 1 }, history: [], offers: { plans: { monthly: { usd: 5, credits: 760, interval: 'month' } }, topups: {} } }),
    })));
    render(<BillingPage />);
    expect(await screen.findByRole('button', { name: 'Choose plan' })).toBeEnabled();
    expect(screen.queryByTestId('current-plan')).toBeNull();
  });
});
