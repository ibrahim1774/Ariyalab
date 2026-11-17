// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, within, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const mocks = vi.hoisted(() => ({ session: null, manifest: [] }));

vi.mock('../../lib/supabase', () => ({
  getBrowserSupabase: () => ({
    auth: {
      getSession: () => Promise.resolve({ data: { session: mocks.session } }),
      getUser: () => Promise.resolve({ data: { user: mocks.session?.user || null } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
  }),
}));

vi.mock('../../public/examples/manifest.json', () => ({ default: mocks.manifest }));

vi.mock('next/router', () => ({
  useRouter: () => ({ pathname: '/', asPath: '/', push: vi.fn() }),
}));

import Home from '../../pages/index';
import MarketingNav from '../../components/marketing/MarketingNav';
import MarketingFooter from '../../components/marketing/MarketingFooter';
import useReveal from '../../components/marketing/useReveal';
import { PLANS, YEARLY_DISCOUNT, videosPerPlan } from '../../components/marketing/pricingData';

afterEach(() => {
  cleanup();
  mocks.session = null;
  mocks.manifest.length = 0;
  delete process.env.NEXT_PUBLIC_VIDEOS_THIS_WEEK;
  vi.unstubAllGlobals();
});

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

  it('shows the product demo right after the hero', () => {
    const { container } = renderPage();
    const demo = container.querySelector('[data-demo]');
    expect(demo).not.toBeNull();
    expect(container.querySelector('[data-section="hero"]').nextElementSibling).toBe(demo);
    expect(demo.querySelector('[data-demo-step]')).toHaveAttribute('aria-hidden', 'true');
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
    // 15% off yearly (owner decision 2026-11-16).
    for (const p of ['$24.65', '$41.65', '$84.15']) expect(screen.getByText(p)).toBeInTheDocument();
    expect(screen.getByText('Billed yearly at $295.80')).toBeInTheDocument();
    expect(screen.getByText(/save 15%/i)).toBeInTheDocument();
    expect(screen.getAllByText(/about \d+ videos? of/i)).toHaveLength(3);
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

describe('what each plan makes', () => {
  const rowCells = (container, seconds) =>
    [...container.querySelector(`[data-matrix] tr[data-seconds="${seconds}"]`).querySelectorAll('td')].map((td) => td.textContent);

  it('defaults to Pro narrated and agrees with the plan cards', () => {
    const { container } = renderPage();
    expect(screen.getByRole('heading', { name: 'What each plan makes' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pro narrated' })).toHaveAttribute('aria-pressed', 'true');
    expect(rowCells(container, 30)).toEqual(['1 video', '2 videos', '6 videos']);
    const cards = [...container.querySelectorAll('[data-plan]')].map((c) => c.textContent);
    expect(cards[0]).toMatch(/About 1 video of 45 seconds/);
    expect(cards[1]).toMatch(/About 2 videos of 45 seconds/);
    expect(cards[2]).toMatch(/About 4 videos of 45 seconds/);
  });

  it('switches quality levels', () => {
    const { container } = renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Standard' }));
    expect(rowCells(container, 30)).toEqual(['2 videos', '3 videos', '7 videos']);
    fireEvent.click(screen.getByRole('button', { name: 'Pro talking' }));
    expect(rowCells(container, 60)).toEqual(['Under 1 video', '1 video', '2 videos']);
  });

  it('explains the levels and the cost line', () => {
    renderPage();
    expect(screen.getByText(/Standard is 720p with a narrator\./)).toBeInTheDocument();
    expect(screen.getByText(/Pro talking is 1080p and the characters speak\./)).toBeInTheDocument();
    expect(screen.getByText(/You always see the exact cost before you generate\./)).toBeInTheDocument();
  });
});

describe('pricing data', () => {
  it('matches the starting plans', () => {
    expect(PLANS.starter).toEqual({ usd: 29, credits: 900 });
    expect(PLANS.creator).toEqual({ usd: 49, credits: 1500 });
    expect(PLANS.studio).toEqual({ usd: 99, credits: 3100 });
    expect(YEARLY_DISCOUNT).toBe(0.15);
    expect(videosPerPlan({ credits: 1500, quality: 'pro_narrated', seconds: 45 })).toBe(2);
    expect(videosPerPlan({ credits: 5400, quality: 'pro_narrated', seconds: 45 })).toBe(7);
  });
});

describe('homepage behaviour', () => {
  it('sends signed-out visitors to sign up and signed-in visitors to the maker', async () => {
    renderPage();
    const link = () => screen.getAllByRole('link', { name: /make your first video/i })[0];
    expect(link()).toHaveAttribute('href', '/sign-up');
    cleanup();
    mocks.session = { user: { id: 'u1' } };
    renderPage();
    await waitFor(() => expect(link()).toHaveAttribute('href', '/app/new'));
  });

  it('shows the live counter line only when the env count is set', () => {
    process.env.NEXT_PUBLIC_VIDEOS_THIS_WEEK = '42';
    renderPage();
    expect(screen.getByText('42 videos made this week')).toBeInTheDocument();
    expect(screen.queryByText('Made for ads, reels and shorts')).toBeNull();
  });

  it('renders video cards from a non-empty manifest', () => {
    mocks.manifest.push({ src: '/examples/a.mp4', poster: '/examples/a.jpg', label: 'Barber shop' });
    const { container } = renderPage();
    const rail = container.querySelector('[data-section="video-rail"]');
    expect(rail.querySelector('video')).not.toBeNull();
    expect(rail.querySelector('video').getAttribute('src')).toBe('/examples/a.mp4');
    expect(rail.querySelector('[role="img"]')).toBeNull();
  });

  it('shows each rail card once under reduced motion and twice otherwise', async () => {
    const matches = (v) => vi.stubGlobal('matchMedia', () => ({ matches: v, addEventListener() {}, removeEventListener() {} }));
    matches(true);
    const a = renderPage();
    expect(a.container.querySelectorAll('[data-section="video-rail"] li')).toHaveLength(7);
    cleanup();
    matches(false);
    const b = renderPage();
    await waitFor(() => expect(b.container.querySelectorAll('[data-section="video-rail"] li')).toHaveLength(14));
    expect(b.container.querySelectorAll('[data-section="video-rail"] li[aria-hidden="true"]')).toHaveLength(7);
  });

  it('has the Online course placeholder and no format-only label', () => {
    renderPage();
    expect(screen.getAllByText('Online course').length).toBeGreaterThan(0);
    expect(screen.queryByText('Ads and reels')).toBeNull();
  });
});

describe('useReveal', () => {
  function Probe() {
    const ref = useReveal();
    return <div ref={ref} data-testid="probe" />;
  }
  function setup(rect) {
    const observe = vi.fn();
    vi.stubGlobal('IntersectionObserver', class { observe = observe; unobserve() {} });
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(rect);
    return observe;
  }

  it('does not hide an element that is already in view', () => {
    const observe = setup({ top: 100, bottom: 400 });
    render(<Probe />);
    expect(screen.getByTestId('probe')).not.toHaveAttribute('data-reveal');
    expect(observe).not.toHaveBeenCalled();
  });

  it('hides then reveals an element below the fold', () => {
    const observe = setup({ top: 5000, bottom: 5300 });
    render(<Probe />);
    expect(screen.getByTestId('probe')).toHaveAttribute('data-reveal', 'pending');
    expect(observe).toHaveBeenCalled();
  });
});
