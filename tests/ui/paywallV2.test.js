// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import Paywall from '../../components/Paywall';
import TopupRow from '../../components/TopupRow';

const OFFERS = {
  plans: {
    starter: { usd: 29, credits: 1500, monthlyCents: 2900, yearlyCents: 34800, yearlyUsd: 348 },
    creator: { usd: 49, credits: 2600, monthlyCents: 4900, yearlyCents: 58800, yearlyUsd: 588 },
    studio: { usd: 99, credits: 5400, monthlyCents: 9900, yearlyCents: 118800, yearlyUsd: 1188 },
  },
  topups: { s: { usd: 15, credits: 700, cents: 1500 }, m: { usd: 40, credits: 1900, cents: 4000 }, l: { usd: 100, credits: 5000, cents: 10000 } },
  yearlyDiscount: 0,
};

function stubFetch(billingV2) {
  const calls = [];
  global.fetch = vi.fn(async (url, init) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    if (url === '/api/story/pricing') return { ok: true, json: async () => ({ ...OFFERS, billingV2 }) };
    return { ok: false, json: async () => ({ error: 'stop here' }) };
  });
  return calls;
}

afterEach(() => {
  cleanup();
  delete global.fetch;
});

describe('old funnel pricing with billing_v2', () => {
  it('on: the paywall shows the v2 plans and checks out the v2 plan name', async () => {
    const calls = stubFetch(true);
    render(<Paywall entitlement={null} returnTo="/ugc-2" surface="video" />);
    await waitFor(() => expect(screen.getByText('Starter')).toBeInTheDocument());
    expect(screen.getByText('2,600 video credits each month')).toBeInTheDocument();
    expect(screen.queryByText(/Subscribe → \$5\/mo/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Subscribe → \$49\/mo/ }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/checkout')).toBe(true));
    expect(calls.find((c) => c.url === '/api/checkout').body).toMatchObject({ plan: 'creator' });
  });

  it('off: the paywall keeps the legacy plans', async () => {
    stubFetch(false);
    render(<Paywall entitlement={null} returnTo="/ugc-2" surface="video" />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: /Subscribe → \$5\/mo/ })).toBeInTheDocument();
    expect(screen.queryByText('Starter')).toBeNull();
  });

  it('while the offers load, no legacy plan button is shown (a v2 checkout never starts from legacy prices)', async () => {
    let answer;
    global.fetch = vi.fn(() => new Promise((resolve) => { answer = resolve; }));
    render(<Paywall entitlement={null} returnTo="/ugc-2" surface="video" />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading plans');
    expect(screen.queryByRole('button', { name: /Subscribe/ })).toBeNull();
    answer({ ok: true, json: async () => ({ ...OFFERS, billingV2: true }) });
    await waitFor(() => expect(screen.getByText('Starter')).toBeInTheDocument());
  });

  it('R2 minor: when both pricing reads fail, an error with Try again is shown, never the legacy plans', async () => {
    let ok = false;
    global.fetch = vi.fn(async (url) => {
      if (url === '/api/story/pricing') return ok ? { ok: true, json: async () => ({ ...OFFERS, billingV2: true }) } : { ok: false, json: async () => ({}) };
      return { ok: false, json: async () => ({}) };
    });
    render(<Paywall entitlement={null} returnTo="/ugc-2" surface="video" />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('could not be loaded'), { timeout: 4000 });
    expect(screen.queryByRole('button', { name: /Subscribe/ })).toBeNull();
    ok = true;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByText('Starter')).toBeInTheDocument());
  });

  it('on: the top-up row shows the v2 pack prices and credits', async () => {
    stubFetch(true);
    render(<TopupRow returnTo="/dashboard" />);
    await waitFor(() => expect(screen.getByText('$40')).toBeInTheDocument());
    expect(screen.queryByText('$50')).toBeNull();
  });
});
