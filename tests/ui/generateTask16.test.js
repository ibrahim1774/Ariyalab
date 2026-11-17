// @vitest-environment jsdom
// Task 16: the generate and review screens read the server's prices (clip_credits, reroll_credits, clip_price).
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

vi.mock('../../lib/story/client', async (importOriginal) => {
  const actual = await importOriginal();
  const mocked = {};
  for (const [key, value] of Object.entries(actual)) {
    mocked[key] = typeof value === 'function' && key !== 'StoryApiError' && key !== 'normalizeError' ? vi.fn() : value;
  }
  return mocked;
});

const client = await import('../../lib/story/client');
const { describeError } = await import('../../components/maker/errors');
const { default: StepReview } = await import('../../components/maker/StepReview');
const { default: QuoteBar } = await import('../../components/maker/QuoteBar');
const { startable } = await import('../../components/maker/StepGenerate');
const { rerollInfo, shotCredits } = await import('../../components/maker/steps');
const { DEFAULTS } = await import('../../lib/pricingConstants');

const project = { id: 'p1', title: 'Fox', style: '3d_family', seconds: 30, aspect: '9:16', quality: 'pro_narrated', mode: 'narrated', step: 'review' };
const shot = (i, over = {}) => ({
  id: `s${i}`, ord: i - 1, description: `Shot ${i}`, line: null, seconds: 3, quality: 'pro_narrated', source: 'generated',
  still_url: `/still-${i}.png`, clip_url: `/clip-${i}.mp4`, status: 'ready', stale: false, error: null, ...over,
});

beforeEach(() => {
  for (const fn of Object.values(client)) if (typeof fn?.mockReset === 'function') fn.mockReset();
  client.getPricing.mockResolvedValue(undefined);
});
afterEach(cleanup);

describe('Task 16 maker edits', () => {
  it('Make it again sends the price on the button as expected_credits and shows a paid price', async () => {
    client.rerollShot.mockResolvedValue({});
    const shots = [shot(1, { reroll_credits: 42, clip_price: 42 })];
    render(<StepReview project={project} shots={shots} status={{ shots, project, rerolls: { included: 3, used: 3, left: 0 } }} refresh={vi.fn()} onNext={vi.fn()} returnTo="/" />);
    fireEvent.click(screen.getByRole('button', { name: 'Make it again (42 credits)' }));
    await waitFor(() => expect(client.rerollShot).toHaveBeenCalledWith('p1', 's1', 42));
    expect(screen.getByTestId('reroll-info')).toHaveTextContent('0 tries included, then 42 credits');
  });

  it('says when a remake did not work and the earlier clip was kept', () => {
    const shots = [shot(1, { reroll_credits: 0, error: 'The new clip could not be made, so this shot keeps its earlier clip.' })];
    render(<StepReview project={project} shots={shots} status={{ shots, project, rerolls: { included: 3, used: 1, left: 2 } }} refresh={vi.fn()} onNext={vi.fn()} returnTo="/" />);
    expect(screen.getByTestId('reroll-error')).toHaveTextContent('keeps its earlier clip');
    expect(screen.getByRole('button', { name: 'Continue to finish' })).toBeEnabled();
  });

  it('QuoteBar describes the shots the quote covers, not every shot', async () => {
    client.getBilling.mockResolvedValue({ v2: true, balance: { available: 900 }, history: [] });
    const shots = [shot(1), shot(2), shot(3, { status: 'still_ready', clip_url: null })];
    client.getQuote.mockResolvedValue({ total: 42, lines: [{ label: '1 Pro shot', credits: 42 }], holdNeeded: 42, shotIds: ['s3'] });
    const { unmount } = render(<QuoteBar project={project} shots={shots} />);
    await waitFor(() => expect(screen.getByTestId('quote-sub')).toHaveTextContent('1 shot to make, 3 seconds, Pro'));
    unmount();
    client.getQuote.mockResolvedValue({ total: 0, lines: [], holdNeeded: 0, shotIds: [] });
    render(<QuoteBar project={project} shots={shots.slice(0, 2)} />);
    await waitFor(() => expect(screen.getByTestId('quote-sub')).toHaveTextContent('Every shot is made'));
  });

  it('round 1 G5: once every shot is made the bar shows what was spent, never a bare 0 credits', async () => {
    client.getBilling.mockResolvedValue({ v2: true, balance: { available: 900 }, history: [] });
    client.getQuote.mockResolvedValue({ total: 0, lines: [], holdNeeded: 0, shotIds: [], spent: 174 });
    render(<QuoteBar project={project} shots={[shot(1), shot(2)]} />);
    await waitFor(() => expect(screen.getByTestId('quote-total')).toHaveTextContent('174 credits'));
    expect(screen.getByText('Spent on this video')).toBeInTheDocument();
  });

  it('round 1 G7: the stand-in allowance rounds up like the server', () => {
    const shots = Array.from({ length: 11 }, (_, i) => shot(i + 1));
    expect(rerollInfo({ shots, project: { rerolls_used: 0 } }, shots[0]).left).toBe(3);
  });

  it('round 2 H2: "Spent" only when every shot has its clip; busy and blocked shots say so', async () => {
    client.getBilling.mockResolvedValue({ v2: true, balance: { available: 900 }, history: [] });
    client.getQuote.mockResolvedValue({ total: 0, lines: [], holdNeeded: 0, shotIds: [], spent: 84 });
    const { unmount } = render(<QuoteBar project={project} shots={[shot(1), shot(2, { status: 'generating', clip_url: null })]} />);
    await waitFor(() => expect(screen.getByTestId('quote-sub')).toHaveTextContent('1 shot being made'));
    expect(screen.queryByText('Spent on this video')).toBeNull();
    expect(screen.getByText('Charged so far')).toBeInTheDocument();
    unmount();
    render(<QuoteBar project={project} shots={[shot(1), shot(2, { status: 'blocked', clip_url: null })]} />);
    await waitFor(() => expect(screen.getByTestId('quote-sub')).toHaveTextContent('1 shot needs a new description'));
    expect(screen.queryByText('Spent on this video')).toBeNull();
  });

  it('the client sends expected_credits only when given', async () => {
    const actual = await vi.importActual('../../lib/story/client');
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchMock);
    await actual.rerollShot('p1', 's1', 0);
    await actual.rerollShot('p1', 's1');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ shotId: 's1', expected_credits: 0 });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ shotId: 's1' });
    vi.unstubAllGlobals();
  });

  it('a stale ready clip can be generated again; the server clip_credits wins', () => {
    expect(startable([shot(1, { stale: true })]).map((s) => s.id)).toEqual(['s1']);
    expect(startable([shot(1)])).toEqual([]);
    expect(startable([shot(1, { clip_credits: null, status: 'failed' })])).toEqual([]);
    expect(startable([shot(1, { clip_credits: 0, status: 'failed' })]).map((s) => s.id)).toEqual(['s1']);
  });

  it('prices an economy shot at its 4 second minimum and prefers clip_price', () => {
    expect(shotCredits({ quality: 'economy', seconds: 3 }, DEFAULTS)).toBe(28);
    expect(rerollInfo({ shots: [], rerolls: { included: 1, used: 0 } }, shot(1, { clip_price: 50 })).credits).toBe(50);
  });

  it('needs_rebuild leads to the storyboard', () => {
    const info = describeError({ status: 409, code: 'needs_rebuild', serverMessage: 'Rebuild it.' });
    expect(info.title).toBe('Rebuild the storyboard first');
    expect(info.action).toEqual({ label: 'Go to the storyboard', step: 'storyboard' });
  });
});
