// @vitest-environment jsdom
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
const routerMock = { replace: vi.fn(async () => true), push: vi.fn(async () => true), isReady: true, query: {}, asPath: '/app/p/p1', pathname: '/app/p/[id]' };
vi.mock('next/router', () => ({ useRouter: () => routerMock }));

const client = await import('../../lib/story/client');
const { StoryApiError } = client;
const { DEFAULTS } = await import('../../lib/pricingConstants');
const { default: SimpleMaker } = await import('../../components/simple/SimpleMaker');
const { default: MakerPage } = await import('../../components/maker/MakerPage');
const { lengthCredits } = await import('../../components/simple/derive');

const project = (over = {}) => ({
  id: 'p1', title: 'Barber story', purpose: 'story', offer: 'A barber turns a bad haircut into a comeback', style: '3d_family',
  seconds: 30, aspect: '9:16', quality: 'standard', mode: 'narrated', step: 'script', fee_charged: false, consistent_cast: true,
  files_expire_at: null, reference_id: null, ...over,
});
const status = (over = {}) => ({
  project: project(), shots: [], cast: [], jobs: [], balance: { available: 1500 }, render: null, renders: [], renderPrice: null,
  audio: { applicable: { narration: true, narrationLines: 2 }, narration: { status: 'none', credits: 0 }, music: { type: 'generated', status: 'none', credits: 0 }, plan: {} },
  ...over,
});
const flush = () => act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); });
const fmt = (n) => n.toLocaleString();

beforeEach(() => {
  for (const fn of Object.values(client)) if (typeof fn?.mockReset === 'function') fn.mockReset();
  client.getPricing.mockResolvedValue({ pricing: DEFAULTS });
  client.getBilling.mockResolvedValue({ v2: true, balance: { plan: 1500, topup: 0, held: 0, available: 1500 }, history: [] });
  client.getChat.mockResolvedValue({ messages: [], usage: { used: 0, limit: 150 } });
  client.getStatus.mockResolvedValue(status());
  client.getScript.mockResolvedValue(null);
  routerMock.replace.mockClear();
  routerMock.query = {};
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('shell', () => {
  it('shows the four screens as a stepper and the screen the server state calls for', async () => {
    client.getStatus.mockResolvedValue(status({ project: project({ step: 'brief', purpose: null, style: null }) }));
    render(<SimpleMaker id="p1" returnTo="/app/p/p1" />);
    expect(await screen.findByRole('heading', { name: /Describe your video/ })).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Screens' });
    expect(within(nav).getAllByRole('button').map((b) => b.textContent.replace(/^\d/, ''))).toEqual(['Describe it', 'Check the script', 'Check the plan', 'Watch and fix']);
    expect(within(nav).getByRole('button', { name: /Describe it/ })).toHaveAttribute('aria-current', 'step');
    expect(within(nav).getByRole('button', { name: /Check the script/ })).toBeDisabled();
  });

  it('links to the detailed editor, and the detailed editor links back', async () => {
    render(<SimpleMaker id="p1" returnTo="/app/p/p1" />);
    const link = await screen.findByRole('link', { name: 'Detailed editor' });
    expect(link).toHaveAttribute('href', '/app/p/p1?view=steps');
    cleanup();
    render(<MakerPage id="p1" returnTo="/app/p/p1" />);
    const back = await screen.findByRole('link', { name: 'Back to the simple view' });
    expect(back).toHaveAttribute('href', '/app/p/p1');
  });
});

describe('screen 1, Describe it', () => {
  const noScript = () => client.getStatus.mockResolvedValue(status({ project: project({ step: 'brief', purpose: null, style: null, offer: null, title: 'Untitled video' }) }));

  it('shows each length with its real credits at the chosen quality, and the balance note', async () => {
    noScript();
    client.getBilling.mockResolvedValue({ v2: true, balance: { plan: 900, topup: 0, held: 0, available: 900 }, history: [] });
    render(<SimpleMaker id="p1" returnTo="/app/p/p1" />);
    await screen.findByRole('heading', { name: /Describe your video/ });
    const group = screen.getByRole('group', { name: 'Length' });
    const chip = (label) => within(group).getByRole('radio', { name: new RegExp(`^${label}`) }).closest('label');
    for (const [label, seconds] of [['7 s', 7], ['10 s', 10], ['30 s', 30], ['60 s', 60], ['2 min', 120]]) {
      expect(chip(label)).toHaveTextContent(`${fmt(lengthCredits(DEFAULTS, {}, seconds, 'standard'))} credits`);
    }
    expect(within(group).getByRole('radio', { name: /^30 s/ })).toBeChecked();
    // A Starter sized balance (900 credits) cannot cover 2 minutes: it says so, and the chip stays selectable.
    await waitFor(() => expect(chip('2 min')).toHaveTextContent('needs more credits'));
    expect(chip('30 s')).not.toHaveTextContent('needs more credits');
    expect(within(group).getByRole('radio', { name: /^2 min/ })).toBeEnabled();
    fireEvent.click(within(group).getByRole('radio', { name: /^2 min/ }));
    expect(within(group).getByRole('radio', { name: /^2 min/ })).toBeChecked();
    expect(screen.getByTestId('balance-note')).toHaveTextContent('900 credits');
  });

  it('re-prices the chips when the quality changes', async () => {
    noScript();
    render(<SimpleMaker id="p1" returnTo="/app/p/p1" />);
    await screen.findByRole('heading', { name: /Describe your video/ });
    const group = screen.getByRole('group', { name: 'Length' });
    const before = within(group).getByRole('radio', { name: /^30 s/ }).closest('label').textContent;
    fireEvent.click(screen.getByRole('button', { name: /Change quality/ }));
    fireEvent.click(screen.getByRole('radio', { name: 'Pro' }));
    const after = within(group).getByRole('radio', { name: /^30 s/ }).closest('label').textContent;
    expect(after).not.toBe(before);
    expect(after).toContain(`${fmt(lengthCredits(DEFAULTS, {}, 30, 'pro_narrated'))} credits`);
  });

  it('collapses quality to the chosen card, and the cards say what they are', async () => {
    noScript();
    render(<SimpleMaker id="p1" returnTo="/app/p/p1" />);
    await screen.findByRole('heading', { name: /Describe your video/ });
    const card = screen.getByTestId('quality-chosen');
    expect(card).toHaveTextContent('Standard');
    expect(card).toHaveTextContent('Recommended');
    expect(card).toHaveTextContent('Narrator voiceover');
    expect(card).toHaveTextContent('720p');
    expect(card).toHaveTextContent('Music and captions included');
    expect(card).toHaveTextContent('Kling 3.0');
    expect(card).toHaveTextContent('MP4, 9:16, about 30 seconds');
    fireEvent.click(screen.getByRole('button', { name: /Change quality/ }));
    expect(screen.getAllByRole('radio', { name: /^(Budget|Standard|Pro|Pro talking)$/ })).toHaveLength(4);
  });

  it('shows the style with a thumbnail and opens the style tiles on change', async () => {
    noScript();
    render(<SimpleMaker id="p1" returnTo="/app/p/p1" />);
    await screen.findByRole('heading', { name: /Describe your video/ });
    expect(screen.getByTestId('style-chosen')).toHaveTextContent('3D animated family film');
    fireEvent.click(screen.getByRole('button', { name: /Change style/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('radio', { name: /Anime/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: /Use this style/ }));
    await waitFor(() => expect(screen.getByTestId('style-chosen')).toHaveTextContent('Anime'));
  });

  it('never asks about the purpose', async () => {
    noScript();
    render(<SimpleMaker id="p1" returnTo="/app/p/p1" />);
    await screen.findByRole('heading', { name: /Describe your video/ });
    expect(screen.queryByText(/What is this video/i)).toBeNull();
    expect(screen.queryByLabelText(/purpose/i)).toBeNull();
  });

  it('saves the choices and writes the script on an existing project', async () => {
    noScript();
    client.updateProject.mockResolvedValue(project());
    client.writeScript.mockResolvedValue({ id: 'sc', version: 1, scenes: [], violations: [] });
    render(<SimpleMaker id="p1" returnTo="/app/p/p1" />);
    await screen.findByRole('heading', { name: /Describe your video/ });
    const write = screen.getByRole('button', { name: /Write my script/ });
    expect(write).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Describe your idea'), { target: { value: 'A barber turns a bad haircut into a comeback' } });
    fireEvent.click(screen.getByRole('radio', { name: /^10 s/ }));
    fireEvent.click(screen.getByRole('button', { name: /Write my script/ }));
    await waitFor(() => expect(client.writeScript).toHaveBeenCalledWith('p1'));
    expect(client.updateProject).toHaveBeenCalledWith('p1', expect.objectContaining({
      offer: 'A barber turns a bad haircut into a comeback', style: '3d_family', seconds: 10, quality: 'standard', mode: 'narrated',
    }));
    expect(client.updateProject.mock.invocationCallOrder[0]).toBeLessThan(client.writeScript.mock.invocationCallOrder[0]);
    // The purpose is the server's to decide (the script model picks it): the screen never sends one.
    expect(client.updateProject.mock.calls[0][1]).not.toHaveProperty('purpose');
  });

  it('on /app/new it creates the project only on submit, then writes the script, then opens the project', async () => {
    client.createProject.mockResolvedValue({ id: 'new1' });
    client.writeScript.mockResolvedValue({ id: 'sc', version: 1, scenes: [], violations: [] });
    render(<SimpleMaker id={null} returnTo="/app/new" />);
    await screen.findByRole('heading', { name: /Describe your video/ });
    await flush();
    expect(client.createProject).not.toHaveBeenCalled();
    expect(client.getStatus).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Describe your idea'), { target: { value: 'A baker whose bread can talk.\nIt is shy.' } });
    fireEvent.click(screen.getByRole('button', { name: /Write my script/ }));
    await waitFor(() => expect(routerMock.replace).toHaveBeenCalledWith('/app/p/new1'));
    expect(client.createProject).toHaveBeenCalledTimes(1);
    expect(client.createProject).toHaveBeenCalledWith(expect.objectContaining({
      title: 'A baker whose bread can talk.', offer: 'A baker whose bread can talk.\nIt is shy.', seconds: 30, quality: 'standard', mode: 'narrated', style: '3d_family', aspect: '9:16',
    }));
    expect(client.writeScript).toHaveBeenCalledWith('new1');
  });

  it('a script that fails to write keeps the project and tries again on it, never a second project', async () => {
    client.createProject.mockResolvedValue({ id: 'new1' });
    client.writeScript.mockRejectedValueOnce(new StoryApiError({ status: 503, code: 'busy' })).mockResolvedValue({ id: 'sc', version: 1, scenes: [], violations: [] });
    render(<SimpleMaker id={null} returnTo="/app/new" />);
    await screen.findByRole('heading', { name: /Describe your video/ });
    fireEvent.change(screen.getByLabelText('Describe your idea'), { target: { value: 'A baker whose bread can talk.' } });
    fireEvent.click(screen.getByRole('button', { name: /Write my script/ }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(routerMock.replace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Write my script/ }));
    await waitFor(() => expect(routerMock.replace).toHaveBeenCalledWith('/app/p/new1'));
    expect(client.createProject).toHaveBeenCalledTimes(1);
    expect(client.writeScript).toHaveBeenCalledTimes(2);
  });

  it('offers to start from a video, with the same link and upload pieces', async () => {
    noScript();
    render(<SimpleMaker id="p1" returnTo="/app/p/p1" />);
    await screen.findByRole('heading', { name: /Describe your video/ });
    fireEvent.click(screen.getByRole('button', { name: /Start from a video/ }));
    expect(await screen.findByRole('radio', { name: /Paste a link/ })).toBeInTheDocument();
    expect(screen.getByLabelText('Choose a video file')).toBeInTheDocument();
  });

  it('a project started from a video waits for the breakdown, then writes the script from it', async () => {
    client.getStatus.mockResolvedValue(status({ project: project({ step: 'breakdown', reference_id: 'r1', offer: null, purpose: null }) }));
    client.getReference.mockResolvedValue({ id: 'r1', status: 'pending', beats: [] });
    render(<SimpleMaker id="p1" returnTo="/app/p/p1" />);
    expect((await screen.findAllByText(/Watching your video shot by shot/)).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /Reading your video/ })).toBeDisabled();
    client.getReference.mockResolvedValue({ id: 'r1', status: 'ready', beats: [{ ord: 1 }, { ord: 2 }, { ord: 3 }], hook: 'x', duration: 28 });
    client.updateProject.mockResolvedValue(project());
    client.writeScript.mockResolvedValue({ id: 'sc', version: 1, scenes: [], violations: [] });
    await waitFor(() => expect(screen.getByRole('button', { name: /Write my script/ })).toBeEnabled(), { timeout: 5000 });
    fireEvent.click(screen.getByRole('button', { name: /Write my script/ }));
    await waitFor(() => expect(client.writeScript).toHaveBeenCalledWith('p1'));
    expect(client.updateProject.mock.calls[0][1]).not.toHaveProperty('purpose');
  });
});

// ---------------------------------------------------------------- screen 2 and the plan pipeline

const SCRIPT = {
  id: 'sc1', version: 1,
  scenes: [
    { id: 'a', title: 'The crooked fade', visual: 'Dre gives a crooked fade', lines: [{ speaker: 'narrator', text: 'Dre gave a crooked fade.' }] },
    { id: 'b', title: 'The comeback', visual: 'A line out the door', lines: [{ speaker: 'narrator', text: 'A year later the line was out the door.' }] },
  ],
  violations: [],
};
const castRow = (over = {}) => ({ id: 'c1', name: 'Dre', status: 'ready', chosen_index: 0, image_url: '/dre.png', candidates: [{ url: '/dre.png' }], regen_credits: 0, retry_credits: 0, ...over });
const shotRow = (i, over = {}) => ({
  id: `sh${i}`, ord: i - 1, scene_id: i <= 1 ? 'a' : 'b', description: `Shot ${i}`, line: `Line ${i}`, seconds: 3, quality: 'standard', source: 'generated',
  still_url: null, clip_url: null, status: 'draft', still_credits: 0, clip_credits: null, clip_price: 33, reroll_credits: null, ...over,
});
const none = { applicable: { narration: true, narrationLines: 2 }, narration: { status: 'none', credits: 0 }, music: { type: 'generated', status: 'none', credits: 0 }, plan: {} };
const done = { ...none, narration: { status: 'ready', credits: 0, url: '/n.mp3' }, music: { type: 'generated', status: 'ready', credits: 0, url: '/m.mp3' } };

/** A tiny server: the mocked client calls change this state and getStatus reads it, like the real routes do. */
function fakeServer(initial = {}) {
  const s = { ...status({ project: project({ step: 'script' }) }), ...initial };
  const calls = [];
  const snap = () => JSON.parse(JSON.stringify(s));
  client.getStatus.mockImplementation(async () => snap());
  client.getScript.mockResolvedValue(SCRIPT);
  client.setPlanRequested.mockImplementation(async (id, requested) => { calls.push(['marker', requested]); s.project.plan_requested = requested; return { plan_requested: requested }; });
  client.pickCast.mockImplementation(async (id, castId, i) => { calls.push(['pick', castId, i]); (s.cast.find((c) => c.id === castId) || {}).chosen_index = i; return { cast: s.cast }; });
  client.getPlanQuote.mockResolvedValue({ total: 90, castFee: 90, stills: 0, lines: [{ key: 'fee', credits: 90 }, { key: 'pictures', credits: 0 }, { key: 'voice', credits: 0 }, { key: 'music', credits: 0 }] });
  client.startCast.mockImplementation(async (id, expected) => { calls.push(['cast', expected]); s.cast = [castRow()]; s.project.step = 'cast'; s.project.fee_charged = true; return { cast: s.cast }; });
  client.buildShots.mockImplementation(async () => { calls.push(['build']); s.shots = [shotRow(1), shotRow(2)]; s.project.step = 'storyboard'; return {}; });
  client.makeStills.mockImplementation(async (id, ids, expected) => { calls.push(['stills', ids, expected]); s.shots.forEach((x) => { x.still_url = `/${x.id}.png`; x.status = 'still_ready'; x.clip_credits = 33; }); return {}; });
  client.makeNarration.mockImplementation(async (id, opts) => { calls.push(['narration', opts?.expectedCredits]); s.audio.narration = { status: 'ready', credits: 0, url: '/n.mp3' }; return {}; });
  client.makeMusic.mockImplementation(async (id, opts) => { calls.push(['music', opts?.expectedCredits]); s.audio.music = { type: 'generated', status: 'ready', credits: 0, url: '/m.mp3' }; return {}; });
  return { s, calls };
}

describe('screen 2, Check the script', () => {
  it('lists the scenes and the button carries the quoted total', async () => {
    fakeServer();
    render(<SimpleMaker id="p1" returnTo="/app/p/p1" />);
    expect(await screen.findByRole('heading', { name: /Check the script/ })).toBeInTheDocument();
    expect(await screen.findByText('Dre gave a crooked fade.')).toBeInTheDocument();
    expect(screen.getByText('A year later the line was out the door.')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Looks good, design my video (90 credits)' })).toBeEnabled();
    expect(client.getPlanQuote).toHaveBeenCalledWith('p1');
  });

  it('lists the included parts of the quote and says an unpriced total is included', async () => {
    fakeServer();
    client.getPlanQuote.mockResolvedValue({ total: 0, castFee: 0, stills: 0, lines: [{ key: 'fee', label: 'Project fee', credits: 0, included: true }, { key: 'pictures', label: 'Storyboard pictures', credits: 0, included: true }] });
    render(<SimpleMaker id="p1" returnTo="/app/p/p1" />);
    expect(await screen.findByRole('button', { name: 'Looks good, design my video (included)' })).toBeEnabled();
    expect(screen.getByTestId('plan-lines')).toHaveTextContent('Storyboard pictures');
    expect(screen.getByTestId('plan-lines')).toHaveTextContent('included');
  });

  it('edits a scene in place with the existing script calls', async () => {
    fakeServer();
    client.updateScene.mockResolvedValue({ script: { ...SCRIPT, scenes: [{ ...SCRIPT.scenes[0], lines: [{ speaker: 'narrator', text: 'Dre cut a very crooked fade.' }] }, SCRIPT.scenes[1]] }, changedSceneIds: ['a'] });
    render(<SimpleMaker id="p1" returnTo="/app/p/p1" />);
    await screen.findByText('Dre gave a crooked fade.');
    fireEvent.click(screen.getByRole('button', { name: 'Edit scene 1' }));
    fireEvent.change(screen.getByLabelText('Scene 1 line 1, narrator'), { target: { value: 'Dre cut a very crooked fade.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save scene 1' }));
    await waitFor(() => expect(client.updateScene).toHaveBeenCalledWith('p1', 'a', { visual: 'Dre gives a crooked fade', lines: [{ speaker: 'narrator', text: 'Dre cut a very crooked fade.' }] }));
    expect(await screen.findByText('Dre cut a very crooked fade.')).toBeInTheDocument();
  });

  it('runs the plan in order: cast with the quoted fee, picks, shots, pictures, then voice and music', async () => {
    const { calls } = fakeServer();
    render(<SimpleMaker id="p1" returnTo="/app/p/p1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Looks good, design my video (90 credits)' }));
    await waitFor(() => expect(calls.map((c) => c[0]).filter((t) => t !== 'marker')).toEqual(['cast', 'build', 'stills', 'narration', 'music']), { timeout: 8000 });
    expect(calls[0]).toEqual(['marker', true]);
    expect(calls[1]).toEqual(['cast', 90]);
    expect(calls.find((c) => c[0] === 'stills')).toEqual(['stills', ['sh1', 'sh2'], 0]);
    expect(calls.find((c) => c[0] === 'narration')).toEqual(['narration', 0]);
    expect(calls.find((c) => c[0] === 'music')).toEqual(['music', 0]);
    expect(await screen.findByRole('heading', { name: /Check the plan/ })).toBeInTheDocument();
    // Nothing is started twice, however long the screen stays open.
    await new Promise((r) => setTimeout(r, 300));
    expect(calls.filter((c) => c[0] !== 'marker')).toHaveLength(5);
  });

  it('different people in every scene: the cast stage is skipped', async () => {
    const { calls } = fakeServer({ project: project({ step: 'script', consistent_cast: false }) });
    client.getPlanQuote.mockResolvedValue({ total: 0, castFee: 0, stills: 0, lines: [{ key: 'fee', credits: 0 }, { key: 'pictures', credits: 0 }] });
    render(<SimpleMaker id="p1" returnTo="/app/p/p1" />);
    fireEvent.click(await screen.findByRole('button', { name: /Looks good, design my video/ }));
    await waitFor(() => expect(calls.map((c) => c[0]).filter((t) => t !== 'marker')).toEqual(['build', 'stills', 'narration', 'music']), { timeout: 8000 });
    expect(client.startCast).not.toHaveBeenCalled();
  });

  it('a 409 quote_changed refreshes the quote, shows the new price and asks again without retrying', async () => {
    const { calls } = fakeServer();
    client.startCast.mockRejectedValueOnce(new StoryApiError({ status: 409, code: 'quote_changed', message: 'The price is now 120 credits.', body: { total: 120 } }));
    render(<SimpleMaker id="p1" returnTo="/app/p/p1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Looks good, design my video (90 credits)' }));
    client.getPlanQuote.mockResolvedValue({ total: 120, castFee: 120, stills: 0, lines: [{ key: 'fee', credits: 120 }] });
    expect(await screen.findByRole('button', { name: 'Looks good, design my video (120 credits)' })).toBeEnabled();
    expect(screen.getByTestId('plan-note')).toHaveTextContent(/price changed/i);
    await new Promise((r) => setTimeout(r, 400));
    expect(client.startCast).toHaveBeenCalledTimes(1);
    expect(calls.filter((c) => c[0] !== 'marker')).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Looks good, design my video (120 credits)' }));
    await waitFor(() => expect(calls.find((c) => c[0] === 'cast')).toEqual(['cast', 120]), { timeout: 8000 });
  });

  it('a 402 stops the pipeline, shows the top up path and starts nothing else', async () => {
    const { calls } = fakeServer();
    client.startCast.mockRejectedValueOnce(new StoryApiError({ status: 402, code: 'insufficient_credits', needed: 90, available: 20 }));
    render(<SimpleMaker id="p1" returnTo="/app/p/p1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Looks good, design my video (90 credits)' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Not enough credits');
    expect(within(alert).getByRole('link', { name: 'Top up credits' })).toHaveAttribute('href', '/app/billing');
    await new Promise((r) => setTimeout(r, 300));
    expect(client.startCast).toHaveBeenCalledTimes(1);
    expect(calls.filter((c) => c[0] !== 'marker')).toEqual([]);
  });

  it('a start already running in another tab (409 busy) only refreshes, and carries on from what it finds', async () => {
    const { s, calls } = fakeServer();
    client.startCast.mockImplementationOnce(async () => {
      // The other tab won: the cast exists by the time this tab asks again.
      s.cast = [castRow()]; s.project.step = 'cast'; s.project.fee_charged = true;
      throw new StoryApiError({ status: 409, code: 'conflict', message: 'busy' });
    });
    render(<SimpleMaker id="p1" returnTo="/app/p/p1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Looks good, design my video (90 credits)' }));
    await waitFor(() => expect(calls.map((c) => c[0]).filter((t) => t !== 'marker')).toEqual(['build', 'stills', 'narration', 'music']), { timeout: 8000 });
    expect(client.startCast).toHaveBeenCalledTimes(1);
  });

  it('after a reload it resumes only what is missing and only what costs nothing', async () => {
    // Cast picked, shots built, no pictures yet: only the pictures (0 credits), then the audio.
    const { calls } = fakeServer({ project: project({ step: 'storyboard', fee_charged: true, plan_requested: true }), cast: [castRow()], shots: [shotRow(1), shotRow(2)] });
    render(<SimpleMaker id="p1" returnTo="/app/p/p1" />);
    expect(await screen.findByRole('heading', { name: /Check the plan/ })).toBeInTheDocument();
    await waitFor(() => expect(calls.map((c) => c[0]).filter((t) => t !== 'marker')).toEqual(['stills', 'narration', 'music']), { timeout: 8000 });
    expect(client.startCast).not.toHaveBeenCalled();
    expect(client.buildShots).not.toHaveBeenCalled();
  });

  it('a resumed pipeline never sends a price nobody confirmed', async () => {
    const { calls } = fakeServer({ project: project({ step: 'storyboard', fee_charged: true }), cast: [castRow()], shots: [shotRow(1, { still_credits: 2 })], audio: done });
    render(<SimpleMaker id="p1" returnTo="/app/p/p1" />);
    const ask = await screen.findByRole('button', { name: /Make the pictures \(2 credits\)/ });
    await new Promise((r) => setTimeout(r, 300));
    expect(calls).toEqual([]);
    fireEvent.click(ask);
    await waitFor(() => expect(calls[0]).toEqual(['stills', ['sh1'], 2]));
  });

  it('from a mid pipeline reload, nothing runs twice when everything is already there', async () => {
    const { calls } = fakeServer({ project: project({ step: 'audio', fee_charged: true }), cast: [castRow()], shots: [shotRow(1, { still_url: '/a.png', status: 'still_ready' })], audio: done });
    render(<SimpleMaker id="p1" returnTo="/app/p/p1" />);
    await screen.findByRole('heading', { name: /Check the plan/ });
    await new Promise((r) => setTimeout(r, 300));
    expect(calls).toEqual([]);
  });
});

// ---------------------------------------------------------------- screen 3

const planStatus = (over = {}) => status({
  project: project({ step: 'audio', fee_charged: true }),
  cast: [castRow(), castRow({ id: 'c2', name: 'Marcus', chosen_index: 1, image_url: '/m.png', candidates: [{ url: '/m0.png' }, { url: '/m.png' }] })],
  shots: [1, 2, 3].map((i) => shotRow(i, { still_url: `/s${i}.png`, status: 'still_ready', clip_credits: 33, scene_id: i === 3 ? 'b' : 'a' })),
  audio: done,
  ...over,
});
const sceneQuote = (ids, total) => ({ total, lines: [], holdNeeded: total, shotIds: ids, spent: 0 });

describe('screen 3, Check the plan', () => {
  beforeEach(() => {
    client.getScript.mockResolvedValue(SCRIPT);
    client.getStatus.mockResolvedValue(planStatus());
    client.getQuote.mockImplementation(async (id, ids) => sceneQuote(ids, ids.length * 33 + (ids.length === 3 ? 0 : 0)));
  });

  it('shows the characters, the storyboard pictures and the voice and music pills', async () => {
    render(<SimpleMaker id="p1" returnTo="/app/p/p1" />);
    expect(await screen.findByRole('heading', { name: /Check the plan/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Dre, change this character/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Marcus, change this character/ })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Open Shot/ })).toHaveLength(3);
    expect(document.querySelector('[data-pill="voice"]')).toHaveTextContent('Narrator');
    expect(document.querySelector('[data-pill="music"]')).toHaveTextContent('Music');
  });

  it('"Make my video" carries the quote for every startable shot and sends exactly those ids and that total', async () => {
    client.startGeneration.mockResolvedValue({ shots: [], charged: 99, queued: ['sh1', 'sh2', 'sh3'] });
    render(<SimpleMaker id="p1" returnTo="/app/p/p1" />);
    const make = await screen.findByRole('button', { name: 'Make my video (99 credits)' });
    expect(client.getQuote).toHaveBeenCalledWith('p1', ['sh1', 'sh2', 'sh3']);
    fireEvent.click(make);
    await waitFor(() => expect(client.startGeneration).toHaveBeenCalledWith('p1', ['sh1', 'sh2', 'sh3'], 99));
    expect(client.startGeneration).toHaveBeenCalledTimes(1);
  });

  it('"Try scene 1 first" is quoted and sent for scene 1 only', async () => {
    client.startGeneration.mockResolvedValue({ shots: [], charged: 66, queued: ['sh1', 'sh2'] });
    render(<SimpleMaker id="p1" returnTo="/app/p/p1" />);
    const first = await screen.findByRole('button', { name: 'Try scene 1 first (66 credits)' });
    expect(client.getQuote).toHaveBeenCalledWith('p1', ['sh1', 'sh2']);
    fireEvent.click(first);
    await waitFor(() => expect(client.startGeneration).toHaveBeenCalledWith('p1', ['sh1', 'sh2'], 66));
  });

  it('a price that moved is shown and asked again, never charged blind', async () => {
    client.startGeneration.mockRejectedValueOnce(new StoryApiError({ status: 409, code: 'quote_changed', body: { total: 120 } }));
    render(<SimpleMaker id="p1" returnTo="/app/p/p1" />);
    const make = await screen.findByRole('button', { name: 'Make my video (99 credits)' });
    client.getQuote.mockImplementation(async (id, ids) => sceneQuote(ids, 120));
    fireEvent.click(make);
    expect(await screen.findByRole('button', { name: 'Make my video (120 credits)' })).toBeEnabled();
    expect(screen.getByTestId('plan-note')).toHaveTextContent(/price changed/i);
    expect(client.startGeneration).toHaveBeenCalledTimes(1);
  });

  it('not enough credits opens the top up path', async () => {
    client.startGeneration.mockRejectedValueOnce(new StoryApiError({ status: 402, code: 'insufficient_credits', needed: 99, available: 10 }));
    render(<SimpleMaker id="p1" returnTo="/app/p/p1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Make my video (99 credits)' }));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByRole('link', { name: 'Top up credits' })).toHaveAttribute('href', '/app/billing');
  });

  it('shows progress while pictures are being made and holds the buttons until they are ready', async () => {
    client.getStatus.mockResolvedValue(planStatus({
      shots: [shotRow(1, { status: 'still_pending' }), shotRow(2, { status: 'still_pending' })],
    }));
    render(<SimpleMaker id="p1" returnTo="/app/p/p1" />);
    await screen.findByRole('heading', { name: /Check the plan/ });
    expect(screen.getAllByText('Drawing the storyboard pictures').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /^Make my video/ })).toBeDisabled();
    expect(client.getQuote).not.toHaveBeenCalled();
  });

  it('a character opens its options, picking one uses the existing cast call', async () => {
    client.pickCast.mockResolvedValue({ cast: [] });
    render(<SimpleMaker id="p1" returnTo="/app/p/p1" />);
    fireEvent.click(await screen.findByRole('button', { name: /Marcus, change this character/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Pick Marcus, option 1' }));
    await waitFor(() => expect(client.pickCast).toHaveBeenCalledWith('p1', 'c2', 0));
  });

  it('a script changed after the storyboard asks to update it first', async () => {
    client.getStatus.mockResolvedValue(planStatus({ shots: [1, 2].map((i) => shotRow(i, { still_url: '/s.png', status: 'still_ready', needs_rebuild: true })) }));
    client.buildShots.mockResolvedValue({});
    render(<SimpleMaker id="p1" returnTo="/app/p/p1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Update the storyboard' }));
    await waitFor(() => expect(client.buildShots).toHaveBeenCalledWith('p1'));
    expect(client.getQuote).not.toHaveBeenCalled();
  });

  it('lets a customer go back to an earlier screen, and follows the server forward', async () => {
    render(<SimpleMaker id="p1" returnTo="/app/p/p1" />);
    expect(await screen.findByRole('heading', { name: /Check the plan/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Describe it/ }));
    expect(await screen.findByRole('heading', { name: /Describe your video/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Check the plan/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Watch and fix/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /Check the script/ }));
    expect(await screen.findByRole('heading', { name: /Check the script/ })).toBeInTheDocument();
    // Going back never offers to spend again: the plan exists, so the button just goes back to it.
    expect(screen.queryByRole('button', { name: /design my video/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Back to the plan' }));
    expect(await screen.findByRole('heading', { name: /Check the plan/ })).toBeInTheDocument();
    expect(client.getPlanQuote).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------- screen 4

const T = (n) => `2026-11-16T1${n}:00:00.000Z`;
const clipShot = (i, scene, over = {}) => shotRow(i, {
  scene_id: scene, still_url: `/s${i}.png`, status: 'still_ready', clip_credits: 33, ...over,
});
const ready = (i, scene, over = {}) => clipShot(i, scene, { status: 'ready', clip_url: `/c${i}.mp4`, clip_credits: null, reroll_credits: 0, ...over });
const watchStatus = (over = {}) => status({
  project: project({ step: 'generate', fee_charged: true }),
  cast: [castRow()],
  shots: [ready(1, 'a'), clipShot(2, 'b'), clipShot(3, 'c')],
  jobs: [{ id: 'j1', kind: 'clip', status: 'done', updated_at: T(1), payload: { shotId: 'sh1' } }],
  audio: done,
  render: null,
  renders: [],
  renderPrice: { credits: 0 },
  rerolls: { included: 1, used: 0, left: 1 },
  ...over,
});

describe('screen 4, Watch and fix', () => {
  beforeEach(() => {
    client.getScript.mockResolvedValue(SCRIPT);
    client.getStatus.mockResolvedValue(watchStatus());
    client.getQuote.mockImplementation(async (id, ids) => sceneQuote(ids, ids.length * 40));
    client.startRender.mockResolvedValue({ id: 'r1', status: 'queued' });
  });

  it('shows a strip of scenes built from the shots, with their states', async () => {
    client.getStatus.mockResolvedValue(watchStatus({ shots: [ready(1, 'a'), clipShot(2, 'b', { status: 'generating' }), clipShot(3, 'c'), clipShot(4, 'd', { status: 'failed' })] }));
    render(<SimpleMaker id="p1" returnTo="/app/p/p1" />);
    expect(await screen.findByRole('heading', { name: /Watch and fix/ })).toBeInTheDocument();
    const strip = screen.getByRole('list', { name: 'Scenes' });
    const items = within(strip).getAllByRole('listitem');
    expect(items).toHaveLength(4);
    expect(items[0]).toHaveTextContent('Scene 1');
    expect(items[0]).toHaveTextContent('Ready');
    expect(items[1]).toHaveTextContent('Making');
    expect(items[2]).toHaveTextContent('Waiting');
    expect(items[3]).toHaveTextContent('Did not work');
  });

  it('after a scene is ready and others are not started: next scene and the rest, each with its price', async () => {
    client.startGeneration.mockResolvedValue({ shots: [], charged: 40, queued: ['sh2'] });
    render(<SimpleMaker id="p1" returnTo="/app/p/p1" />);
    const next = await screen.findByRole('button', { name: 'Make the next scene (40 credits)' });
    expect(await screen.findByRole('button', { name: 'Make the rest (80 credits)' })).toBeEnabled();
    expect(client.getQuote).toHaveBeenCalledWith('p1', ['sh2']);
    expect(client.getQuote).toHaveBeenCalledWith('p1', ['sh2', 'sh3']);
    fireEvent.click(next);
    await waitFor(() => expect(client.startGeneration).toHaveBeenCalledWith('p1', ['sh2'], 40));
  });

  it('"Make the rest" sends every waiting shot with the total it showed', async () => {
    client.startGeneration.mockResolvedValue({ shots: [], charged: 80, queued: [] });
    render(<SimpleMaker id="p1" returnTo="/app/p/p1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Make the rest (80 credits)' }));
    await waitFor(() => expect(client.startGeneration).toHaveBeenCalledWith('p1', ['sh2', 'sh3'], 80));
  });

  it('with one scene left there is just the one button', async () => {
    client.getStatus.mockResolvedValue(watchStatus({ shots: [ready(1, 'a'), clipShot(2, 'b')] }));
    render(<SimpleMaker id="p1" returnTo="/app/p/p1" />);
    expect(await screen.findByRole('button', { name: 'Make the next scene (40 credits)' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Make the rest/ })).toBeNull();
  });

  it('while the first scene is still being made there is nothing to press and it says why', async () => {
    client.getStatus.mockResolvedValue(watchStatus({ shots: [clipShot(1, 'a', { status: 'generating' }), clipShot(2, 'b')] }));
    render(<SimpleMaker id="p1" returnTo="/app/p/p1" />);
    await screen.findByRole('heading', { name: /Watch and fix/ });
    expect(screen.queryByRole('button', { name: /Make the next scene/ })).toBeNull();
    expect(screen.getByTestId('dock')).toHaveTextContent(/once this one is ready/i);
  });

  it('a scene that did not work can be tried again with its price', async () => {
    client.getStatus.mockResolvedValue(watchStatus({ shots: [ready(1, 'a'), clipShot(2, 'b', { status: 'failed' })] }));
    client.startGeneration.mockResolvedValue({ shots: [], charged: 40, queued: ['sh2'] });
    render(<SimpleMaker id="p1" returnTo="/app/p/p1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Try scene 2 again (40 credits)' }));
    await waitFor(() => expect(client.startGeneration).toHaveBeenCalledWith('p1', ['sh2'], 40));
  });

  it('starts the final render by itself once, when every clip is ready, and never twice', async () => {
    client.getStatus.mockResolvedValue(watchStatus({ shots: [ready(1, 'a'), ready(2, 'b')] }));
    render(<SimpleMaker id="p1" returnTo="/app/p/p1" />);
    await waitFor(() => expect(client.startRender).toHaveBeenCalledWith('p1', 0));
    await new Promise((r) => setTimeout(r, 400));
    expect(client.startRender).toHaveBeenCalledTimes(1);
  });

  it('does not start a render while a clip is missing, a render exists for these clips, or the render has a price', async () => {
    client.getStatus.mockResolvedValue(watchStatus());
    const first = render(<SimpleMaker id="p1" returnTo="/app/p/p1" />);
    await screen.findByRole('heading', { name: /Watch and fix/ });
    await flush();
    expect(client.startRender).not.toHaveBeenCalled();
    first.unmount();
    client.getStatus.mockResolvedValue(watchStatus({ shots: [ready(1, 'a'), ready(2, 'b')], render: { id: 'r1', version: 1, status: 'done', url: '/v.mp4', created_at: T(5), warnings: [] }, renders: [{ id: 'r1', version: 1, status: 'done', url: '/v.mp4', created_at: T(5), warnings: [] }] }));
    render(<SimpleMaker id="p1" returnTo="/app/p/p1" />);
    await screen.findByRole('link', { name: /Download/ });
    expect(client.startRender).not.toHaveBeenCalled();
  });

  it('shows the finished video with Download and the warnings plainly', async () => {
    const r = { id: 'r1', version: 1, status: 'done', url: 'https://files.example/v.mp4', created_at: T(5), duration_seconds: 30, warnings: [{ code: 'gap', message: 'There is a short silence after scene 2.' }] };
    client.getStatus.mockResolvedValue(watchStatus({ shots: [ready(1, 'a'), ready(2, 'b')], render: r, renders: [r] }));
    render(<SimpleMaker id="p1" returnTo="/app/p/p1" />);
    const dl = await screen.findByRole('link', { name: /Download/ });
    expect(dl).toHaveAttribute('href', 'https://files.example/v.mp4?download=1');
    expect(screen.getByText('There is a short silence after scene 2.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Watch and fix/ })).toBeInTheDocument();
    expect(screen.getByTestId('chat-note')).toHaveTextContent('Want to change anything?');
  });

  it('shows that the video is being put together', async () => {
    client.getStatus.mockResolvedValue(watchStatus({ shots: [ready(1, 'a'), ready(2, 'b')], render: { id: 'r1', version: 1, status: 'running', created_at: T(5), warnings: [] }, renders: [] }));
    render(<SimpleMaker id="p1" returnTo="/app/p/p1" />);
    expect((await screen.findAllByText(/Putting your video together/)).length).toBeGreaterThan(0);
    expect(client.startRender).not.toHaveBeenCalled();
  });

  it('a later render shows its price and needs a click', async () => {
    const r = { id: 'r1', version: 1, status: 'done', url: '/v.mp4', created_at: T(0), warnings: [] };
    client.getStatus.mockResolvedValue(watchStatus({ shots: [ready(1, 'a'), ready(2, 'b')], render: r, renders: [r], renderPrice: { credits: 5 } }));
    render(<SimpleMaker id="p1" returnTo="/app/p/p1" />);
    const again = await screen.findByRole('button', { name: 'Put the video together again (5 credits)' });
    await flush();
    expect(client.startRender).not.toHaveBeenCalled();
    fireEvent.click(again);
    await waitFor(() => expect(client.startRender).toHaveBeenCalledWith('p1', 5));
  });

  it('"Change this scene" opens the chat with the scene named, and offers to make its shots again with the price and the tries included', async () => {
    client.getStatus.mockResolvedValue(watchStatus({ shots: [ready(1, 'a', { reroll_credits: 0 }), clipShot(2, 'b')] }));
    client.rerollShot.mockResolvedValue({ shots: [], charged: 0, rerolls: {} });
    render(<SimpleMaker id="p1" returnTo="/app/p/p1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Change scene 1' }));
    expect(screen.getByLabelText('Message to the chat helper')).toHaveValue('Change scene 1: ');
    const panel = await screen.findByTestId('scene-change');
    expect(panel).toHaveTextContent('1 try included');
    fireEvent.click(within(panel).getByRole('button', { name: 'Make shot 1 again (included)' }));
    await waitFor(() => expect(client.rerollShot).toHaveBeenCalledWith('p1', 'sh1', 0));
  });

  it('plays a scene clip from the strip', async () => {
    client.getStatus.mockResolvedValue(watchStatus({ shots: [ready(1, 'a'), clipShot(2, 'b')] }));
    render(<SimpleMaker id="p1" returnTo="/app/p/p1" />);
    fireEvent.click(await screen.findByRole('button', { name: /Play scene 1/ }));
    const video = await screen.findByLabelText('Scene 1 clip');
    expect(video.getAttribute('src')).toBe('/c1.mp4');
  });
});

// ---------------------------------------------------------------- fix round 1

describe('I5: the video wait cannot be skipped by typing', () => {
  const pendingVideo = () => {
    client.getStatus.mockResolvedValue(status({ project: project({ step: 'breakdown', reference_id: 'r1', offer: null }) }));
    client.getReference.mockResolvedValue({ id: 'r1', status: 'pending', beats: [] });
  };
  it('typing in the optional box does not enable "Write my script" while the video is being read', async () => {
    pendingVideo();
    render(<SimpleMaker id="p1" returnTo="/app/p/p1" />);
    await screen.findAllByText(/Watching your video shot by shot/);
    fireEvent.change(screen.getByLabelText('Describe your idea'), { target: { value: 'Make it funny' } });
    expect(screen.getByRole('button', { name: 'Reading your video…' })).toBeDisabled();
  });
  it('"Write it without the video" is the only way past, and says the video will not be used', async () => {
    pendingVideo();
    client.updateProject.mockResolvedValue(project());
    client.writeScript.mockResolvedValue({ id: 'sc', version: 1, scenes: [], violations: [] });
    render(<SimpleMaker id="p1" returnTo="/app/p/p1" />);
    await screen.findAllByText(/Watching your video shot by shot/);
    fireEvent.change(screen.getByLabelText('Describe your idea'), { target: { value: 'A baker whose bread can talk' } });
    fireEvent.click(screen.getByRole('button', { name: 'Write it without the video' }));
    expect(screen.getByTestId('skip-note')).toHaveTextContent('The video will not be used');
    fireEvent.click(screen.getByRole('button', { name: /Write my script/ }));
    await waitFor(() => expect(client.writeScript).toHaveBeenCalledWith('p1'));
  });
});

describe('I4: the purpose is the server\'s, shown on screen 2 with change', () => {
  it('shows the purpose the script model picked and changes it with the existing options', async () => {
    fakeServer({ project: project({ step: 'script', purpose: 'story' }) });
    client.updateProject.mockResolvedValue(project({ purpose: 'product' }));
    render(<SimpleMaker id="p1" returnTo="/app/p/p1" />);
    const line = await screen.findByTestId('purpose-line');
    expect(line).toHaveTextContent('Just a story');
    fireEvent.click(within(line).getByRole('button', { name: 'Change what this video is for' }));
    fireEvent.click(within(line).getByRole('radio', { name: 'A product' }));
    await waitFor(() => expect(client.updateProject).toHaveBeenCalledWith('p1', { purpose: 'product' }));
  });
});

describe('I7: different people in every scene', () => {
  it('says the fee is charged when the video is made, with its amount, and the make total includes it', async () => {
    fakeServer({ project: project({ step: 'script', consistent_cast: false }) });
    client.getPlanQuote.mockResolvedValue({ total: 0, castFee: 0, feeLater: 90, stills: 0, lines: [{ key: 'fee', label: 'Project fee', credits: 0, included: false, later: 90 }, { key: 'pictures', label: 'Storyboard pictures', credits: 0, included: true }] });
    render(<SimpleMaker id="p1" returnTo="/app/p/p1" />);
    await screen.findByRole('button', { name: /Looks good, design my video/ });
    expect(screen.getByTestId('plan-lines')).toHaveTextContent('Project fee90 credits, charged when you make the video');
    expect(screen.getByTestId('plan-lines')).not.toHaveTextContent('Project feeincluded');
    cleanup();
    // On screen 3 the "Make my video" total is the server quote, which carries that fee, and its lines are listed.
    client.getStatus.mockResolvedValue(planStatus({ project: project({ step: 'audio', consistent_cast: false, fee_charged: false }), cast: [] }));
    client.getQuote.mockImplementation(async (id, ids) => ({ total: 90 + ids.length * 33, lines: [{ label: 'Project fee', credits: 90 }, { label: `${ids.length} Standard shots`, credits: ids.length * 33 }], shotIds: ids }));
    render(<SimpleMaker id="p1" returnTo="/app/p/p1" />);
    expect(await screen.findByRole('button', { name: 'Make my video (189 credits)' })).toBeEnabled();
    expect(screen.getByLabelText('What making the video costs')).toHaveTextContent('Project fee90 credits');
  });
});

describe('I6: free parts start only after the press, in one tab', () => {
  it('a project with no press (the detailed editor) starts nothing by itself and offers one button', async () => {
    const { calls } = fakeServer({ project: project({ step: 'storyboard', fee_charged: true }), cast: [castRow()], shots: [shotRow(1), shotRow(2)] });
    render(<SimpleMaker id="p1" returnTo="/app/p/p1" />);
    const carry = await screen.findByRole('button', { name: 'Carry on designing (included)' });
    await new Promise((r) => setTimeout(r, 300));
    expect(calls).toEqual([]);
    fireEvent.click(carry);
    await waitFor(() => expect(calls.map((c) => c[0]).filter((t) => t !== 'marker')).toEqual(['stills', 'narration', 'music']), { timeout: 8000 });
  });

  it('two tabs on one project: only the tab holding the lock builds, once', async () => {
    const held = new Set();
    vi.stubGlobal('navigator', { ...navigator, locks: { request: (name, opts, cb) => {
      if (opts?.ifAvailable && held.has(name)) return Promise.resolve(cb(null));
      held.add(name);
      return Promise.resolve(cb({ name }));
    } } });
    const { calls } = fakeServer({ project: project({ step: 'cast', fee_charged: true, plan_requested: true }), cast: [castRow()] });
    render(<><div data-tab="a"><SimpleMaker id="p1" returnTo="/app/p/p1" /></div><div data-tab="b"><SimpleMaker id="p1" returnTo="/app/p/p1" /></div></>);
    await waitFor(() => expect(calls.map((c) => c[0]).filter((t) => t !== 'marker')).toEqual(['build', 'stills', 'narration', 'music']), { timeout: 8000 });
    await new Promise((r) => setTimeout(r, 300));
    expect(client.buildShots).toHaveBeenCalledTimes(1);
    expect(client.makeStills.mock.calls.every(([, ids]) => ids.every((id) => ['sh1', 'sh2'].includes(id)))).toBe(true);
  });

  it('clears the marker once the plan is complete', async () => {
    const { calls } = fakeServer({ project: project({ step: 'audio', fee_charged: true, plan_requested: true }), cast: [castRow()], shots: [shotRow(1, { still_url: '/a.png', status: 'still_ready' })], audio: done });
    render(<SimpleMaker id="p1" returnTo="/app/p/p1" />);
    await waitFor(() => expect(calls).toContainEqual(['marker', false]));
  });
});

describe('I8: no endless spinner on the characters', () => {
  it('a character ready with no look gets its first option picked when the plan was pressed', async () => {
    const open = castRow({ id: 'c7', name: 'Mia', chosen_index: null, image_url: null, candidates: [{ url: '/a.png' }, { url: '/b.png' }] });
    const { calls } = fakeServer({ project: project({ step: 'cast', fee_charged: true, plan_requested: true }), cast: [open] });
    render(<SimpleMaker id="p1" returnTo="/app/p/p1" />);
    await waitFor(() => expect(calls).toContainEqual(['pick', 'c7', 0]));
  });

  it('without the press it says "Pick a look for Mia" with the options inline, and picks nothing itself', async () => {
    const open = castRow({ id: 'c7', name: 'Mia', chosen_index: null, image_url: null, candidates: [{ url: '/a.png' }, { url: '/b.png' }] });
    const { calls } = fakeServer({ project: project({ step: 'cast', fee_charged: true }), cast: [open] });
    render(<SimpleMaker id="p1" returnTo="/app/p/p1" />);
    const card = await screen.findByTestId('pick-look');
    expect(card).toHaveTextContent('Pick a look for Mia');
    await new Promise((r) => setTimeout(r, 300));
    expect(calls).toEqual([]);
    fireEvent.click(within(card).getByRole('button', { name: 'Pick Mia, option 2' }));
    await waitFor(() => expect(client.pickCast).toHaveBeenCalledWith('p1', 'c7', 1));
  });

  it('a character stuck as a draft is started again (no fee once cast rows exist)', async () => {
    const old = new Date(Date.now() - 10 * 60_000).toISOString();
    const { calls } = fakeServer({ project: project({ step: 'cast', fee_charged: true, plan_requested: true }), cast: [castRow({ status: 'draft', chosen_index: null, image_url: null, candidates: [], updated_at: old })] });
    render(<SimpleMaker id="p1" returnTo="/app/p/p1" />);
    await waitFor(() => expect(client.startCast).toHaveBeenCalledWith('p1', 0));
    expect(calls.filter((c) => c[0] === 'cast')).toHaveLength(1);
  });

  it('a wait that lasts too long gets a message and a next step', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fakeServer({ project: project({ step: 'cast', fee_charged: true, plan_requested: true }), cast: [castRow({ status: 'pending', chosen_index: null, image_url: null, candidates: [], updated_at: new Date().toISOString() })], jobs: [{ id: 'j', kind: 'cast_image', status: 'running', payload: { castId: 'c1' } }] });
    render(<SimpleMaker id="p1" returnTo="/app/p/p1" />);
    await screen.findByRole('heading', { name: /Check the plan/ });
    await act(async () => { vi.advanceTimersByTime(5 * 60_000 + 100); });
    expect(await screen.findByTestId('plan-stalled')).toHaveTextContent(/longer than usual/);
    expect(screen.getByRole('button', { name: 'Look again' })).toBeInTheDocument();
  });
});

describe('the voice and music dialog', () => {
  it('says Done, not "Continue to generate"', async () => {
    client.getAudio.mockResolvedValue({ plan: { voiceId: 'v', music: { type: 'generated', prompt: '' }, captions: { on: true, style: 'clean' } }, voices: [{ id: 'v', name: 'Sienna', gender: 'f', sampleUrl: '/s.mp3' }], applicable: { narration: true, narrationLines: 2 }, narration: { status: 'ready', credits: 0, free_left: 3, included: 3, used: 0 }, music: { type: 'generated', status: 'ready', credits: 0, free_left: 3, included: 3, used: 0 }, uploads: {} });
    client.getStatus.mockResolvedValue(planStatus());
    render(<SimpleMaker id="p1" returnTo="/app/p/p1" />);
    fireEvent.click(await screen.findByRole('button', { name: /Narrator/ }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByRole('button', { name: 'Done' })).toBeInTheDocument();
    expect(dialog).not.toHaveTextContent('Continue to generate');
  });
});
