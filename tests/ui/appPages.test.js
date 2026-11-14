// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import AppHome from '../../pages/app/index';
import BillingPage, { reasonLabel } from '../../pages/app/billing';
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
    '/api/story/pricing': { body: { plans: { starter: { usd: 29, credits: 1500 } }, topups: { s: { usd: 15, credits: 700 } }, yearlyDiscount: 0.2 } },
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
    await waitFor(() => expect(screen.getByRole('button', { name: /choose plan/i })).toBeInTheDocument());
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
});
