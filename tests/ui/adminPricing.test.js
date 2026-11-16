// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import PricingEditor from '../../components/admin/PricingEditor';
import { pricingReadout } from '../../lib/adminPricing';
import { DEFAULTS } from '../../lib/pricingConstants';

function snapshot(pricing, billingV2 = false) {
  return { rows: [], pricing, defaults: DEFAULTS, readout: pricingReadout(pricing), billingV2, editable: ['plans', 'topups', 'yearlyDiscount', 'billing_v2'] };
}

afterEach(() => {
  cleanup();
  delete global.fetch;
  vi.restoreAllMocks();
});

describe('admin pricing editor', () => {
  it('shows cost per credit, margins per quality and warns when the config drifts from the homepage defaults', async () => {
    const pricing = { ...structuredClone(DEFAULTS), plans: { ...DEFAULTS.plans, creator: { usd: 59, credits: 3000 } } };
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => snapshot(pricing) }));
    render(<PricingEditor />);
    await waitFor(() => expect(screen.getByText(/Billing v2 is/)).toBeInTheDocument());
    expect(screen.getByRole('alert')).toHaveTextContent('plans');
    expect(document.querySelector('[data-offer="studio"]')).toHaveTextContent('$0.0183');
    expect(document.querySelector('[data-quality="pro_talking"]')).toBeInTheDocument();
  });

  it('turns billing v2 on only after a confirm, sending confirm: billing_v2', async () => {
    const calls = [];
    global.fetch = vi.fn(async (url, init) => {
      calls.push(init?.body ? JSON.parse(init.body) : null);
      return { ok: true, json: async () => snapshot(structuredClone(DEFAULTS), calls.length > 1) };
    });
    render(<PricingEditor />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Turn billing v2 on' })).toBeInTheDocument());
    vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole('button', { name: 'Turn billing v2 on' }));
    expect(calls).toHaveLength(1);
    vi.spyOn(window, 'confirm').mockReturnValueOnce(true);
    fireEvent.click(screen.getByRole('button', { name: 'Turn billing v2 on' }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toEqual({ key: 'billing_v2', value: true, confirm: 'billing_v2' });
  });
});
