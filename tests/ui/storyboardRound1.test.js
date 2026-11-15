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
