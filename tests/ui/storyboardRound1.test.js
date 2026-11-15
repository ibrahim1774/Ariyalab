// @vitest-environment jsdom
// Task 15 round 1: the storyboard screen shows still prices (S3) and blocked/pending shots behave (S4).
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

vi.mock('../../lib/story/client', async (importOriginal) => {
  const actual = await importOriginal();
  const mocked = {};
  for (const [key, value] of Object.entries(actual)) {
    mocked[key] = typeof value === 'function' && key !== 'StoryApiError' && key !== 'normalizeError' ? vi.fn() : value;
  }
  return mocked;
});
vi.mock('next/router', () => ({ useRouter: () => ({ replace: vi.fn(), isReady: true, query: {}, asPath: '/app/p/p1', pathname: '/app/p/[id]' }) }));

const client = await import('../../lib/story/client');
const { default: ShotCard } = await import('../../components/maker/ShotCard');
const { default: StepStoryboard } = await import('../../components/maker/StepStoryboard');

const project = { id: 'p1', style: '3d_family', seconds: 30, aspect: '9:16', quality: 'standard', mode: 'narrated', step: 'storyboard' };
const shot = (i, over = {}) => ({
  id: `s${i}`, project_id: 'p1', ord: i - 1, description: `Shot ${i}`, line: `Line ${i}`, seconds: 3, quality: 'standard', source: 'generated',
  still_url: null, clip_url: null, status: 'draft', stale: false, error: null, retry_credits: null, still_credits: 0, ...over,
});
const card = (s) => render(<ShotCard shot={s} project={project} onChanged={vi.fn()} returnTo="/" />);

beforeEach(() => {
  for (const fn of Object.values(client)) if (typeof fn?.mockReset === 'function') fn.mockReset();
  client.getPricing?.mockResolvedValue?.(undefined);
});
afterEach(() => cleanup());

describe('shot card prices and states', () => {
  it('Try again shows the price when the retry is paid, and no price when it is free', () => {
    const { unmount } = card(shot(1, { status: 'failed', retry_credits: 2 }));
    expect(screen.getByRole('button', { name: 'Try again (2 credits)' })).toBeInTheDocument();
    unmount();
    card(shot(1, { status: 'failed', retry_credits: 0 }));
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('a blocked shot has no Try again; Edit description opens the edit form', () => {
    card(shot(1, { status: 'blocked', error: 'Blocked.' }));
    expect(screen.queryByRole('button', { name: /Try again/ })).toBeNull();
    const edit = screen.getAllByRole('button', { name: 'Edit description' })[0];
    fireEvent.click(edit);
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('the remake button uses the server price for this shot', () => {
    card(shot(1, { status: 'still_ready', still_url: '/a.png', still_credits: 2 }));
    expect(screen.getByRole('button', { name: 'Make it again, 2 credits' })).toBeInTheDocument();
  });

  it('is locked while its picture is being made', () => {
    card(shot(1, { status: 'still_pending' }));
    expect(screen.getByRole('button', { name: /Make it again/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Edit description' })).toBeDisabled();
  });
});

describe('storyboard batch button', () => {
  it('shows the total price of the pictures it will make when some are paid', () => {
    render(<StepStoryboard project={project} shots={[shot(1, { still_credits: 2 }), shot(2, { still_credits: 2 }), shot(3)]} refresh={vi.fn()} onNext={vi.fn()} returnTo="/" />);
    expect(screen.getByRole('button', { name: 'Make pictures for 3 shots, 4 credits' })).toBeInTheDocument();
  });

  it('shows no price when every picture is free', () => {
    render(<StepStoryboard project={project} shots={[shot(1), shot(2)]} refresh={vi.fn()} onNext={vi.fn()} returnTo="/" />);
    expect(screen.getByRole('button', { name: 'Make pictures for 2 shots' })).toBeInTheDocument();
  });
});

describe('rebuild confirm and length note (round 1 follow-up)', () => {
  const { StoryApiError } = client;

  it('a rebuild that would replace clips asks first, then re-sends with confirm', async () => {
    const { describeError } = await import('../../components/maker/errors');
    client.buildShots
      .mockRejectedValueOnce(new StoryApiError({ status: 409, code: 'rebuild_loses_clips', message: 'x', body: { error: 'rebuild_loses_clips', count: 2 } }))
      .mockResolvedValueOnce({ shots: [] });
    const refresh = vi.fn();
    render(<StepStoryboard project={project} shots={[shot(1, { stale: true, clip_url: '/c.mp4' })]} refresh={refresh} onNext={vi.fn()} returnTo="/" />);
    fireEvent.click(screen.getByRole('button', { name: 'Rebuild storyboard' }));
    expect(await screen.findByText('This rebuild replaces 2 finished clips. Rebuild anyway?')).toBeInTheDocument();
    expect(client.buildShots).toHaveBeenLastCalledWith('p1');
    fireEvent.click(screen.getByRole('button', { name: 'Rebuild anyway' }));
    await vi.waitFor(() => expect(client.buildShots).toHaveBeenLastCalledWith('p1', { confirm: true }));
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(describeError(new StoryApiError({ status: 409, code: 'rebuild_loses_clips' })).title).toBe('Finished clips would be replaced');
  });

  it('shows a one-line note when the shots no longer add up to the length', () => {
    const { rerender } = render(<StepStoryboard project={{ ...project, seconds: 30 }} shots={[1, 2, 3, 4, 5, 6, 7, 8].map((i) => shot(i))} refresh={vi.fn()} onNext={vi.fn()} returnTo="/" />);
    expect(screen.getByText('Your video is now 24 s, shorter than the 30 s you picked')).toBeInTheDocument();
    rerender(<StepStoryboard project={{ ...project, seconds: 24 }} shots={[1, 2, 3, 4, 5, 6, 7, 8].map((i) => shot(i))} refresh={vi.fn()} onNext={vi.fn()} returnTo="/" />);
    expect(screen.queryByText(/Your video is now/)).toBeNull();
  });
});

describe('client', () => {
  it('buildShots sends confirm only when asked', async () => {
    const actual = await vi.importActual('../../lib/story/client');
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ shots: [] }) }));
    vi.stubGlobal('fetch', fetchMock);
    await actual.buildShots('p1');
    await actual.buildShots('p1', { confirm: true });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({});
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ confirm: true });
    vi.unstubAllGlobals();
  });
});

describe('round 2 screen rules', () => {
  it('T3: the Rebuild button shows only when a rebuild would do something', () => {
    const { rerender } = render(<StepStoryboard project={{ ...project, seconds: 6 }} shots={[shot(1, { stale: true, clip_mismatch: true, needs_rebuild: false, still_url: '/a.png' }), shot(2, { still_url: '/b.png' })]} refresh={vi.fn()} onNext={vi.fn()} returnTo="/" />);
    expect(screen.queryByRole('button', { name: 'Rebuild storyboard' })).toBeNull();
    rerender(<StepStoryboard project={{ ...project, seconds: 6 }} shots={[shot(1, { needs_rebuild: true, still_url: '/a.png' }), shot(2, { still_url: '/b.png' })]} refresh={vi.fn()} onNext={vi.fn()} returnTo="/" />);
    expect(screen.getByRole('button', { name: 'Rebuild storyboard' })).toBeInTheDocument();
    rerender(<StepStoryboard project={{ ...project, seconds: 6 }} shots={[shot(1, { stale: true, clip_mismatch: false, still_url: '/a.png' }), shot(2, { still_url: '/b.png' })]} refresh={vi.fn()} onNext={vi.fn()} returnTo="/" />);
    expect(screen.getByRole('button', { name: 'Rebuild storyboard' })).toBeInTheDocument();
  });

  it('T5: the batch button leaves out blocked shots', () => {
    render(<StepStoryboard project={project} shots={[shot(1, { status: 'blocked' }), shot(2), shot(3)]} refresh={vi.fn()} onNext={vi.fn()} returnTo="/" />);
    expect(screen.getByRole('button', { name: 'Make pictures for 2 shots' })).toBeInTheDocument();
  });
});
