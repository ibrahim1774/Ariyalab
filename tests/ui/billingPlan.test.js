// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import BillingPage from '../../pages/app/billing';
import { PLANS_V2, TOPUPS_V2 } from '../../lib/pricing';

vi.mock('next/router', () => ({ useRouter: () => ({ pathname: '/app/billing', asPath: '/app/billing' }) }));

const realLocation = window.location;
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Object.defineProperty(window, 'location', { value: realLocation, configurable: true, writable: true });
  window.history.replaceState(null, '', '/');
});

const RENEWS = '2027-03-15T12:00:00.000Z';
function stub(plan, portal = async () => ({ ok: true, status: 200, json: async () => ({ url: 'https://billing.stripe.test/x' }) }), plans = PLANS_V2) {
  const calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    calls.push(url);
    if (String(url).startsWith('/api/story/billing')) return { ok: true, status: 200, json: async () => ({ v2: true, balance: { plan: 5, topup: 0, held: 0, available: 5 }, history: [], ...(plan && plan.__raw ? plan.__raw : { plan }) }) };
    if (url === '/api/story/pricing') return { ok: true, status: 200, json: async () => ({ plans, topups: TOPUPS_V2, yearlyDiscount: 0.15 }) };
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

  it('yearly plan: opens on the yearly tab, shows yearly, and the monthly card of the same plan has no button', async () => {
    stub({ plan: 'studio', interval: 'year', status: 'active', renewsAt: RENEWS, endsAt: null });
    render(<BillingPage />);
    expect(await screen.findByTestId('current-plan')).toHaveTextContent(/yearly/i);
    expect(await screen.findByRole('button', { name: 'Your plan' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Monthly' }));
    expect(screen.queryByRole('button', { name: 'Your plan' })).toBeNull();
    // a yearly subscriber cannot move to monthly in the portal: no button on the monthly card, a plain line instead
    expect(screen.queryByRole('button', { name: 'Switch to Studio' })).toBeNull();
    expect(screen.getByTestId('yearly-note')).toBeInTheDocument();
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
    Object.defineProperty(window, 'location', { value: { href: '', search: '', pathname: '/app/billing' }, configurable: true, writable: true });
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

  const live = { plan: 'creator', interval: 'month', legacy: false, status: 'active', renewsAt: RENEWS, endsAt: null };

  it('back from the portal: the plan is read fresh and the marker leaves the address bar', async () => {
    window.history.replaceState(null, '', '/app/billing?from=portal');
    const calls = stub({ ...live, endsAt: RENEWS });
    render(<BillingPage />);
    expect(await screen.findByTestId('current-plan')).toHaveTextContent(/ends on/i);
    expect(calls).toContain('/api/story/billing?fresh=1');
    expect(calls).not.toContain('/api/story/billing');
    await waitFor(() => expect(window.location.search).toBe(''));
  });

  it('back from checkout is read fresh too; a plain visit is not', async () => {
    window.history.replaceState(null, '', '/app/billing?from=checkout');
    let calls = stub(live);
    render(<BillingPage />);
    await screen.findByTestId('current-plan');
    expect(calls).toContain('/api/story/billing?fresh=1');
    cleanup();
    window.history.replaceState(null, '', '/app/billing');
    calls = stub(live);
    render(<BillingPage />);
    await screen.findByTestId('current-plan');
    expect(calls).toContain('/api/story/billing');
    expect(calls).not.toContain('/api/story/billing?fresh=1');
  });

  it('a legacy plan is shown with one plain line and no plan buttons; Manage billing stays', async () => {
    stub({ plan: 'pro', interval: 'month', legacy: true, status: 'active', renewsAt: RENEWS, endsAt: null });
    render(<BillingPage />);
    const line = await screen.findByTestId('current-plan');
    expect(line).toHaveTextContent('Pro');
    expect(line).toHaveTextContent(/renews on/i);
    expect(screen.getByTestId('legacy-note')).toHaveTextContent('To move to a new plan, cancel your current plan in Manage billing, then choose a new one here.');
    await screen.findByText('starter');
    expect(screen.queryByRole('button', { name: /choose plan/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /switch to/i })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Your plan' })).toBeNull();
    expect(screen.getByRole('button', { name: /manage billing/i })).toBeEnabled();
  });

  it('a legacy plan with cancellation pending says when it ends', async () => {
    stub({ plan: 'pro', interval: 'month', legacy: true, status: 'active', renewsAt: RENEWS, endsAt: RENEWS });
    render(<BillingPage />);
    expect(await screen.findByTestId('current-plan')).toHaveTextContent(/ends on/i);
  });

  it('plan unknown: a quiet line, balance still shown, and no button can start a second checkout', async () => {
    const calls = stub({ __raw: { plan: null, planUnknown: true } });
    render(<BillingPage />);
    expect(await screen.findByTestId('plan-unknown')).toHaveTextContent("We couldn't load your plan just now.");
    expect(screen.getByTestId('balance-available')).toHaveTextContent('5');
    await screen.findByText('starter');
    expect(screen.queryByRole('button', { name: /choose plan/i })).toBeNull();
    const buttons = screen.getAllByRole('button', { name: 'Manage billing' });
    expect(buttons.length).toBeGreaterThanOrEqual(4); // the top one and one per plan
    Object.defineProperty(window, 'location', { value: { href: '', search: '', pathname: '/app/billing' }, configurable: true, writable: true });
    fireEvent.click(buttons[1]);
    await waitFor(() => expect(calls).toContain('/api/billing/portal'));
    expect(calls).not.toContain('/api/checkout');
  });

  it('past_due: a payment problem line, not a renewal date', async () => {
    stub({ ...live, status: 'past_due' });
    render(<BillingPage />);
    const line = await screen.findByTestId('current-plan');
    expect(line).toHaveTextContent('Payment problem: update your card in Manage billing.');
    expect(line).not.toHaveTextContent(/renews on/i);
  });

  it('a checkout started from this page returns with the fresh-read marker', async () => {
    const bodies = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (String(url).startsWith('/api/story/billing')) return { ok: true, status: 200, json: async () => ({ v2: true, balance: { plan: 0, topup: 0, held: 0, available: 0 }, history: [], plan: null }) };
      if (url === '/api/story/pricing') return { ok: true, status: 200, json: async () => ({ plans: PLANS_V2, topups: TOPUPS_V2, yearlyDiscount: 0.15 }) };
      if (url === '/api/checkout') { bodies.push(JSON.parse(init.body)); return { ok: false, status: 500, json: async () => ({}) }; }
      return { ok: false, status: 404, json: async () => ({}) };
    }));
    render(<BillingPage />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Choose plan' }))[0]);
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0].returnTo).toBe('/app/billing?from=checkout');
  });

  const yearlySub = { plan: 'creator', interval: 'year', legacy: false, status: 'active', renewsAt: RENEWS, endsAt: null, pending: null };

  it('a yearly subscriber: monthly cards have no button and one plain line says how to move to monthly', async () => {
    stub(yearlySub);
    render(<BillingPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Monthly' }));
    expect(screen.getByTestId('yearly-note')).toHaveTextContent('To move to monthly billing, cancel in Manage billing and choose a monthly plan when your current year ends.');
    expect(screen.queryByRole('button', { name: /switch to/i })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Your plan' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Choose plan' })).toBeNull();
  });

  it('a yearly subscriber on the yearly tab: Your plan, and Switch to for the other yearly plans, no note', async () => {
    stub(yearlySub);
    render(<BillingPage />);
    expect(await screen.findByRole('button', { name: 'Your plan' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Switch to Starter' })).toBeEnabled();
    expect(screen.queryByTestId('yearly-note')).toBeNull();
  });

  it('a monthly subscriber sees no yearly note', async () => {
    stub(live);
    render(<BillingPage />);
    await screen.findByTestId('current-plan');
    expect(screen.queryByTestId('yearly-note')).toBeNull();
  });

  it('a scheduled downgrade: "Changes to Starter on <date>" and the Starter card reads "Starts <date>" (disabled)', async () => {
    stub({ ...live, pending: { plan: 'starter', interval: 'month', startsAt: RENEWS } });
    render(<BillingPage />);
    const line = await screen.findByTestId('pending-change');
    expect(line).toHaveTextContent(/changes to starter on/i);
    expect(line).toHaveTextContent('2027');
    const starts = await screen.findByRole('button', { name: /^starts /i });
    expect(starts).toBeDisabled();
    expect(starts).toHaveTextContent('2027');
    expect(screen.queryByRole('button', { name: 'Switch to Starter' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Your plan' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Switch to Studio' })).toBeEnabled();
  });

  it('a scheduled switch to yearly on the same plan names the new period and marks the yearly card', async () => {
    stub({ ...live, pending: { plan: 'creator', interval: 'year', startsAt: RENEWS } });
    render(<BillingPage />);
    expect(await screen.findByTestId('pending-change')).toHaveTextContent(/changes to creator \(yearly\) on/i);
    expect(screen.queryByRole('button', { name: /^starts /i })).toBeNull(); // the monthly tab: the yearly card is not shown
    fireEvent.click(screen.getByRole('button', { name: 'Yearly' }));
    expect(screen.getByRole('button', { name: /^starts /i })).toBeDisabled();
  });

  it('nothing scheduled (including after a cancellation was undone): no change line and no "Starts" card', async () => {
    stub({ ...live, pending: null });
    render(<BillingPage />);
    await screen.findByTestId('current-plan');
    expect(screen.queryByTestId('pending-change')).toBeNull();
    expect(screen.queryByRole('button', { name: /^starts /i })).toBeNull();
    expect(screen.getByRole('button', { name: 'Switch to Starter' })).toBeEnabled();
  });

  it('prices show as money: two decimals and thousands separators, whole dollars stay whole', async () => {
    const plans = {
      starter: { usd: 29, credits: 900, yearlyUsd: 295.8 },
      creator: { usd: 49, credits: 1500, yearlyUsd: 499.8 },
      studio: { usd: 99, credits: 3100, yearlyUsd: 1009.8 },
    };
    stub(null, undefined, plans);
    render(<BillingPage />);
    await screen.findAllByRole('button', { name: 'Choose plan' });
    expect(screen.getByText('$29', { selector: 'span' })).toBeInTheDocument();
    expect(document.body.textContent).toContain('$29/mo');
    fireEvent.click(screen.getByRole('button', { name: 'Yearly' }));
    expect(document.body.textContent).toContain('$1,009.80/yr');
    expect(document.body.textContent).toContain('$295.80/yr');
    expect(document.body.textContent).toContain('$499.80/yr');
    expect(document.body.textContent).not.toContain('$295.8/yr');
  });

  it('"no billing account yet" is information in the neutral style, not an alert', async () => {
    stub(null, async () => ({ ok: false, status: 404, json: async () => ({ error: 'There is no billing account yet. Choose a plan first.', code: 'NO_CUSTOMER' }) }));
    render(<BillingPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Manage billing' }));
    const info = await screen.findByTestId('billing-info');
    expect(info).toHaveTextContent('There is no billing account yet. Choose a plan first.');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('other portal failures are still an alert', async () => {
    stub(null, async () => ({ ok: false, status: 500, json: async () => ({ error: 'x' }) }));
    render(<BillingPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Manage billing' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("We couldn't open billing. Please try again in a moment.");
  });
});
