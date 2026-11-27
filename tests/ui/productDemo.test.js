// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import ProductDemo, { SCENES, IDEA, ASK, LENGTHS, sceneAt } from '../../components/marketing/ProductDemo';
import { creditsForVideo } from '../../lib/pricingConstants';

const ORDER = ['describe', 'script', 'plan', 'watch'];
const LABELS = ['Describe it', 'Check the script', 'Check the plan', 'Watch and fix'];
const startOf = (id) => SCENES.slice(0, SCENES.findIndex((s) => s.id === id)).reduce((n, s) => n + s.ms, 0);
const TOTAL = SCENES.reduce((n, s) => n + s.ms, 0);

function reduceMotion(on) {
  vi.stubGlobal('matchMedia', () => ({ matches: on, addEventListener() {}, removeEventListener() {} }));
}

const win = (container) => container.querySelector('[data-demo-step]');
const step = (container) => win(container).getAttribute('data-demo-step');
const advance = (ms) => act(() => { vi.advanceTimersByTime(ms); });

beforeEach(() => {
  vi.useFakeTimers();
  // jsdom has no media playback.
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('timeline', () => {
  it('runs through the four maker screens in order and lasts 30 to 40 seconds', () => {
    expect(SCENES.map((s) => s.id)).toEqual(ORDER);
    expect(SCENES.map((s) => s.label)).toEqual(LABELS);
    expect(TOTAL).toBeGreaterThanOrEqual(30000);
    expect(TOTAL).toBeLessThanOrEqual(40000);
    expect(sceneAt(0).id).toBe('describe');
    expect(sceneAt(startOf('plan') + 10).id).toBe('plan');
    expect(sceneAt(TOTAL + 5).id).toBe('describe');
  });
});

describe('ProductDemo', () => {
  it('renders the app window, the step rail and a description for screen readers', () => {
    reduceMotion(false);
    const { container } = render(<ProductDemo />);
    expect(container.querySelector('[data-demo]')).not.toBeNull();
    expect(win(container)).toHaveAttribute('aria-hidden', 'true');
    expect(win(container).textContent).toContain('sonallo.com/app');
    const rail = [...container.querySelectorAll('[data-demo-rail] li')];
    expect(rail.map((li) => li.getAttribute('data-step'))).toEqual(ORDER);
    expect(rail.map((li) => li.textContent.replace(/^\d/, ''))).toEqual(LABELS);
    expect(screen.getByText(/demo of making a video with Sonallo/i)).toBeInTheDocument();
  });

  it('types the idea letter by letter', () => {
    reduceMotion(false);
    const { getByTestId } = render(<ProductDemo />);
    const idea = () => getByTestId('demo-idea').textContent;
    expect(idea()).toBe('');
    advance(1000);
    const early = idea().length;
    expect(early).toBeGreaterThan(0);
    expect(IDEA.startsWith(idea())).toBe(true);
    advance(600);
    expect(idea().length).toBeGreaterThan(early);
    advance(startOf('script') - 1700);
    expect(idea()).toBe(IDEA);
  });

  it('advances Describe it through Watch and fix and loops back', () => {
    reduceMotion(false);
    const { container } = render(<ProductDemo />);
    expect(step(container)).toBe('describe');
    let at = 0;
    for (const s of SCENES) {
      advance(startOf(s.id) + 100 - at);
      at = startOf(s.id) + 100;
      expect(step(container)).toBe(s.id);
      expect(container.querySelector(`[data-demo-rail] li[data-step="${s.id}"]`)).toHaveAttribute('data-state', 'current');
    }
    advance(TOTAL - at + 100);
    expect(step(container)).toBe('describe');
  });

  it('shows the real credit cost for 30 seconds of Standard, on every length chip and on the make button', () => {
    reduceMotion(false);
    const { getByTestId, container } = render(<ProductDemo />);
    const credits = creditsForVideo({ quality: 'standard', seconds: 30 });
    expect(getByTestId('demo-cost').textContent).toBe(`${credits.toLocaleString('en-US')} credits`);
    expect(LENGTHS.map((l) => l.label)).toEqual(['7 s', '10 s', '30 s', '60 s', '2 min']);
    for (const l of LENGTHS) {
      expect(l.credits).toBe(creditsForVideo({ quality: 'standard', seconds: l.seconds }));
      expect(container.querySelector(`[data-target="len-${l.seconds}"]`).textContent).toContain(`${l.credits.toLocaleString('en-US')} credits`);
    }
    expect(container.querySelector('[data-target="len-30"]').className).toMatch(/optionOn/);
    expect(container.textContent).toContain('Standard, recommended');
    expect(container.querySelector('[data-target="cta"]').textContent).toContain('Write my script');
    advance(startOf('plan') + 100);
    expect(getByTestId('demo-make').textContent).toBe(`Make my video (${credits} credits)`);
    expect(container.querySelector('[data-target="cta2"]').textContent).toBe('Try scene 1 first');
  });

  it('types a change into the chat and rewrites the first script line', () => {
    reduceMotion(false);
    const { getByTestId, container } = render(<ProductDemo />);
    advance(startOf('script') + 2000);
    const before = getByTestId('demo-line-1').textContent;
    expect(getByTestId('demo-chat-input').textContent).toBe('');
    advance(1500);
    const typed = getByTestId('demo-chat-input').textContent;
    expect(typed.length).toBeGreaterThan(0);
    expect(ASK.startsWith(typed)).toBe(true);
    advance(3000);
    expect(container.textContent).toContain(ASK);
    expect(getByTestId('demo-line-1').textContent).not.toBe(before);
    expect(container.querySelector('[data-target="cta"]').textContent).toContain('Looks good, design my video');
  });

  it('fills the scenes one by one, then shows the strip, Change this scene and Download', () => {
    reduceMotion(false);
    const { container } = render(<ProductDemo />);
    advance(startOf('watch') + 1200);
    const ticks = () => container.querySelectorAll('[data-panel="active"] [data-target^="strip-"] svg').length;
    const early = ticks();
    advance(3000);
    expect(ticks()).toBeGreaterThan(early);
    expect(ticks()).toBe(4);
    advance(4000);
    expect(container.textContent).toContain('Change this scene');
    expect(container.querySelector('[data-target="download"]')).not.toBeNull();
  });

  it('only gives the video a source on the watch screen', () => {
    reduceMotion(false);
    const { container } = render(<ProductDemo />);
    advance(startOf('plan') + 100);
    const early = container.querySelector('video');
    expect(early === null || !early.getAttribute('src')).toBe(true);
    advance(startOf('watch') - startOf('plan'));
    const video = container.querySelector('video');
    expect(video).toHaveAttribute('preload', 'none');
    expect(video.getAttribute('src')).toMatch(/\.mp4$/);
    expect(video.getAttribute('poster')).toMatch(/\.jpg$/);
    expect(video).toHaveAttribute('playsinline');
  });

  it('stops advancing while paused and carries on after play', () => {
    reduceMotion(false);
    const { container } = render(<ProductDemo />);
    advance(startOf('script') + 100);
    expect(step(container)).toBe('script');
    const button = screen.getByRole('button', { name: 'Pause demo' });
    expect(button).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-pressed', 'true');
    advance(20000);
    expect(step(container)).toBe('script');
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-pressed', 'false');
    advance(startOf('plan') - startOf('script'));
    expect(step(container)).toBe('plan');
  });

  it('pauses while the tab is hidden', () => {
    reduceMotion(false);
    const { container } = render(<ProductDemo />);
    advance(startOf('script') + 100);
    const vis = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    advance(20000);
    expect(step(container)).toBe('script');
    vis.mockReturnValue('visible');
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    advance(startOf('plan') - startOf('script'));
    expect(step(container)).toBe('plan');
  });

  it('pauses while off screen', () => {
    reduceMotion(false);
    let callback;
    vi.stubGlobal('IntersectionObserver', class {
      constructor(cb) { callback = cb; }
      observe() {}
      disconnect() {}
    });
    const { container } = render(<ProductDemo />);
    act(() => callback([{ isIntersecting: false }]));
    advance(20000);
    expect(step(container)).toBe('describe');
    act(() => callback([{ isIntersecting: true }]));
    advance(startOf('script') + 100);
    expect(step(container)).toBe('script');
  });

  it('shows the finished frame, the steps and no timers under reduced motion', () => {
    reduceMotion(true);
    const { container } = render(<ProductDemo />);
    expect(vi.getTimerCount()).toBe(0);
    expect(step(container)).toBe('watch');
    expect(container.querySelector('[data-demo-static]')).not.toBeNull();
    expect(container.querySelector('video')).toBeNull();
    expect(container.querySelector('img[src$="skit-3d-barbers.jpg"]')).not.toBeNull();
    expect([...container.querySelectorAll('[data-demo-steps] li')].map((li) => li.textContent)).toEqual(LABELS);
    expect(screen.queryByRole('button', { name: 'Pause demo' })).toBeNull();
    advance(20000);
    expect(step(container)).toBe('watch');
  });

  it('has no forbidden words or dashes in any of its copy', () => {
    reduceMotion(false);
    const { container } = render(<ProductDemo />);
    let text = container.textContent;
    for (let ms = 0; ms < TOTAL; ms += 500) {
      advance(500);
      text += container.textContent;
    }
    expect(text).not.toMatch(/pixar|disney/i);
    expect(text).not.toMatch(/\bfree\b/i);
    expect(text).not.toMatch(/[–—]| - /);
  });
});

describe('polish', () => {
  it('never says "Making scene 4 of 4" once the badge says Ready', () => {
    reduceMotion(false);
    const { container } = render(<ProductDemo />);
    advance(startOf('watch'));
    let sawMaking = false;
    for (let ms = 0; ms < SCENES[3].ms; ms += 50) {
      advance(50);
      const text = container.querySelector('[data-panel="active"]')?.textContent || '';
      if (text.includes('Ready')) expect(text).not.toMatch(/Making scene/);
      if (/Making scene/.test(text)) sawMaking = true;
    }
    expect(sawMaking).toBe(true);
  });

  it('the chat says the video is being made, and says ready only once it is', () => {
    reduceMotion(false);
    const { container } = render(<ProductDemo />);
    advance(startOf('watch') + 200 + 3 * 900 + 400);
    expect(container.textContent).toMatch(/Making your video now/);
    expect(container.textContent).not.toMatch(/Your video is ready/);
    advance(4000);
    expect(container.textContent).toMatch(/Your video is ready/);
    expect(container.textContent).not.toMatch(/Making your video now/);
  });

  it('the badge says Making until the last scene is done', () => {
    reduceMotion(false);
    const { container } = render(<ProductDemo />);
    advance(startOf('watch') + 200 + 3 * 900 + 400);
    const text = container.querySelector('[data-panel="active"]').textContent;
    expect(text).toMatch(/Making scene 4 of 4/);
    expect(text).toMatch(/Making your video/);
    expect(text).not.toMatch(/Ready/);
  });

  it('on loop restart the step and its panel switch together and the first screen was already waiting', () => {
    reduceMotion(false);
    const { container } = render(<ProductDemo />);
    advance(startOf('watch') + 500);
    // While the last screen shows, the first one is already mounted (hidden) so it is never blank on the way in.
    expect(container.querySelector('[data-panel="next"]')).not.toBeNull();
    advance(TOTAL - startOf('watch') - 500 + 60);
    expect(step(container)).toBe('describe');
    const active = container.querySelectorAll('[data-panel="active"]');
    expect(active).toHaveLength(1);
    expect(active[0].textContent).toContain('Describe your video');
    expect(container.querySelector('[data-demo-rail] li[data-state="current"]').getAttribute('data-step')).toBe('describe');
    expect(container.querySelectorAll('[data-demo-rail] li[data-state="current"]')).toHaveLength(1);
    // The old screen is gone from view at once, not left lit under the new one.
    expect(container.querySelector('[data-panel="leaving"]')?.getAttribute('aria-hidden') ?? 'true').toBe('true');
  });
});
