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
      offer: 'A barber turns a bad haircut into a comeback', purpose: 'story', style: '3d_family', seconds: 10, quality: 'standard', mode: 'narrated',
    }));
    expect(client.updateProject.mock.invocationCallOrder[0]).toBeLessThan(client.writeScript.mock.invocationCallOrder[0]);
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
      title: 'A baker whose bread can talk.', offer: 'A baker whose bread can talk.\nIt is shy.', purpose: 'story', seconds: 30, quality: 'standard', mode: 'narrated', style: '3d_family', aspect: '9:16',
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
    expect(screen.getByRole('button', { name: /Write my script/ })).toBeDisabled();
    client.getReference.mockResolvedValue({ id: 'r1', status: 'ready', beats: [{ ord: 1 }, { ord: 2 }, { ord: 3 }], hook: 'x', duration: 28 });
    client.updateProject.mockResolvedValue(project());
    client.writeScript.mockResolvedValue({ id: 'sc', version: 1, scenes: [], violations: [] });
    await waitFor(() => expect(screen.getByRole('button', { name: /Write my script/ })).toBeEnabled(), { timeout: 5000 });
    fireEvent.click(screen.getByRole('button', { name: /Write my script/ }));
    await waitFor(() => expect(client.writeScript).toHaveBeenCalledWith('p1'));
    expect(client.updateProject).toHaveBeenCalledWith('p1', expect.objectContaining({ purpose: 'story' }));
  });
});
