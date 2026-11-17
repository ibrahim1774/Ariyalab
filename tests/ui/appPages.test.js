// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import AppHome from '../../pages/app/index';
import BillingPage, { reasonLabel } from '../../pages/app/billing';
import { PLANS, TOPUPS } from '../../lib/stripe';
import { PLANS_V2, TOPUPS_V2 } from '../../lib/pricing';
import ProjectCard, { projectStatus } from '../../components/app/ProjectCard';

vi.mock('next/router', () => ({ useRouter: () => ({ pathname: '/app', asPath: '/app' }) }));

function stubFetch(routes) {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const hit = routes[url];
    if (!hit) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: hit.ok !== false, status: hit.status || 200, json: async () => hit.body };
  }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('/app projects page', () => {
  it('shows the empty state with a New video button when the projects route 404s', async () => {
    stubFetch({});
    render(<AppHome />);
    expect(await screen.findByText('No videos yet')).toBeInTheDocument();
    const buttons = screen.getAllByRole('link', { name: /new video/i });
    expect(buttons.length).toBeGreaterThan(0);
  });

  it('lists projects when the route answers', async () => {
    stubFetch({ '/api/story/projects': { body: { projects: [{ id: 'p1', title: 'Fox and the moon', step: 'script' }] } } });
    render(<AppHome />);
    expect(await screen.findByText('Fox and the moon')).toBeInTheDocument();
    expect(screen.queryByText('No videos yet')).toBeNull();
  });
});

describe('ProjectCard', () => {
  it.each([
    [{ step: 'brief' }, 'draft', 'Draft'],
    [{ step: 'generate' }, 'generating', 'Generating'],
    [{ step: 'done' }, 'finished', 'Finished'],
    [{ step: 'generate', status: 'failed' }, 'failed', 'Needs attention'],
  ])('badge for %j', (extra, status, label) => {
    expect(projectStatus(extra)).toBe(status);
    render(<ProjectCard project={{ id: 'p', title: 'T', ...extra }} />);
    const badge = screen.getByText(label);
    expect(badge).toHaveAttribute('data-status', status);
  });
});

describe('/app/billing', () => {
  const offers = {
    '/api/story/pricing': { body: { plans: PLANS_V2, topups: TOPUPS_V2, yearlyDiscount: 0.2 } },
  };

  it('shows the plan, top-up and held split in v2 mode, with plain ledger labels', async () => {
    stubFetch({
      ...offers,
      '/api/story/billing': {
        body: {
          v2: true,
          balance: { plan: 1200, topup: 300, held: 90, available: 1410 },
          history: [{ created_at: '2026-11-01T00:00:00Z', delta: 1500, reason: 'plan_renewal', balance_after: 1500 }],
        },
      },
    });
    render(<BillingPage />);
    expect(await screen.findByTestId('balance-plan')).toHaveTextContent('1,200');
    expect(screen.getByTestId('balance-topup')).toHaveTextContent('300');
    expect(screen.getByTestId('balance-held')).toHaveTextContent('90');
    expect(screen.queryByTestId('balance-single')).toBeNull();
    expect(screen.getByText('Monthly credits')).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByRole('button', { name: /choose plan/i })).toHaveLength(Object.keys(PLANS_V2).length));
  });

  it('shows a single Credits number when billing v2 is off', async () => {
    stubFetch({
      ...offers,
      '/api/story/billing': { body: { v2: false, balance: { plan: null, topup: null, held: 0, available: 42 }, history: [] } },
    });
    render(<BillingPage />);
    expect(await screen.findByTestId('balance-single')).toHaveTextContent('42');
    expect(screen.queryByTestId('balance-plan')).toBeNull();
    expect(screen.queryByText('History')).toBeNull();
  });

  it('maps ledger reasons to plain labels', () => {
    expect(reasonLabel('topup')).toBe('Top-up');
    expect(reasonLabel('clip')).toBe('Video shot');
    expect(reasonLabel('clawback')).toBe('Refund adjustment');
    expect(reasonLabel('narration_regen')).toBe('Narration regen');
  });

  it('v2 mode shows the v2 plan and top-up amounts from lib/pricing', async () => {
    stubFetch({
      ...offers,
      '/api/story/billing': { body: { v2: true, balance: { plan: 1, topup: 1, held: 0, available: 2 }, history: [] } },
    });
    render(<BillingPage />);
    await screen.findByText('Plans');
    for (const p of Object.values(PLANS_V2)) {
      expect(screen.getByText(`${p.credits.toLocaleString()} credits every month`)).toBeInTheDocument();
    }
    for (const t of Object.values(TOPUPS_V2)) {
      expect(screen.getByText(`${t.credits.toLocaleString()} credits, no expiry`)).toBeInTheDocument();
    }
  });

  it('legacy mode shows the legacy plans and packs with their real credit counts', async () => {
    const legacy = {
      plans: Object.fromEntries(Object.entries(PLANS).map(([k, p]) => [k, { usd: p.amountCents / 100, credits: p.cap, interval: p.interval }])),
      topups: Object.fromEntries(Object.entries(TOPUPS).filter(([, t]) => t.kind === 'video').map(([k, t]) => [k, { usd: t.amountCents / 100, credits: t.credits }])),
    };
    stubFetch({
      '/api/story/billing': { body: { v2: false, balance: { plan: null, topup: null, held: 0, available: 9 }, history: [], offers: legacy } },
    });
    render(<BillingPage />);
    await screen.findByText('Plans');
    for (const p of Object.values(PLANS)) {
      const per = p.interval === 'year' ? 'year' : 'month';
      expect(screen.getByText(`${p.cap.toLocaleString()} credits every ${per}`)).toBeInTheDocument();
    }
    for (const t of Object.values(TOPUPS).filter((x) => x.kind === 'video')) {
      expect(screen.getByText(`${t.credits.toLocaleString()} credits, no expiry`)).toBeInTheDocument();
    }
    expect(screen.queryByText('700 credits, no expiry')).toBeNull();
  });

  it('sends the legacy plan key to /api/checkout in legacy mode', async () => {
    const legacy = { plans: { monthly: { usd: 5, credits: 760, interval: 'month' } }, topups: {} };
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (url === '/api/checkout') { calls.push(JSON.parse(init.body)); return { ok: false, status: 400, json: async () => { throw new Error('not json'); } }; }
      return { ok: true, json: async () => ({ v2: false, balance: { available: 1 }, history: [], offers: legacy }) };
    }));
    render(<BillingPage />);
    fireEvent.click(await screen.findByRole('button', { name: /choose plan/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent("We couldn't start the payment. Please try again in a moment.");
    expect(calls[0]).toMatchObject({ plan: 'monthly', returnTo: '/app/billing' });
  });

  const v2Billing = { v2: true, balance: { plan: 0, topup: 30, held: 0, available: 30 }, history: [] };
  const v2Pricing = { plans: PLANS_V2, topups: TOPUPS_V2 };
  const stubBilling = (api) => vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    if (url === '/api/story/billing') return { ok: true, status: 200, json: async () => v2Billing };
    if (url === '/api/story/pricing') return { ok: true, status: 200, json: async () => v2Pricing };
    return api(url, init);
  }));

  it('a server error when buying credits shows the plain payment line, never the raw text', async () => {
    stubBilling(async () => ({ ok: false, status: 500, json: async () => ({ error: 'No such price: price_123 (stripe)' }) }));
    render(<BillingPage />);
    fireEvent.click((await screen.findAllByRole('button', { name: /buy credits/i }))[0]);
    expect(await screen.findByRole('alert')).toHaveTextContent("We couldn't start the payment. Please try again in a moment.");
    expect(screen.queryByText(/price_123/)).toBeNull();
  });

  it('a network failure when buying credits shows the same line', async () => {
    stubBilling(async () => { throw new TypeError('Failed to fetch'); });
    render(<BillingPage />);
    fireEvent.click((await screen.findAllByRole('button', { name: /buy credits/i }))[0]);
    expect(await screen.findByRole('alert')).toHaveTextContent("We couldn't start the payment. Please try again in a moment.");
  });

  it('when billing cannot open, the portal line is shown; a clear 4xx reason is kept', async () => {
    stubBilling(async () => ({ ok: false, status: 500, json: async () => ({ error: 'Could not open billing. Please try again.' }) }));
    render(<BillingPage />);
    fireEvent.click(await screen.findByRole('button', { name: /manage billing/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent("We couldn't open billing. Please try again in a moment.");
    cleanup();
    stubBilling(async () => ({ ok: false, status: 404, json: async () => ({ error: 'There is no billing account yet. Choose a plan first.' }) }));
    render(<BillingPage />);
    fireEvent.click(await screen.findByRole('button', { name: /manage billing/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('There is no billing account yet. Choose a plan first.');
  });
});
