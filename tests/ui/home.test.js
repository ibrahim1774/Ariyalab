// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

vi.mock('next/router', () => ({
  useRouter: () => ({ pathname: '/', asPath: '/', push: vi.fn() }),
}));

import Home from '../../pages/index';
import MarketingNav from '../../components/marketing/MarketingNav';
import MarketingFooter from '../../components/marketing/MarketingFooter';
import { PLANS, YEARLY_DISCOUNT, videosFor } from '../../components/marketing/pricingData';

afterEach(cleanup);

function renderPage() {
  return render(
    <>
      <MarketingNav />
      <Home />
      <MarketingFooter />
    </>
  );
}

describe('homepage', () => {
  it('renders all seven sections in order', () => {
    const { container } = renderPage();
    expect(screen.getByRole('banner')).toBeInTheDocument();
    const sections = [...container.querySelectorAll('[data-section]')].map((n) => n.getAttribute('data-section'));
    expect(sections).toEqual(['hero', 'video-rail', 'how-it-works', 'pricing', 'faq', 'closing-cta']);
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();
  });

  it('uses the anchor ids the nav links to', () => {
    const { container } = renderPage();
    for (const id of ['how-it-works', 'pricing', 'faq']) {
      expect(container.querySelector(`section#${id}`)).not.toBeNull();
    }
  });

  it('shows the hero copy and a static counter line when no env count is set', () => {
    renderPage();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Animated story videos for anything you sell');
    expect(screen.getByText('Made for ads, reels and shorts')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /see examples/i })).toBeInTheDocument();
  });

  it('shows monthly then yearly prices', () => {
    renderPage();
    for (const p of ['$29', '$49', '$99']) expect(screen.getByText(p)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /yearly/i }));
    for (const p of ['$23.20', '$39.20', '$79.20']) expect(screen.getByText(p)).toBeInTheDocument();
    expect(screen.getAllByText(/about \d+ videos/i)).toHaveLength(3);
  });

  it('has eight FAQ questions', () => {
    const { container } = renderPage();
    const faq = container.querySelector('#faq');
    expect(within(faq).getAllByRole('button')).toHaveLength(8);
  });

  it('contains no forbidden words, bare "free", or dashes used as punctuation', () => {
    const { container } = renderPage();
    // Open every FAQ answer so the panels count too.
    container.querySelectorAll('#faq [hidden]').forEach((n) => n.removeAttribute('hidden'));
    const text = container.textContent;
    expect(text).not.toMatch(/pixar|disney/i);
    expect(text).not.toMatch(/\bfree\b/i);
    expect(text).not.toMatch(/[–—]| - /);
  });
});

describe('pricing data', () => {
  it('matches the starting plans', () => {
    expect(PLANS.starter).toEqual({ usd: 29, credits: 1500 });
    expect(PLANS.creator).toEqual({ usd: 49, credits: 2600 });
    expect(PLANS.studio).toEqual({ usd: 99, credits: 5400 });
    expect(YEARLY_DISCOUNT).toBe(0.2);
    expect(videosFor(1500)).toBe(2);
    expect(videosFor(5400)).toBe(7);
  });
});
