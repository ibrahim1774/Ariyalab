// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// Every client function becomes a mock; the error class stays real.
vi.mock('../../lib/story/client', async (importOriginal) => {
  const actual = await importOriginal();
  const mocked = {};
  for (const [key, value] of Object.entries(actual)) {
    mocked[key] = typeof value === 'function' && key !== 'StoryApiError' && key !== 'normalizeError' ? vi.fn() : value;
  }
  return mocked;
});
const routerMock = { replace: vi.fn(async () => true), isReady: true, query: {}, asPath: '/app/new', pathname: '/app/new' };
vi.mock('next/router', () => ({ useRouter: () => routerMock }));

const client = await import('../../lib/story/client');
const { StoryApiError } = client;
const { creditsForVideo, QUALITY_LABELS } = await import('../../lib/pricingConstants');
const { describeError } = await import('../../components/maker/errors');
const { default: ErrorNotice } = await import('../../components/maker/ErrorNotice');
const { default: MakerPage } = await import('../../components/maker/MakerPage');
const { default: QuoteBar } = await import('../../components/maker/QuoteBar');
const { default: useProject } = await import('../../components/maker/useProject');
const { default: StepStart } = await import('../../components/maker/StepStart');
const { default: StepPurpose } = await import('../../components/maker/StepPurpose');
const { default: StepStyle } = await import('../../components/maker/StepStyle');
const { default: StepLength } = await import('../../components/maker/StepLength');
const { default: StepScript } = await import('../../components/maker/StepScript');
const { default: StepCast } = await import('../../components/maker/StepCast');
const { default: StepStoryboard } = await import('../../components/maker/StepStoryboard');
const { default: StepGenerate } = await import('../../components/maker/StepGenerate');
const { default: StepReview } = await import('../../components/maker/StepReview');
const slots = await import('../../components/maker/slots');
const { default: NewVideoPage } = await import('../../pages/app/new');
const { FORBIDDEN_NAMES } = await import('../../lib/story/script.js');

const project = (over = {}) => ({
  id: 'p1', title: 'Fox and the moon', purpose: 'app', offer: 'A booking app', audience: 'Busy owners', style: 'clay',
  seconds: 45, aspect: '9:16', quality: 'pro_narrated', mode: 'narrated', step: 'storyboard', fee_charged: false,
  files_expire_at: null, reference_id: null, ...over,
});
const shot = (i, over = {}) => ({
  id: `s${i}`, project_id: 'p1', ord: i - 1, scene_id: 's1', description: `Shot ${i} description`, line: `Line ${i}`, seconds: 5,
  quality: 'pro_narrated', source: 'generated', still_url: `/api/mock/storage/still-${i}.png`, clip_url: null, status: 'still_ready', stale: false, error: null, ...over,
});
const status = (over = {}) => ({ project: project(), shots: [], cast: [], jobs: [], balance: null, render: null, ...over });

beforeEach(() => {
  for (const fn of Object.values(client)) if (typeof fn?.mockReset === 'function') fn.mockReset();
  client.getBilling.mockResolvedValue({ v2: true, balance: { plan: 1000, topup: 0, held: 0, available: 1000 }, history: [] });
  client.getQuote.mockRejectedValue(new StoryApiError({ status: 404, code: 'not_found' }));
  client.getStatus.mockResolvedValue(status());
  routerMock.replace.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

describe('stepper', () => {
  it('follows Project.step, marks stale steps with a badge and lets earlier steps be opened', async () => {
    client.getStatus.mockResolvedValue(status({ project: project({ step: 'cast' }), shots: [shot(1, { stale: true })] }));
    render(<MakerPage id="p1" returnTo="/app/p/p1" />);
    const stateOf = (name) => screen.getByRole('button', { name: new RegExp(name) }).closest('li').getAttribute('data-state');
    await waitFor(() => expect(stateOf('Cast')).toBe('current'));
    expect(stateOf('Script')).toBe('done');
    expect(stateOf('Storyboard')).toBe('stale');
    expect(screen.getByText('Needs update')).toBeInTheDocument();
    expect(stateOf('Generate')).toBe('upcoming');
    // Later steps are locked, earlier ones open.
    expect(screen.getByRole('button', { name: /Generate/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /Purpose/ }));
    expect(await screen.findByText(/What is this video/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Purpose/ })).toHaveAttribute('aria-current', 'step');
  });

  it('shows the breakdown step only for a project started from a video', async () => {
    client.getStatus.mockResolvedValue(status({ project: project({ step: 'script', reference_id: 'r1' }) }));
    client.getScript.mockResolvedValue(null);
    render(<MakerPage id="p1" returnTo="/app/p/p1" />);
    expect(await screen.findByRole('button', { name: /Breakdown/ })).toBeInTheDocument();
    cleanup();
    client.getStatus.mockResolvedValue(status({ project: project({ step: 'script', reference_id: null }) }));
    render(<MakerPage id="p1" returnTo="/app/p/p1" />);
    await screen.findByRole('button', { name: /Script/ });
    expect(screen.queryByRole('button', { name: /Breakdown/ })).toBeNull();
  });

  it('shows the quote bar from the length step on, not before', async () => {
    client.getStatus.mockResolvedValue(status({ project: project({ step: 'brief', purpose: null, style: null }) }));
    render(<MakerPage id="p1" returnTo="/app/p/p1" />);
    await screen.findByText(/What is this video/);
    expect(screen.queryByTestId('quote-bar')).toBeNull();
    cleanup();
    client.getStatus.mockResolvedValue(status({ project: project({ step: 'brief', purpose: 'app', style: 'clay' }) }));
    render(<MakerPage id="p1" returnTo="/app/p/p1" />);
    expect(await screen.findByTestId('quote-bar')).toBeInTheDocument();
  });
});

describe('generate', () => {
  const props = (shots) => ({ project: project({ step: 'generate' }), shots, refresh: vi.fn(), onNext: vi.fn(), returnTo: '/app/p/p1' });

  it('is disabled until every generated shot has a still', () => {
    const { rerender } = render(<StepGenerate {...props([shot(1), shot(2, { still_url: null, status: 'draft' })])} />);
    expect(screen.getByTestId('generate-all')).toBeDisabled();
    expect(screen.getByTestId('generate-blocked')).toHaveTextContent('1 shot needs a picture');
    rerender(<StepGenerate {...props([shot(1), shot(2)])} />);
    expect(screen.getByTestId('generate-all')).toBeEnabled();
  });

  it('does not wait for a shot that uses the customer footage', () => {
    render(<StepGenerate {...props([shot(1), shot(2, { source: 'footage', still_url: null, status: 'draft' })])} />);
    expect(screen.getByTestId('generate-all')).toBeEnabled();
  });

  it('is disabled when there are no shots', () => {
    render(<StepGenerate {...props([])} />);
    expect(screen.getByTestId('generate-all')).toBeDisabled();
  });

  it('confirm modal lists the quote, shows the balance after, and posts the quoted total', async () => {
    client.getQuote.mockResolvedValue({ total: 777, lines: [{ label: 'Project setup', credits: 90 }, { label: '2 shots, Pro narrated', credits: 687 }], holdNeeded: 777 });
    client.startGeneration.mockResolvedValue({ started: 2 });
    const p = props([shot(1), shot(2)]);
    render(<StepGenerate {...p} />);
    fireEvent.click(screen.getByTestId('generate-all'));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Project setup')).toBeInTheDocument();
    expect(within(dialog).getByTestId('confirm-total')).toHaveTextContent('777 credits');
    expect(within(dialog).getByTestId('confirm-after')).toHaveTextContent('223');
    expect(client.getQuote).toHaveBeenCalledWith('p1', ['s1', 's2']);
    fireEvent.click(within(dialog).getByRole('button', { name: /Generate for 777 credits/ }));
    await waitFor(() => expect(client.startGeneration).toHaveBeenCalledWith('p1', ['s1', 's2'], 777));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(p.refresh).toHaveBeenCalled();
  });

  it('cannot be confirmed when the balance is short, and offers a top up', async () => {
    client.getBilling.mockResolvedValue({ v2: true, balance: { available: 500 }, history: [] });
    client.getQuote.mockResolvedValue({ total: 777, lines: [], holdNeeded: 777 });
    render(<StepGenerate {...props([shot(1)])} />);
    fireEvent.click(screen.getByTestId('generate-all'));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/You need 277 more credits/)).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: 'Top up credits' })).toHaveAttribute('href', '/app/billing');
    expect(within(dialog).getByRole('button', { name: /Generate for 777/ })).toBeDisabled();
  });

  it('shows a 402 from the server as a top up prompt inside the modal', async () => {
    client.getQuote.mockResolvedValue({ total: 300, lines: [], holdNeeded: 300 });
    client.startGeneration.mockRejectedValue(new StoryApiError({ status: 402, code: 'insufficient_credits', needed: 300, available: 120 }));
    render(<StepGenerate {...props([shot(1)])} />);
    fireEvent.click(screen.getByTestId('generate-all'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(await within(dialog).findByRole('button', { name: /Generate for 300/ }));
    expect(await within(dialog).findByText(/You need 180 more credits/)).toBeInTheDocument();
  });

  it('shows progress per shot and the reason a shot was blocked, with a retry', async () => {
    const shots = [shot(1, { status: 'ready', clip_url: '/c1.mp4' }), shot(2, { status: 'generating' }), shot(3, { status: 'blocked', error: 'This picture was not allowed. Change the description.' })];
    client.getQuote.mockResolvedValue({ total: 50, lines: [], holdNeeded: 50 });
    render(<StepGenerate {...props(shots)} />);
    expect(screen.getByTestId('generate-progress')).toHaveTextContent('1 of 3 shots ready, 1 in progress');
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '1');
    expect(screen.getByText('This picture was not allowed. Change the description.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(client.getQuote).toHaveBeenCalledWith('p1', ['s3']));
  });
});

describe('review', () => {
  it('plays finished clips and shows the re-roll allowance from the status payload', async () => {
    client.rerollShot.mockResolvedValue({});
    const shots = [shot(1, { status: 'ready', clip_url: '/c1.mp4' }), shot(2, { status: 'ready', clip_url: '/c2.mp4' })];
    const refresh = vi.fn();
    const { container } = render(
      <StepReview project={project({ step: 'review' })} shots={shots} status={{ shots, project: project({ rerolls_used: 0 }), rerolls: { included: 2, used: 1, credits: 70 } }} refresh={refresh} onNext={vi.fn()} returnTo="/" />,
    );
    expect(container.querySelectorAll('video')).toHaveLength(2);
    expect(screen.getAllByTestId('reroll-info')[0]).toHaveTextContent('1 re-roll included, then 70 credits');
    fireEvent.click(screen.getAllByRole('button', { name: 'Re-roll this shot' })[0]);
    await waitFor(() => expect(client.rerollShot).toHaveBeenCalledWith('p1', 's1'));
    expect(refresh).toHaveBeenCalled();
  });

  it('works the allowance out from the project when the payload has none', () => {
    const shots = Array.from({ length: 5 }, (_, i) => shot(i + 1, { status: 'ready', clip_url: '/c.mp4', seconds: 5, quality: 'standard' }));
    render(<StepReview project={project()} shots={shots} status={{ shots, project: project({ rerolls_used: 0 }) }} refresh={vi.fn()} onNext={vi.fn()} returnTo="/" />);
    expect(screen.getAllByTestId('reroll-info')[0]).toHaveTextContent('1 re-roll included, then 55 credits');
  });
});

describe('quote bar', () => {
  it('shows the creditsForVideo estimate for 45 seconds of Pro narrated, and the shortfall', async () => {
    expect(creditsForVideo({ quality: 'pro_narrated', seconds: 45 })).toBe(720);
    client.getBilling.mockResolvedValue({ v2: true, balance: { available: 500 }, history: [] });
    render(<QuoteBar project={project()} shots={[]} />);
    expect(screen.getByTestId('quote-total')).toHaveTextContent('720 credits');
    expect(screen.getByText(`${QUALITY_LABELS.pro_narrated}, 45 seconds`)).toBeInTheDocument();
    expect(await screen.findByTestId('quote-short')).toHaveTextContent('You need 220 more credits');
    expect(screen.getByRole('link', { name: 'Top up credits' })).toHaveAttribute('href', '/app/billing');
    expect(screen.getByTestId('quote-balance')).toHaveTextContent('500 credits');
  });

  it('leaves out the project fee once it has been paid', () => {
    render(<QuoteBar project={project({ fee_charged: true })} shots={[]} />);
    expect(screen.getByTestId('quote-total')).toHaveTextContent('630 credits');
  });

  it('shows no shortfall when the balance covers it', async () => {
    render(<QuoteBar project={project()} shots={[]} />);
    await screen.findByTestId('quote-balance');
    expect(screen.queryByTestId('quote-short')).toBeNull();
  });

  it('uses the server quote lines once shots exist', async () => {
    client.getQuote.mockResolvedValue({ total: 640, lines: [{ label: 'Project setup', credits: 90 }, { label: 'Video', credits: 550 }], holdNeeded: 640 });
    render(<QuoteBar project={project()} shots={[shot(1)]} />);
    await waitFor(() => expect(screen.getByTestId('quote-total')).toHaveTextContent('640 credits'));
    expect(screen.getByText('Quote for this video')).toBeInTheDocument();
    expect(screen.getByText('Video')).toBeInTheDocument();
  });

  it('skips the shortfall while billing v2 is off, since the balance is in another unit', async () => {
    client.getBilling.mockResolvedValue({ v2: false, balance: { available: 3 }, history: [] });
    render(<QuoteBar project={project()} shots={[]} />);
    await screen.findByTestId('quote-balance');
    expect(screen.queryByTestId('quote-short')).toBeNull();
  });
});

describe('brief steps', () => {
  it('hides offer and audience for the purpose "story"', () => {
    render(<StepPurpose project={project({ purpose: null, offer: null })} save={vi.fn()} onNext={vi.fn()} />);
    fireEvent.click(screen.getByRole('radio', { name: /A product/ }));
    expect(screen.getByLabelText('What are you offering?')).toBeInTheDocument();
    expect(screen.getByLabelText('Who is it for?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /Just a story/ }));
    expect(screen.queryByLabelText('What are you offering?')).toBeNull();
    expect(screen.queryByLabelText('Who is it for?')).toBeNull();
  });

  it('gives every purpose a one line helper and saves the choice with offer and audience', async () => {
    const save = vi.fn().mockResolvedValue({});
    const onNext = vi.fn();
    render(<StepPurpose project={project({ purpose: null, offer: null, audience: null })} save={save} onNext={onNext} />);
    expect(screen.getAllByRole('radio')).toHaveLength(6);
    fireEvent.click(screen.getByRole('radio', { name: /An app or software/ }));
    fireEvent.change(screen.getByLabelText('What are you offering?'), { target: { value: ' A booking app ' } });
    fireEvent.change(screen.getByLabelText('Who is it for?'), { target: { value: 'Barbers' } });
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
    await waitFor(() => expect(save).toHaveBeenCalledWith({ purpose: 'app', offer: 'A booking app', audience: 'Barbers' }));
    expect(onNext).toHaveBeenCalled();
  });

  it('shows a moderation message next to the offer field', async () => {
    const save = vi.fn().mockRejectedValue(new StoryApiError({ status: 422, code: 'validation_failed', message: 'offer must be at most 1000 characters.', field: 'offer' }));
    render(<StepPurpose project={project({ purpose: 'app' })} save={save} onNext={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('offer must be at most 1000 characters.');
    expect(alert.closest('label')).toHaveTextContent('What are you offering?');
  });

  it('shows every preset as a card with its sample image at /styles/<key>.jpg, lazy loaded', () => {
    const { container } = render(<StepStyle project={project({ style: null })} save={vi.fn()} onNext={vi.fn()} />);
    expect(screen.getByRole('radio', { name: '3D animated family film' })).toBeInTheDocument();
    expect(screen.getAllByRole('radio').length).toBe(8);
    for (const key of ['3d_family', '2d_cartoon', 'anime', 'clay', 'comic', 'flat_motion', 'watercolor', 'custom']) {
      const img = container.querySelector(`img[src="/styles/${key}.jpg"]`);
      expect(img, key).not.toBeNull();
      expect(img.getAttribute('alt')).toBeTruthy();
      expect(img).toHaveAttribute('loading', 'lazy');
    }
    expect(container.querySelector('img[src="/styles/clay.jpg"]')).toHaveAttribute('alt', 'Clay');
  });

  it('maps the eight style keys to eight distinct image paths, each from its own key', async () => {
    const { STYLES } = await import('../../lib/story/prompts/styles');
    const { styleImageSrc } = await import('../../components/maker/Tiles');
    const keys = Object.keys(STYLES);
    expect(keys).toHaveLength(8);
    const paths = keys.map(styleImageSrc);
    expect(new Set(paths).size).toBe(8);
    expect(paths).toEqual(keys.map((k) => `/styles/${k}.jpg`));
    const { container } = render(<StepStyle project={project({ style: null })} save={vi.fn()} onNext={vi.fn()} />);
    for (const k of keys) expect(container.querySelector(`input[value="${k}"]`).closest('label').querySelector('img')).toHaveAttribute('src', `/styles/${k}.jpg`);
  });

  it('states the chosen style by name on the cast and storyboard steps', () => {
    const p = project({ style: '3d_family' });
    const { unmount } = render(<StepCast project={p} cast={[]} jobs={[]} refresh={vi.fn()} onNext={vi.fn()} returnTo="/" />);
    expect(screen.getByTestId('style-note')).toHaveTextContent('Style: 3D animated family film');
    unmount();
    render(<StepStoryboard project={p} shots={[shot(1)]} refresh={vi.fn()} onNext={vi.fn()} returnTo="/" />);
    expect(screen.getByTestId('style-note')).toHaveTextContent('Style: 3D animated family film');
  });

  it('falls back to a labelled tile when a style image is missing', () => {
    const { container } = render(<StepStyle project={project({ style: null })} save={vi.fn()} onNext={vi.fn()} />);
    fireEvent.error(container.querySelector('img[src="/styles/anime.jpg"]'));
    expect(container.querySelector('img[src="/styles/anime.jpg"]')).toBeNull();
    const card = screen.getByRole('radio', { name: /Anime/ }).closest('label');
    expect(card.querySelector('[data-tile]')).toHaveTextContent('Anime');
    expect(container.querySelector('img[src="/styles/clay.jpg"]')).not.toBeNull();
  });

  it('asks for the custom style text', () => {
    render(<StepStyle project={project({ style: null })} save={vi.fn()} onNext={vi.fn()} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Your own style' }));
    expect(screen.getByRole('button', { name: /Continue/ })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Describe your style'), { target: { value: 'Soft paper shapes' } });
    expect(screen.getByRole('button', { name: /Continue/ })).toBeEnabled();
  });

  it('Pro talking sets mode talking; the other two set narrated; Economy is not offered', async () => {
    const save = vi.fn().mockResolvedValue({});
    render(<StepLength project={project({ quality: 'standard' })} save={save} onNext={vi.fn()} />);
    expect(screen.queryByRole('radio', { name: /Economy/ })).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: /Pro talking/ }));
    await waitFor(() => expect(save).toHaveBeenLastCalledWith({ quality: 'pro_talking', mode: 'talking' }));
    fireEvent.click(screen.getByRole('radio', { name: /Pro narrated/ }));
    await waitFor(() => expect(save).toHaveBeenLastCalledWith({ quality: 'pro_narrated', mode: 'narrated' }));
    fireEvent.click(screen.getByRole('radio', { name: /^Standard/ }));
    await waitFor(() => expect(save).toHaveBeenLastCalledWith({ quality: 'standard', mode: 'narrated' }));
  });

  it('offers lengths 15 to 75 and three shapes, saving each choice', async () => {
    const save = vi.fn().mockResolvedValue({});
    render(<StepLength project={project()} save={save} onNext={vi.fn()} />);
    for (const n of [15, 30, 45, 60, 75]) expect(screen.getByRole('radio', { name: `${n} seconds` })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: '60 seconds' }));
    await waitFor(() => expect(save).toHaveBeenLastCalledWith({ seconds: 60 }));
    fireEvent.click(screen.getByRole('radio', { name: /Wide 16:9/ }));
    await waitFor(() => expect(save).toHaveBeenLastCalledWith({ aspect: '16:9' }));
    expect(screen.getByRole('radio', { name: /Wide 16:9/ })).toBeChecked();
  });

  it('puts the choice back and shows the reason when a save fails', async () => {
    const save = vi.fn().mockRejectedValue(new StoryApiError({ status: 422, code: 'validation_failed', message: 'Talking videos need Pro talking.' }));
    render(<StepLength project={project()} save={save} onNext={vi.fn()} />);
    fireEvent.click(screen.getByRole('radio', { name: '60 seconds' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Talking videos need Pro talking.');
    expect(screen.getByRole('radio', { name: '45 seconds' })).toBeChecked();
  });
});

describe('waiting, failed and empty states', () => {
  it('shows a generating shot as a skeleton with its status text and script line', () => {
    const shots = [shot(1, { status: 'generating' }), shot(2, { status: 'still_pending', still_url: null }), shot(3, { status: 'queued' })];
    const { container } = render(<StepGenerate project={project({ step: 'generate' })} shots={shots} refresh={vi.fn()} onNext={vi.fn()} returnTo="/" />);
    const cards = [...container.querySelectorAll('[data-shot]')];
    const first = cards[0].querySelector('[data-skeleton]');
    expect(first).not.toBeNull();
    expect(first).toHaveTextContent('Animating this shot');
    expect(first).toHaveTextContent('Line 1');
    expect(cards[1].querySelector('[data-skeleton]')).toHaveTextContent('Sketching this shot');
    expect(cards[1].querySelector('[data-skeleton]')).toHaveTextContent('Line 2');
    expect(cards[2].querySelector('[data-skeleton]')).toHaveTextContent('Animating this shot');
  });

  it('shows cast candidates being made as skeletons in the portrait ratio with a status line', () => {
    render(<StepCast project={project()} cast={[{ id: 'c1', name: 'Maya', status: 'pending', candidates: [] }]} jobs={[]} refresh={vi.fn()} onNext={vi.fn()} returnTo="/" />);
    const sk = screen.getAllByTestId('candidate-pending');
    expect(sk).toHaveLength(3);
    expect(sk[0]).toHaveTextContent('Drawing your character');
    expect(sk[0].style.aspectRatio).toBe('3 / 4');
  });

  it('puts the reason, an icon and a retry on a tinted tile for failed and blocked shots', () => {
    const shots = [shot(1, { status: 'failed', error: 'The clip did not finish.' }), shot(2, { status: 'blocked', error: 'Not allowed.' })];
    const { container } = render(<StepGenerate project={project({ step: 'generate' })} shots={shots} refresh={vi.fn()} onNext={vi.fn()} returnTo="/" />);
    const tiles = container.querySelectorAll('[data-tile="error"]');
    expect(tiles).toHaveLength(2);
    expect(tiles[0]).toHaveTextContent('The clip did not finish.');
    expect(tiles[0].querySelector('svg')).not.toBeNull();
    expect(within(tiles[0]).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(tiles[1]).toHaveTextContent('Not allowed.');
  });

  it('gives empty lists a designed empty state with one action', () => {
    const { container } = render(<StepStoryboard project={project()} shots={[]} refresh={vi.fn()} onNext={vi.fn()} returnTo="/" />);
    const empty = container.querySelector('[data-empty]');
    expect(empty).toHaveTextContent('Your shots will appear here once the cast is picked');
    expect(empty.querySelector('[data-tile]')).not.toBeNull();
    expect(within(empty).getAllByRole('button')).toHaveLength(1);
  });

  it('never renders a media card with neither an image, a skeleton nor a labelled tile', async () => {
    const shots = [
      shot(1), shot(2, { status: 'draft', still_url: null }), shot(3, { status: 'still_pending', still_url: null }), shot(4, { status: 'generating' }),
      shot(5, { status: 'failed', error: 'x' }), shot(6, { status: 'blocked' }), shot(7, { status: 'ready', clip_url: '/c.mp4' }),
    ];
    const cands = [{ url: '/a.png', key: 'a' }, { url: '/b.png', key: 'b' }, { url: '/c.png', key: 'c' }];
    const cast = ['draft', 'pending', 'ready', 'failed', 'blocked'].map((st, i) => ({ id: `c${i}`, name: `N${i}`, status: st, candidates: st === 'ready' ? cands : [], chosen_index: null }));
    const common = { project: project(), refresh: vi.fn(), onNext: vi.fn(), save: vi.fn(), returnTo: '/', goTo: vi.fn() };
    client.getScript.mockResolvedValue(null);
    const views = [
      <StepStyle key="1" {...common} />, <StepCast key="2" {...common} cast={cast} jobs={[]} />, <StepCast key="3" {...common} cast={[]} jobs={[]} />,
      <StepStoryboard key="4" {...common} shots={shots} />, <StepStoryboard key="5" {...common} shots={[]} />,
      <StepGenerate key="6" {...common} shots={shots} />, <StepGenerate key="7" {...common} shots={[]} />,
      <StepReview key="8" {...common} shots={shots} status={{ shots, project: project() }} />, <StepReview key="9" {...common} shots={[]} status={{ shots: [], project: project() }} />,
      <StepScript key="10" {...common} />, <StepStart key="11" onCreate={vi.fn()} />,
      <div key="12"><slots.ReferenceBreakdownSlot /><slots.VoiceSoundSlot /><slots.FinishSlot /></div>,
    ];
    let seen = 0;
    for (const view of views) {
      const { container, unmount } = render(view);
      await flush();
      for (const card of container.querySelectorAll('[data-media-card]')) {
        seen += 1;
        expect(card.querySelector('img, [data-skeleton], [data-tile]'), card.outerHTML.slice(0, 120)).not.toBeNull();
      }
      unmount();
    }
    expect(seen).toBeGreaterThan(25);
  });
});

describe('project thumbnails', () => {
  it('uses the first ready still, else the style sample, else a labelled tile', async () => {
    const { default: ProjectCard, thumbnailFor } = await import('../../components/app/ProjectCard');
    expect(thumbnailFor({ thumbnail_url: '/t.png', style: 'clay' })).toBe('/t.png');
    expect(thumbnailFor({ style: 'clay' })).toBe('/styles/clay.jpg');
    expect(thumbnailFor({ style: 'custom' })).toBeNull();
    const { container } = render(<ProjectCard project={{ id: 'p', title: 'T', style: 'custom' }} />);
    expect(container.querySelector('[data-tile="cover"]')).toHaveTextContent('Your own style');
    cleanup();
    const view = render(<ProjectCard project={{ id: 'p', title: 'T', style: 'clay' }} />);
    const img = view.container.querySelector('img');
    expect(img).toHaveAttribute('src', '/styles/clay.jpg');
    fireEvent.error(img);
    expect(view.container.querySelector('[data-tile="cover"]')).toHaveTextContent('Clay');
  });
});

describe('/app/new', () => {
  it('creates nothing on load, and creates the project on submit', async () => {
    client.createProject.mockResolvedValue({ id: 'new1' });
    render(<NewVideoPage />);
    await flush();
    expect(client.createProject).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Start my video/ })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Describe it'), { target: { value: 'A baker whose bread can talk.\nIt is shy.' } });
    fireEvent.click(screen.getByRole('button', { name: /Start my video/ }));
    await waitFor(() => expect(client.createProject).toHaveBeenCalledWith({ title: 'A baker whose bread can talk.', offer: 'A baker whose bread can talk.\nIt is shy.' }));
    await waitFor(() => expect(routerMock.replace).toHaveBeenCalledWith('/app/p/new1'));
    expect(client.createProject).toHaveBeenCalledTimes(1);
  });
});

describe('script step', () => {
  const script = (over = {}) => ({
    id: 'sc1', version: 1,
    scenes: [
      { id: 's1', title: 'The knock', visual: 'A fox at a door', lines: [{ speaker: 'narrator', text: 'Someone knocked at midnight.' }] },
      { id: 's2', title: 'The moon', visual: 'The moon over a hill', lines: [{ speaker: 'narrator', text: 'It was a long night.' }] },
    ],
    violations: [
      { sceneId: 's2', rule: 'dash', message: 'Line 1 has a dash. Say it with a comma or a new sentence.' },
      { sceneId: null, rule: 'word_budget', message: 'The script is a little long for 45 seconds.' },
    ],
    ...over,
  });

  it('shows each server violation as a plain warning on its own scene, and the general ones on top', async () => {
    client.getScript.mockResolvedValue(script());
    render(<StepScript project={project({ step: 'script' })} refresh={vi.fn()} onNext={vi.fn()} returnTo="/" />);
    const s2 = (await screen.findByText('Line 1 has a dash. Say it with a comma or a new sentence.')).closest('[data-scene]');
    expect(s2).toHaveAttribute('data-scene', 's2');
    const s1 = document.querySelector('[data-scene="s1"]');
    expect(within(s1).queryByText(/dash/)).toBeNull();
    expect(screen.getByText('The script is a little long for 45 seconds.').closest('[data-scene]')).toBeNull();
    // Warnings never block moving on.
    expect(screen.getByRole('button', { name: /Continue to the cast/ })).toBeEnabled();
  });

  it('saves a scene edit with its own saving state', async () => {
    client.getScript.mockResolvedValue(script({ violations: [] }));
    let resolveSave;
    client.updateScene.mockImplementation(() => new Promise((r) => { resolveSave = r; }));
    render(<StepScript project={project({ step: 'script' })} refresh={vi.fn()} onNext={vi.fn()} returnTo="/" />);
    const visual = await screen.findByLabelText('Scene 1 visual');
    fireEvent.change(visual, { target: { value: 'A fox at a red door' } });
    fireEvent.blur(visual);
    await waitFor(() => expect(client.updateScene).toHaveBeenCalledWith('p1', 's1', expect.objectContaining({ visual: 'A fox at a red door', lines: [{ speaker: 'narrator', text: 'Someone knocked at midnight.' }] })));
    const card = document.querySelector('[data-scene="s1"]');
    expect(card).toHaveAttribute('data-save-state', 'saving');
    expect(within(card).getByText('Saving…')).toBeInTheDocument();
    expect(document.querySelector('[data-scene="s2"]')).toHaveAttribute('data-save-state', 'idle');
    await act(async () => resolveSave({ script: script({ violations: [] }), changedSceneIds: ['s1'] }));
    expect(await within(card).findByText('Saved')).toBeInTheDocument();
  });

  it('sends a revise note and replaces the script', async () => {
    client.getScript.mockResolvedValue(script({ violations: [] }));
    client.reviseScript.mockResolvedValue({ script: script({ violations: [], scenes: [{ id: 's1', title: 'New opening', visual: 'x', lines: [] }] }), changedSceneIds: ['s1'] });
    render(<StepScript project={project({ step: 'script' })} refresh={vi.fn()} onNext={vi.fn()} returnTo="/" />);
    fireEvent.change(await screen.findByLabelText('Revise with a note'), { target: { value: 'Make the opening funnier.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Revise script' }));
    await waitFor(() => expect(client.reviseScript).toHaveBeenCalledWith('p1', 'Make the opening funnier.'));
    expect(await screen.findByDisplayValue('New opening')).toBeInTheDocument();
  });

  it('offers to write the script when there is none, and shows a plan prompt on 402 plan_required', async () => {
    client.getScript.mockResolvedValue(null);
    client.writeScript.mockRejectedValue(new StoryApiError({ status: 402, code: 'plan_required', message: 'Pick a plan to write a script.' }));
    render(<StepScript project={project({ step: 'brief' })} refresh={vi.fn()} onNext={vi.fn()} returnTo="/" />);
    fireEvent.click(await screen.findByRole('button', { name: /Write my script/ }));
    expect(await screen.findByText('This step needs a plan')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See plans' })).toHaveAttribute('href', '/app/billing');
  });
});

describe('cast step', () => {
  const props = (cast, extra = {}) => ({ project: project({ step: 'cast' }), cast, jobs: [], refresh: vi.fn(), onNext: vi.fn(), returnTo: '/', ...extra });
  const ready = (over = {}) => ({
    id: 'c1', name: 'Maya', description: 'A baker', status: 'ready', chosen_index: null, regens_used: 0,
    candidates: [0, 1, 2].map((i) => ({ url: `/api/mock/storage/c${i}.png`, key: `c${i}`, prompt: 'p' })), ...over,
  });

  it('shows a top up prompt with the shortfall when making the cast needs more credits', async () => {
    client.startCast.mockRejectedValue(new StoryApiError({ status: 402, code: 'insufficient_credits', needed: 300, available: 100 }));
    render(<StepCast {...props([])} />);
    fireEvent.click(screen.getByRole('button', { name: 'Make my cast' }));
    expect(await screen.findByText(/You need 200 more credits/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Top up credits' })).toHaveAttribute('href', '/app/billing');
  });

  it('shows three candidates, picks one, and regenerates with a note', async () => {
    client.pickCast.mockResolvedValue({});
    client.regenCast.mockResolvedValue({});
    render(<StepCast {...props([ready()])} />);
    expect(screen.getAllByRole('img')).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'Pick Maya, option 2' }));
    await waitFor(() => expect(client.pickCast).toHaveBeenCalledWith('p1', 'c1', 1));
    fireEvent.change(screen.getByLabelText('Describe a change'), { target: { value: 'Round glasses' } });
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
    await waitFor(() => expect(client.regenCast).toHaveBeenCalledWith('p1', 'c1', 'Round glasses'));
    expect(screen.getByText(/2 regenerations included for Maya, then 5 credits each/)).toBeInTheDocument();
  });

  it('marks the picked option and leaves the own image control disabled with a marked slot', () => {
    render(<StepCast {...props([ready({ chosen_index: 0 })])} />);
    expect(screen.getByRole('button', { name: 'Maya, option 1, picked' })).toHaveAttribute('aria-pressed', 'true');
    const own = document.querySelector('[data-slot="asset-picker"]');
    expect(own).toBeDisabled();
    expect(own).toHaveTextContent('coming with brand kit');
    expect(screen.getByRole('button', { name: /Continue to the storyboard/ })).toBeEnabled();
  });

  it('shows pending candidates as shimmer, failed with retry, and blocked with the server message', () => {
    const { rerender } = render(<StepCast {...props([ready({ status: 'pending', candidates: [] })])} />);
    expect(screen.getAllByTestId('candidate-pending')).toHaveLength(3);
    rerender(<StepCast {...props([ready({ status: 'failed' })])} />);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    const jobs = [{ kind: 'cast_image', status: 'blocked', payload: { castId: 'c1' }, error: 'That description was not allowed.' }];
    rerender(<StepCast {...props([ready({ status: 'blocked', candidates: [] })], { jobs })} />);
    expect(screen.getByText('That description was not allowed.')).toBeInTheDocument();
  });

  it('says when the files are removed', () => {
    render(<StepCast {...props([ready()], { project: project({ step: 'cast', files_expire_at: '2026-12-14T12:00:00.000Z' }) })} />);
    expect(screen.getByTestId('files-note')).toHaveTextContent('Files are removed on Dec 14, 2026.');
  });
});

describe('storyboard step', () => {
  it('builds the storyboard, then lists shots in order with their details', async () => {
    client.buildShots.mockResolvedValue({});
    const refresh = vi.fn();
    const { rerender } = render(<StepStoryboard project={project()} shots={[]} refresh={refresh} onNext={vi.fn()} returnTo="/" />);
    fireEvent.click(screen.getByRole('button', { name: 'Build my storyboard' }));
    await waitFor(() => expect(client.buildShots).toHaveBeenCalledWith('p1'));
    rerender(<StepStoryboard project={project()} shots={[shot(1), shot(2, { status: 'draft', still_url: null })]} refresh={refresh} onNext={vi.fn()} returnTo="/" />);
    expect(screen.getByText('Line 1')).toBeInTheDocument();
    expect(screen.getAllByText('Pro narrated').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /Make pictures for 1 shot/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Continue to voice and sound/ })).toBeDisabled();
  });

  it('re-rolls a still, edits a description, changes quality', async () => {
    client.makeStills.mockResolvedValue({});
    client.updateShot.mockResolvedValue({});
    render(<StepStoryboard project={project()} shots={[shot(1)]} refresh={vi.fn()} onNext={vi.fn()} returnTo="/" />);
    fireEvent.click(screen.getByRole('button', { name: /Re-roll, 2 credits/ }));
    await waitFor(() => expect(client.makeStills).toHaveBeenCalledWith('p1', ['s1']));
    fireEvent.click(screen.getByRole('button', { name: 'Edit description' }));
    fireEvent.change(screen.getByLabelText('Description of shot 1'), { target: { value: 'A new idea' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(client.updateShot).toHaveBeenCalledWith('p1', 's1', { description: 'A new idea' }));
    fireEvent.change(screen.getByLabelText('Quality'), { target: { value: 'standard' } });
    await waitFor(() => expect(client.updateShot).toHaveBeenCalledWith('p1', 's1', { quality: 'standard' }));
    expect(document.querySelector('[data-slot="asset-picker"]')).toBeDisabled();
  });

  it('keeps a talking project on Pro talking', () => {
    render(<StepStoryboard project={project({ mode: 'talking', quality: 'pro_talking' })} shots={[shot(1, { quality: 'pro_talking' })]} refresh={vi.fn()} onNext={vi.fn()} returnTo="/" />);
    expect(screen.getByLabelText('Quality')).toBeDisabled();
  });
});

describe('errors', () => {
  const at = '/app/p/p1';
  const render1 = (err, extra = {}) => render(<ErrorNotice error={err} returnTo={at} {...extra} />);

  it('401 sends the customer to sign in and back', () => {
    render1(new StoryApiError({ status: 401, code: 'unauthorized' }));
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/sign-in?returnTo=%2Fapp%2Fp%2Fp1');
    expect(describeError(new StoryApiError({ status: 401 }), { returnTo: at }).signIn).toBe(true);
  });

  it('402 insufficient_credits shows the shortfall and a top up link', () => {
    render1(new StoryApiError({ status: 402, code: 'insufficient_credits', needed: 720, available: 500 }));
    expect(screen.getByText('You need 220 more credits. This takes 720 and you have 500.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Top up credits' })).toHaveAttribute('href', '/app/billing');
  });

  it('402 plan_required says the step needs a plan and links to billing', () => {
    render1(new StoryApiError({ status: 402, code: 'plan_required' }));
    expect(screen.getByText('This step needs a plan')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See plans' })).toHaveAttribute('href', '/app/billing');
  });

  it('409 says already in progress and refreshes', () => {
    const onRefresh = vi.fn();
    render1(new StoryApiError({ status: 409, code: 'conflict' }), { onRefresh });
    expect(screen.getByText('Already in progress')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(onRefresh).toHaveBeenCalled();
  });

  it('400 and 422 show the server message', () => {
    render1(new StoryApiError({ status: 422, code: 'validation_failed', message: 'Length must be a whole number from 15 to 75 seconds.' }));
    expect(screen.getByText('Length must be a whole number from 15 to 75 seconds.')).toBeInTheDocument();
    cleanup();
    render1(new StoryApiError({ status: 400, code: 'BLOCKED_NSFW', message: 'That text cannot be used.' }));
    expect(screen.getByText('That text cannot be used.', { selector: 'span' })).toBeInTheDocument();
  });

  it('429 shows the server message', () => {
    render1(new StoryApiError({ status: 429, code: 'daily_limit', message: 'You have made 3 videos today. Come back tomorrow.' }));
    expect(screen.getByText('You have made 3 videos today. Come back tomorrow.')).toBeInTheDocument();
  });

  it('503 says to try again in a moment', () => {
    render1(new StoryApiError({ status: 503, code: 'MODERATION_UNAVAILABLE' }));
    expect(screen.getAllByText('Try again in a moment', { exact: false }).length).toBeGreaterThan(0);
  });

  it('a request that never arrived says so', () => {
    expect(describeError(new StoryApiError({ status: 0, code: 'network' })).message).toMatch(/reach the server/);
  });

  it('only shows a field error next to its own field', () => {
    const err = new StoryApiError({ status: 422, code: 'validation_failed', message: 'Bad offer.', field: 'offer' });
    const { container } = render(<><ErrorNotice error={err} field="audience" /><ErrorNotice error={err} field={null} /></>);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('useProject', () => {
  it('falls back to the project route when /status does not exist, and stops asking for /status', async () => {
    vi.useFakeTimers();
    client.getStatus.mockRejectedValue(new StoryApiError({ status: 404, code: 'not_found', message: 'Unknown action.' }));
    client.getProject.mockResolvedValue(project({ step: 'script' }));
    const { result } = renderHook(() => useProject('p1'));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.project.step).toBe('script');
    expect(result.current.degraded).toBe(true);
    expect(result.current.shots).toEqual([]);
    expect(result.current.error).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(client.getStatus).toHaveBeenCalledTimes(1);
    expect(client.getProject).toHaveBeenCalledTimes(2);
  });

  it('reports a project that does not exist', async () => {
    vi.useFakeTimers();
    client.getStatus.mockRejectedValue(new StoryApiError({ status: 404, code: 'not_found' }));
    client.getProject.mockRejectedValue(new StoryApiError({ status: 404, code: 'not_found', message: 'Project not found.' }));
    const { result } = renderHook(() => useProject('p1'));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.project).toBeNull();
    expect(result.current.error.status).toBe(404);
  });

  it('polls every 3 seconds while a job runs, then every 15 once they are done', async () => {
    vi.useFakeTimers();
    client.getStatus.mockResolvedValue(status({ jobs: [{ id: 'j1', kind: 'clip', status: 'running' }] }));
    renderHook(() => useProject('p1'));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(client.getStatus).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(2999); });
    expect(client.getStatus).toHaveBeenCalledTimes(1);
    client.getStatus.mockResolvedValue(status({ jobs: [{ id: 'j1', kind: 'clip', status: 'done' }] }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(client.getStatus).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(14999); });
    expect(client.getStatus).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(client.getStatus).toHaveBeenCalledTimes(3);
  });

  it('speeds up again when a queued job appears', async () => {
    vi.useFakeTimers();
    client.getStatus.mockResolvedValue(status());
    renderHook(() => useProject('p1'));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    client.getStatus.mockResolvedValue(status({ jobs: [{ id: 'j2', kind: 'still', status: 'queued' }] }));
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(client.getStatus).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(client.getStatus).toHaveBeenCalledTimes(3);
  });

  it('pauses while the tab is hidden, refreshes when it comes back, and stops on unmount', async () => {
    vi.useFakeTimers();
    client.getStatus.mockResolvedValue(status({ jobs: [{ id: 'j1', kind: 'clip', status: 'running' }] }));
    const { unmount } = renderHook(() => useProject('p1'));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const setHidden = (hidden) => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
      document.dispatchEvent(new Event('visibilitychange'));
    };
    setHidden(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(client.getStatus).toHaveBeenCalledTimes(1);
    setHidden(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(client.getStatus).toHaveBeenCalledTimes(2);
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(client.getStatus).toHaveBeenCalledTimes(2);
    delete document.hidden;
  });

  it('merges a saved brief change into the project', async () => {
    client.updateProject.mockResolvedValue(project({ quality: 'pro_talking', mode: 'talking' }));
    const { result } = renderHook(() => useProject('p1'));
    await waitFor(() => expect(result.current.project).not.toBeNull());
    await act(async () => { await result.current.save({ quality: 'pro_talking', mode: 'talking' }); });
    expect(client.updateProject).toHaveBeenCalledWith('p1', { quality: 'pro_talking', mode: 'talking' });
    expect(result.current.project.mode).toBe('talking');
  });
});

describe('slots', () => {
  it('has a clearly marked slot for every later task', () => {
    const { container } = render(
      <>
        <slots.ReferenceBreakdownSlot />
        <slots.VoiceSoundSlot />
        <slots.FinishSlot />
        <slots.ChatPanelSlot />
        <slots.AssetPickerSlot />
        <slots.StartFromVideoSlot />
      </>,
    );
    for (const name of ['reference-breakdown', 'voice-sound', 'finish', 'chat-panel', 'asset-picker', 'start-from-video']) {
      expect(container.querySelector(`[data-slot="${name}"]`)).not.toBeNull();
    }
  });
});

describe('copy rules', () => {
  const BANNED = [
    [/[—–]/, 'a dash used as punctuation'],
    [/\s-\s/, 'a spaced hyphen'],
    [/\bfree\b/i, 'the word free'],
    [/guarantee/i, 'a guarantee'],
    [/\b(results|sales|customers) (are|is) (certain|assured)\b/i, 'a promise of results'],
    [new RegExp(`\\b(${FORBIDDEN_NAMES.map((n) => String(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'i'), 'a studio, character or celebrity name'],
  ];
  const expectClean = (container) => {
    const text = `${container.textContent} ${[...container.querySelectorAll('[placeholder],[aria-label]')].map((e) => `${e.getAttribute('placeholder') || ''} ${e.getAttribute('aria-label') || ''}`).join(' ')}`;
    for (const [re, what] of BANNED) expect(text, `copy has ${what}`).not.toMatch(re);
  };

  it('the forbidden list is not empty, so the check means something', () => {
    expect(FORBIDDEN_NAMES.length).toBeGreaterThan(10);
  });

  it('keeps every step and slot clear of banned wording', async () => {
    const shots = [shot(1), shot(2, { status: 'failed', error: 'The picture could not be made.' }), shot(3, { status: 'ready', clip_url: '/c.mp4' })];
    const cast = [{ id: 'c1', name: 'Maya', description: 'A baker', status: 'ready', chosen_index: 0, regens_used: 0, candidates: [{ url: '/a.png', key: 'a' }] }];
    client.getScript.mockResolvedValue({ id: 'x', version: 1, scenes: [{ id: 's1', title: 'T', visual: 'V', lines: [{ speaker: 'narrator', text: 'Hi' }] }], violations: [] });
    const p = project({ files_expire_at: '2026-12-14T12:00:00.000Z' });
    const common = { project: p, refresh: vi.fn(), onNext: vi.fn(), save: vi.fn(), returnTo: '/' };
    const views = [
      <StepStart key="a" {...common} />, <StepStart key="b" onCreate={vi.fn()} />, <StepPurpose key="c" {...common} />, <StepStyle key="d" {...common} />,
      <StepLength key="e" {...common} />, <StepScript key="f" {...common} />, <StepCast key="g" {...common} cast={cast} jobs={[]} />,
      <StepCast key="g2" {...common} cast={[]} jobs={[]} />, <StepStoryboard key="h" {...common} shots={shots} />, <StepStoryboard key="h2" {...common} shots={[]} />,
      <StepGenerate key="i" {...common} shots={shots} />, <StepReview key="j" {...common} shots={shots} status={{ shots, project: p }} />,
      <QuoteBar key="k" project={p} shots={[]} />,
      <div key="l"><slots.ReferenceBreakdownSlot /><slots.VoiceSoundSlot /><slots.FinishSlot /><slots.ChatPanelSlot /><slots.AssetPickerSlot /><slots.StartFromVideoSlot /></div>,
    ];
    for (const view of views) {
      const { container, unmount } = render(view);
      await flush();
      expectClean(container);
      unmount();
    }
    for (const err of [
      new StoryApiError({ status: 401 }), new StoryApiError({ status: 402, code: 'insufficient_credits', needed: 5, available: 1 }),
      new StoryApiError({ status: 402, code: 'plan_required' }), new StoryApiError({ status: 409 }), new StoryApiError({ status: 422 }),
      new StoryApiError({ status: 429 }), new StoryApiError({ status: 503 }), new StoryApiError({ status: 500 }), new StoryApiError({ status: 0 }),
    ]) {
      const { container, unmount } = render(<ErrorNotice error={err} returnTo="/" onRefresh={vi.fn()} />);
      expectClean(container);
      unmount();
    }
  });

  it('keeps the whole maker page clean too', async () => {
    client.getStatus.mockResolvedValue(status({ project: project({ step: 'generate' }), shots: [shot(1), shot(2)] }));
    const { container } = render(<MakerPage id="p1" returnTo="/app/p/p1" />);
    await screen.findByTestId('quote-bar');
    expectClean(container);
  });
});
