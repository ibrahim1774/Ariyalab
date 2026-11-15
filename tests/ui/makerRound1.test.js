// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
const { StoryApiError } = client;
const { describeError } = await import('../../components/maker/errors');
const { default: ErrorNotice } = await import('../../components/maker/ErrorNotice');
const { default: MakerPage } = await import('../../components/maker/MakerPage');
const { default: QuoteBar } = await import('../../components/maker/QuoteBar');
const { PricingProvider } = await import('../../components/maker/PricingContext');
const { default: ShotCard } = await import('../../components/maker/ShotCard');
const { default: StepCast } = await import('../../components/maker/StepCast');
const { default: StepLength } = await import('../../components/maker/StepLength');
const { default: StepScript } = await import('../../components/maker/StepScript');
const { default: StepStoryboard } = await import('../../components/maker/StepStoryboard');
const { default: StepGenerate } = await import('../../components/maker/StepGenerate');
const { default: StepReview } = await import('../../components/maker/StepReview');
const { default: StepPurpose } = await import('../../components/maker/StepPurpose');
const { default: Modal } = await import('../../components/ui/Modal');

const project = (over = {}) => ({
  id: 'p1', title: 'Fox', purpose: 'app', offer: 'x', audience: 'y', style: '3d_family', seconds: 45, aspect: '9:16', quality: 'pro_narrated',
  mode: 'narrated', step: 'storyboard', fee_charged: false, files_expire_at: null, reference_id: null, ...over,
});
const shot = (i, over = {}) => ({
  id: `s${i}`, project_id: 'p1', ord: i - 1, description: `Shot ${i} description`, line: `Line ${i}`, seconds: 5, quality: 'pro_narrated', source: 'generated',
  still_url: `/still-${i}.png`, clip_url: null, status: 'still_ready', stale: false, error: null, ...over,
});

beforeEach(() => {
  for (const fn of Object.values(client)) if (typeof fn?.mockReset === 'function') fn.mockReset();
  client.getBilling.mockResolvedValue({ v2: true, balance: { available: 5000 }, history: [] });
  client.getQuote.mockRejectedValue(new StoryApiError({ status: 404 }));
  client.getPricing.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

describe('style note', () => {
  it('is not inside the step head, so a phone rule that hides the helper text cannot hide it', () => {
    const p = project();
    const { unmount } = render(<StepCast project={p} cast={[]} jobs={[]} refresh={vi.fn()} onNext={vi.fn()} returnTo="/" />);
    expect(screen.getByTestId('style-note').closest('[class*="stepHead"]')).toBeNull();
    unmount();
    render(<StepStoryboard project={p} shots={[shot(1)]} refresh={vi.fn()} onNext={vi.fn()} returnTo="/" />);
    expect(screen.getByTestId('style-note').closest('[class*="stepHead"]')).toBeNull();
  });
});

describe('prices come from the server', () => {
  const pricing = { pricing: { perSecond: { standard: 11, pro_narrated: 20, pro_talking: 21, economy: 8 }, projectFee: 100, stillReroll: 3, castRegen: 7, included: { castRegenPerCharacter: 1 }, freeRerollShare: 0.5 } };

  it('QuoteBar estimate, the picture remake label and the cast text use /pricing', async () => {
    client.getPricing.mockResolvedValue(pricing);
    const cast = [{ id: 'c1', name: 'Maya', status: 'ready', chosen_index: 0, regens_used: 0, candidates: [{ url: '/a.png', key: 'a' }] }];
    render(
      <PricingProvider>
        <QuoteBar project={project()} shots={[]} />
        <ShotCard shot={shot(1)} project={project()} onChanged={vi.fn()} returnTo="/" />
        <StepCast project={project({ step: 'cast' })} cast={cast} jobs={[]} refresh={vi.fn()} onNext={vi.fn()} returnTo="/" />
      </PricingProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('quote-total')).toHaveTextContent('1,000 credits'));
    expect(screen.getByRole('button', { name: /Make it again, 3 credits/ })).toBeInTheDocument();
    expect(screen.getByText(/1 regeneration included for Maya, then 7 credits each/)).toBeInTheDocument();
  });

  it('shows the project fee from /pricing before the first cast', async () => {
    client.getPricing.mockResolvedValue(pricing);
    render(<PricingProvider><StepCast project={project({ step: 'cast' })} cast={[]} jobs={[]} refresh={vi.fn()} onNext={vi.fn()} returnTo="/" /></PricingProvider>);
    expect(await screen.findByText(/setup fee of 100 credits/)).toBeInTheDocument();
  });

  it('falls back to the built in numbers while /pricing has not answered', () => {
    render(<QuoteBar project={project()} shots={[]} />);
    expect(screen.getByTestId('quote-total')).toHaveTextContent('720 credits');
  });
});

describe('error copy by code', () => {
  const e = (status, code, extra = {}) => new StoryApiError({ status, code, ...extra });
  it('daily_limit', () => {
    const d = describeError(e(429, 'daily_limit'));
    expect(d.message).toBe('You have reached today\u2019s limit. Come back tomorrow, or pick a plan for more.');
    expect(d.message).not.toMatch(/\b3\b/);
    expect(d.action).toEqual({ label: 'See plans', href: '/app/billing' });
  });
  it('chat_limit', () => {
    const d = describeError(e(429, 'chat_limit', { message: 'x' }));
    expect(d.message).toBe('This video has used all its included changes.');
    expect(d.action.label).toBe('See plans');
  });
  it('script_blocked shows the server message and leads back to the brief', () => {
    const d = describeError(e(422, 'script_blocked', { message: 'We could not write that. Change the offer and try again.' }));
    expect(d.message).toBe('We could not write that. Change the offer and try again.');
    expect(d.action).toEqual({ label: 'Edit the brief', step: 'purpose' });
  });
  it('provider_failed shows the safe message and offers a retry', () => {
    const d = describeError(e(502, 'provider_failed', { message: 'The picture service is busy.' }));
    expect(d.message).toBe('The picture service is busy.');
    expect(d.action).toEqual({ label: 'Try again', retry: true });
  });
  it('quote_changed says the price changed, not "already in progress"', () => {
    const d = describeError(e(409, 'quote_changed'));
    expect(d.title).toBe('The price changed');
    expect(d.title).not.toMatch(/already/i);
    expect(describeError(e(409, 'conflict')).title).toBe('Already in progress');
  });
  it('renders the retry button and calls onRetry', () => {
    const onRetry = vi.fn();
    render(<ErrorNotice error={e(502, 'provider_failed', { message: 'Busy.' })} onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalled();
  });
});

describe('review clips', () => {
  const ready = (i) => shot(i, { status: 'ready', clip_url: `/clip-${i}.mp4` });
  const props = (shots) => ({ project: project({ step: 'review' }), shots, status: { shots, project: project() }, refresh: vi.fn(), onNext: vi.fn(), returnTo: '/' });

  it('makes the clip the media slot: one video per card, no second picture of the same frame', () => {
    const { container } = render(<StepReview {...props([ready(1), ready(2)])} />);
    for (const card of container.querySelectorAll('[data-shot]')) {
      expect(card.querySelectorAll('video')).toHaveLength(1);
      expect(card.querySelectorAll('img')).toHaveLength(0);
      expect(card.querySelector('video')).toHaveAttribute('poster');
    }
  });

  it('on a phone shows a play button and opens the player only when asked', () => {
    vi.stubGlobal('matchMedia', (q) => ({ matches: /max-width: 760px/.test(q), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
    const { container } = render(<StepReview {...props([ready(1)])} />);
    expect(container.querySelectorAll('video')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Play clip 1' }));
    expect(container.querySelectorAll('video')).toHaveLength(1);
  });

  it('calls the button "Make it again" and the allowance text avoids the old word', () => {
    render(<StepReview {...props([ready(1)])} />);
    expect(screen.getByRole('button', { name: 'Make it again' })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/re-?roll/i);
  });
});

describe('summary live regions', () => {
  it('announces generation progress once, not once per skeleton', () => {
    const shots = [shot(1, { status: 'generating' }), shot(2, { status: 'generating' }), shot(3, { status: 'queued' }), shot(4, { status: 'ready', clip_url: '/c.mp4' })];
    const { container } = render(<StepGenerate project={project({ step: 'generate' })} shots={shots} refresh={vi.fn()} onNext={vi.fn()} returnTo="/" />);
    expect(container.querySelectorAll('[data-skeleton] [role="status"]')).toHaveLength(0);
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
  });
  it('announces pending cast pictures once', () => {
    const cast = [{ id: 'c1', name: 'Maya', status: 'pending', candidates: [] }, { id: 'c2', name: 'Dre', status: 'pending', candidates: [] }];
    const { container } = render(<StepCast project={project()} cast={cast} jobs={[]} refresh={vi.fn()} onNext={vi.fn()} returnTo="/" />);
    expect(container.querySelectorAll('[data-skeleton] [role="status"]')).toHaveLength(0);
    expect(container.querySelectorAll('[role="status"]').length).toBeLessThanOrEqual(1);
  });
});

describe('script load failure', () => {
  it('shows the error with Retry and does not offer to write a script', async () => {
    client.getScript.mockRejectedValueOnce(new StoryApiError({ status: 503 }));
    render(<StepScript project={project({ step: 'script' })} refresh={vi.fn()} onNext={vi.fn()} returnTo="/" />);
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Write my script/ })).toBeNull();
    client.getScript.mockResolvedValueOnce(null);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: /Write my script/ })).toBeInTheDocument();
  });
});

describe('cast retry rules (round 1)', () => {
  const props = (cast) => ({ project: project(), cast, jobs: [], refresh: vi.fn(), onNext: vi.fn(), returnTo: '/' });
  it('a blocked character has no Try again; Describe a change opens the form', () => {
    render(<StepCast {...props([{ id: 'c1', name: 'Maya', status: 'blocked', candidates: [] }])} />);
    expect(screen.queryByRole('button', { name: /Try again/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Describe a change' }));
    expect(screen.getByRole('button', { name: /Hide options/ })).toHaveAttribute('aria-expanded', 'true');
  });
  it('Try again shows the price after a paid round, and nothing after a free one', () => {
    const { rerender } = render(<StepCast {...props([{ id: 'c1', name: 'Maya', status: 'failed', candidates: [], regens_used: 3 }])} />);
    expect(screen.getByRole('button', { name: 'Try again (5 credits)' })).toBeInTheDocument();
    rerender(<StepCast {...props([{ id: 'c1', name: 'Maya', status: 'failed', candidates: [], regens_used: 2 }])} />);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
  it('describeError has titles for retry_not_available and sheet_limit', () => {
    expect(describeError(new StoryApiError({ status: 409, code: 'retry_not_available', serverMessage: 'x' }))).toMatchObject({ title: 'Nothing to try again', refresh: true });
    expect(describeError(new StoryApiError({ status: 429, code: 'sheet_limit' }))).toMatchObject({ title: 'Character sheet limit reached' });
  });
});

describe('retrying a failed picture is free', () => {
  it('uses retryCast, not cast-regen with an empty note', async () => {
    client.retryCast.mockResolvedValue({});
    const cast = [{ id: 'c1', name: 'Maya', status: 'failed', candidates: [] }];
    render(<StepCast project={project()} cast={cast} jobs={[]} refresh={vi.fn()} onNext={vi.fn()} returnTo="/" />);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(client.retryCast).toHaveBeenCalledWith('p1', 'c1'));
    expect(client.regenCast).not.toHaveBeenCalled();
  });
  it('uses retryStill for a failed still', async () => {
    client.retryStill.mockResolvedValue({});
    render(<StepStoryboard project={project()} shots={[shot(1, { status: 'failed', error: 'x' })]} refresh={vi.fn()} onNext={vi.fn()} returnTo="/" />);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(client.retryStill).toHaveBeenCalledWith('p1', 's1'));
    expect(client.makeStills).not.toHaveBeenCalled();
  });
  it('the client maps them to the same routes with retry:true', async () => {
    const actual = await vi.importActual('../../lib/story/client');
    const fn = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    vi.stubGlobal('fetch', fn);
    await actual.retryCast('p1', 'c1');
    await actual.retryStill('p1', 's1');
    const calls = fn.mock.calls.map(([url, init]) => [init.method, url, JSON.parse(init.body)]);
    expect(calls).toEqual([
      ['POST', '/api/story/projects/p1/cast-regen', { castId: 'c1', retry: true }],
      ['POST', '/api/story/projects/p1/stills', { shotIds: ['s1'], retry: true }],
    ]);
  });
});

describe('confirm modal', () => {
  it('hides the balance after line when the balance is short', async () => {
    client.getBilling.mockResolvedValue({ v2: true, balance: { available: 100 }, history: [] });
    client.getQuote.mockResolvedValue({ total: 300, lines: [{ label: 'x', credits: 300 }] });
    render(<StepGenerate project={project({ step: 'generate' })} shots={[shot(1)]} refresh={vi.fn()} onNext={vi.fn()} returnTo="/" />);
    fireEvent.click(screen.getByTestId('generate-all'));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText(/You need 200 more credits/);
    expect(within(dialog).queryByTestId('confirm-after')).toBeNull();
  });
  it('reloads the quote on quote_changed and says the price changed', async () => {
    client.getQuote.mockResolvedValue({ total: 300, lines: [] });
    client.startGeneration.mockRejectedValue(new StoryApiError({ status: 409, code: 'quote_changed' }));
    render(<StepGenerate project={project({ step: 'generate' })} shots={[shot(1)]} refresh={vi.fn()} onNext={vi.fn()} returnTo="/" />);
    fireEvent.click(screen.getByTestId('generate-all'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(await within(dialog).findByRole('button', { name: /Generate for 300/ }));
    expect(await within(dialog).findByText('The price changed')).toBeInTheDocument();
    await waitFor(() => expect(client.getQuote).toHaveBeenCalledTimes(2));
  });
});

describe('Modal focus', () => {
  it('moves focus in, traps Tab, and returns focus on close', () => {
    function Host() {
      const [open, setOpen] = React.useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Open</button>
          <Modal open={open} onClose={() => setOpen(false)} title="T" footer={<><button>One</button><button>Two</button></>}>body</Modal>
        </>
      );
    }
    render(<Host />);
    const opener = screen.getByRole('button', { name: 'Open' });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole('dialog');
    expect(dialog.contains(document.activeElement)).toBe(true);
    const last = screen.getByRole('button', { name: 'Two' });
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'One' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});

describe('step list and chat sheets', () => {
  it('the step summary keeps its visible text in its name', async () => {
    client.getStatus.mockResolvedValue({ project: project({ step: 'storyboard' }), shots: [shot(1)], cast: [], jobs: [] });
    render(<MakerPage id="p1" returnTo="/app/p/p1" />);
    expect(await screen.findByRole('button', { name: /Step 7 of 11, Storyboard/ })).toBeInTheDocument();
  });
  it('closes the step list on Escape and returns focus to the summary', async () => {
    client.getStatus.mockResolvedValue({ project: project({ step: 'storyboard' }), shots: [shot(1)], cast: [], jobs: [] });
    render(<MakerPage id="p1" returnTo="/app/p/p1" />);
    const summary = await screen.findByRole('button', { name: /Step 7 of 11/ });
    fireEvent.click(summary);
    expect(screen.getByRole('list', { name: 'All steps' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('list', { name: 'All steps' })).toBeNull();
    expect(document.activeElement).toBe(summary);
  });
  it('closes the chat sheet on Escape and returns focus to its button', async () => {
    client.getStatus.mockResolvedValue({ project: project({ step: 'storyboard' }), shots: [shot(1)], cast: [], jobs: [] });
    render(<MakerPage id="p1" returnTo="/app/p/p1" />);
    const toggle = await screen.findByRole('button', { name: 'Chat helper' });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(document.activeElement).toBe(toggle);
  });
});

describe('copy', () => {
  it('the purpose step does not call the video an ad', () => {
    render(<StepPurpose project={project({ purpose: null })} save={vi.fn()} onNext={vi.fn()} />);
    expect(document.body.textContent).not.toMatch(/feeling like an ad/);
    expect(document.body.textContent).toMatch(/tells a story/);
  });
});

describe('stale drafts', () => {
  it('ShotCard takes a new description from the server when the field is not being edited', () => {
    const { rerender } = render(<ShotCard shot={shot(1)} project={project()} onChanged={vi.fn()} returnTo="/" />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit description' }));
    expect(screen.getByLabelText('Description of shot 1')).toHaveValue('Shot 1 description');
    rerender(<ShotCard shot={shot(1, { description: 'Changed by the chat' })} project={project()} onChanged={vi.fn()} returnTo="/" />);
    expect(screen.getByLabelText('Description of shot 1')).toHaveValue('Changed by the chat');
  });
  it('does not overwrite a description the customer is typing', () => {
    const { rerender } = render(<ShotCard shot={shot(1)} project={project()} onChanged={vi.fn()} returnTo="/" />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit description' }));
    const field = screen.getByLabelText('Description of shot 1');
    field.focus();
    fireEvent.change(field, { target: { value: 'My own words' } });
    rerender(<ShotCard shot={shot(1, { description: 'Changed by the chat' })} project={project()} onChanged={vi.fn()} returnTo="/" />);
    expect(screen.getByLabelText('Description of shot 1')).toHaveValue('My own words');
  });
  it('StepLength puts back the last saved choice, not the one from the first render', async () => {
    const save = vi.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(new StoryApiError({ status: 422, code: 'validation_failed', message: 'No.' }));
    render(<StepLength project={project({ seconds: 45 })} save={save} onNext={vi.fn()} />);
    fireEvent.click(screen.getByRole('radio', { name: '60 seconds' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    await flush();
    fireEvent.click(screen.getByRole('radio', { name: '75 seconds' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('radio', { name: '60 seconds' })).toBeChecked();
  });
});

describe('quote strip', () => {
  it('carries a Top up link in the main row and the full shortfall sentence under Details', async () => {
    client.getBilling.mockResolvedValue({ v2: true, balance: { available: 500 }, history: [] });
    const { container } = render(<QuoteBar project={project()} shots={[]} />);
    await screen.findByTestId('quote-short');
    const row = container.querySelector('[class*="row"]');
    expect(within(row).getByRole('link', { name: 'Top up' })).toHaveAttribute('href', '/app/billing');
    expect(container.querySelector('details')).toHaveTextContent('Short by 220 credits');
  });
});

describe('round 2', () => {
  it('daily_limit says what it counts, from the error body', () => {
    const e = (body) => describeError(new StoryApiError({ status: 429, code: 'daily_limit', body }));
    expect(e({ limit: 3, action: 'project_create' }).message).toBe('You have used your 3 new videos for today. Come back tomorrow, or pick a plan for more.');
    expect(e({ limit: 1, action: 'reference_analysis' }).message).toBe('You have used your 1 video analysis for today. Come back tomorrow, or pick a plan for more.');
    expect(e({ limit: 5 }).message).toBe('You have used your 5 tries for today. Come back tomorrow, or pick a plan for more.');
  });

  it('QuoteBar builds its sub-label from the quote and the shots, not the brief', async () => {
    client.getQuote.mockResolvedValue({ total: 510, lines: [{ label: 'Project fee', credits: 90 }, { label: '10 Pro narrated shots', credits: 420 }] });
    const shots = Array.from({ length: 10 }, (_, i) => shot(i + 1, { seconds: 3 }));
    const { rerender } = render(<QuoteBar project={project({ seconds: 75, quality: 'standard' })} shots={shots} />);
    await waitFor(() => expect(screen.getByTestId('quote-total')).toHaveTextContent('510 credits'));
    expect(screen.getByText('10 shots, 30 seconds, Pro narrated')).toBeInTheDocument();
    const mixed = shots.map((s, i) => (i === 0 ? { ...s, quality: 'standard' } : s));
    rerender(<QuoteBar project={project()} shots={mixed} />);
    await waitFor(() => expect(screen.getByText('10 shots, 30 seconds, Mixed quality')).toBeInTheDocument());
  });

  it('useMediaQuery answers from matchMedia on the very first render', async () => {
    vi.stubGlobal('matchMedia', (q) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} }));
    const { default: useMediaQuery } = await import('../../components/maker/useMediaQuery');
    const seen = [];
    function Probe() {
      seen.push(useMediaQuery('(max-width: 760px)'));
      return null;
    }
    render(<Probe />);
    expect(seen[0]).toBe(true);
  });

  it('the style note keeps its extra sentence in a part a phone can hide', () => {
    render(<StepStoryboard project={project()} shots={[shot(1)]} refresh={vi.fn()} onNext={vi.fn()} returnTo="/" />);
    const note = screen.getByTestId('style-note');
    expect(note).toHaveTextContent('Style: 3D animated family film');
    expect(note.querySelector('[class*="styleExtra"]')).toHaveTextContent('Every picture follows it.');
  });

  it('a cast card keeps "Describe a change" behind a toggle button', () => {
    const cast = [{ id: 'c1', name: 'Maya', status: 'ready', chosen_index: 0, regens_used: 0, candidates: [{ url: '/a.png', key: 'a' }] }];
    render(<StepCast project={project()} cast={cast} jobs={[]} refresh={vi.fn()} onNext={vi.fn()} returnTo="/" />);
    const toggle = screen.getByRole('button', { name: 'Change this character' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });
});

describe('round 4', () => {
  it('daily_limit words script_write as per video, other actions as account-wide', () => {
    const e = (body) => describeError(new StoryApiError({ status: 429, code: 'daily_limit', body }));
    expect(e({ limit: 3, action: 'script_write' }).message).toBe(
      'You have rewritten this video\u2019s script 3 times today. Edit the scenes directly, come back tomorrow, or pick a plan for more.'
    );
    expect(e({ limit: 1, action: 'script_write' }).message).toMatch(/this video\u2019s script 1 time today/);
    expect(e({ limit: 3, action: 'project_create' }).message).toBe('You have used your 3 new videos for today. Come back tomorrow, or pick a plan for more.');
  });

  it('QuoteBar marks its sub-label as updating while the quote is older than the shots', async () => {
    client.getQuote.mockResolvedValueOnce({ total: 510, lines: [{ label: 'Project fee', credits: 90 }, { label: '10 Pro narrated shots', credits: 420 }] });
    const shots = Array.from({ length: 10 }, (_, i) => shot(i + 1, { seconds: 3 }));
    const { rerender } = render(<QuoteBar project={project()} shots={shots} />);
    await waitFor(() => expect(screen.getByTestId('quote-total')).toHaveTextContent('510 credits'));
    expect(screen.getByText('10 shots, 30 seconds, Pro narrated')).toBeInTheDocument();

    let resolve;
    client.getQuote.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    const edited = shots.map((s, i) => (i === 0 ? { ...s, quality: 'standard' } : s));
    rerender(<QuoteBar project={project()} shots={edited} />);
    await flush();
    // The old total is still shown, so the label must not describe the new shots.
    expect(screen.getByTestId('quote-total')).toHaveTextContent('510 credits');
    expect(screen.queryByText('10 shots, 30 seconds, Mixed quality')).not.toBeInTheDocument();
    expect(screen.getByTestId('quote-sub')).toHaveTextContent('Updating the quote');

    await act(async () => resolve({ total: 498, lines: [{ label: 'Project fee', credits: 90 }] }));
    await waitFor(() => expect(screen.getByTestId('quote-total')).toHaveTextContent('498 credits'));
    expect(screen.getByTestId('quote-sub')).toHaveTextContent('10 shots, 30 seconds, Mixed quality');
  });
});
