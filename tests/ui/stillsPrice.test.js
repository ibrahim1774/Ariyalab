// @vitest-environment jsdom
// The Storyboard screen sends the picture price it shows as expected_credits (chat round 2 follow-up).
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

describe('makeStills sends the shown price', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('adds expected_credits only when a price is given', async () => {
    const client = await vi.importActual('../../lib/story/client');
    const fn = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    vi.stubGlobal('fetch', fn);
    await client.makeStills('p1', ['s1', 's2'], 4);
    await client.makeStills('p1', ['s1']);
    expect(JSON.parse(fn.mock.calls[0][1].body)).toEqual({ shotIds: ['s1', 's2'], expected_credits: 4 });
    expect(JSON.parse(fn.mock.calls[1][1].body)).toEqual({ shotIds: ['s1'] });
  });
});

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
const { default: StepStoryboard } = await import('../../components/maker/StepStoryboard');

const project = { id: 'p1', title: 'Fox', style: '3d_family', seconds: 30, aspect: '9:16', quality: 'standard', mode: 'narrated', step: 'storyboard' };
const shot = (i, over = {}) => ({
  id: `s${i}`, project_id: 'p1', ord: i - 1, scene_id: 'sc1', description: `Shot ${i}`, line: `Line ${i}`, seconds: 3, quality: 'standard', source: 'generated',
  still_url: null, clip_url: null, status: 'draft', stale: false, error: null, still_credits: 0, retry_credits: null, ...over,
});

describe('the Storyboard screen sends what its buttons show', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('Make pictures sends the sum of still_credits', async () => {
    client.makeStills.mockResolvedValue({});
    render(<StepStoryboard project={project} shots={[shot(1, { still_credits: 2 }), shot(2, { still_credits: 0 })]} refresh={vi.fn()} onNext={vi.fn()} returnTo="/" />);
    fireEvent.click(screen.getByRole('button', { name: /Make pictures for 2 shots, 2 credits/ }));
    await waitFor(() => expect(client.makeStills).toHaveBeenCalledWith('p1', ['s1', 's2'], 2));
  });

  it('Make it again on one shot sends that shot\'s still_credits', async () => {
    client.makeStills.mockResolvedValue({});
    render(<StepStoryboard project={project} shots={[shot(1, { status: 'still_ready', still_url: '/a.png', still_credits: 2 })]} refresh={vi.fn()} onNext={vi.fn()} returnTo="/" />);
    fireEvent.click(screen.getByRole('button', { name: /Make it again, 2 credits/ }));
    await waitFor(() => expect(client.makeStills).toHaveBeenCalledWith('p1', ['s1'], 2));
  });
});
