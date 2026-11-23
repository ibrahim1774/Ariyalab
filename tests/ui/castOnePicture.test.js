// @vitest-environment jsdom
// One picture per character (e2e-4) on the two cast screens: no step where the customer chooses a look, a "Draw again" button
// with its price or free count, and the paid "Make them look like a picture" beside it. Rounds that still hold 3 options keep
// their pick buttons.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
const { default: StepCast } = await import('../../components/maker/StepCast');
const { BalanceProvider } = await import('../../components/maker/BalanceContext');
const { default: SimpleMaker } = await import('../../components/simple/SimpleMaker');

const project = (over = {}) => ({
  id: 'p1', title: 'Barber story', purpose: 'story', offer: 'A barber', audience: null, style: '3d_family', seconds: 30, aspect: '9:16', quality: 'standard',
  mode: 'narrated', step: 'cast', fee_charged: true, consistent_cast: true, files_expire_at: null, reference_id: null, ...over,
});
const one = (over = {}) => ({
  id: 'c1', name: 'Maya', description: 'A young barber.', status: 'ready', chosen_index: 0, image_url: '/maya.png', image_key: 'k0', regens_used: 0, asset_id: null,
  look_asset_id: null, candidates: [{ slot: 0, url: '/maya.png', key: 'k0' }], regen_credits: 0, retry_credits: 0, look_credits: 19, sheet: {}, ...over,
});
const three = (over = {}) => one({ chosen_index: null, image_url: null, image_key: null, candidates: [0, 1, 2].map((i) => ({ slot: i, url: `/m${i}.png`, key: `k${i}` })), ...over });
const photo = { id: 'a1', kind: 'image', name: 'my photo', url: '/api/mock/storage/own/photo.png', seconds: null };

beforeEach(() => {
  for (const fn of Object.values(client)) if (typeof fn?.mockReset === 'function') fn.mockReset();
  client.getPricing.mockResolvedValue({ pricing: DEFAULTS });
  client.getBilling.mockResolvedValue({ v2: true, balance: { plan: 1000, topup: 0, held: 0, available: 1000 }, history: [] });
  client.getAssets.mockResolvedValue([photo]);
});
afterEach(() => cleanup());

const props = (cast, extra = {}) => ({ project: project(), cast, jobs: [], refresh: vi.fn(), onNext: vi.fn(), returnTo: '/', ...extra });

describe('detailed maker, one picture', () => {
  it('shows the one picture with no choosing step, and a way to draw again', () => {
    render(<StepCast {...props([one()])} />);
    expect(screen.getAllByRole('img')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /Pick Maya/ })).toBeNull();
    expect(screen.queryByText('Pick this one')).toBeNull();
    expect(screen.queryByText(/Every character needs a look/)).toBeNull();
    expect(screen.getByText('We drew each character. Draw again if you want a different one.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Draw again (included)' })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Continue to the storyboard/ })).toBeEnabled();
  });

  it('a character still waiting for the server\'s pick can wait, and is not asked to choose', () => {
    render(<StepCast {...props([one({ chosen_index: null, image_url: null, image_key: null })])} />);
    expect(screen.queryByRole('button', { name: /Pick Maya/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Continue to the storyboard/ })).toBeDisabled();
    expect(screen.getByText('Every character needs a picture to continue.')).toBeInTheDocument();
  });

  it('shows one shimmer while the picture is being drawn', () => {
    render(<StepCast {...props([one({ status: 'pending', candidates: [], image_url: null, chosen_index: null })])} />);
    expect(screen.getAllByTestId('candidate-pending')).toHaveLength(1);
  });

  it('draws again with no note needed, free while redraws are included, with the count', async () => {
    client.regenCast.mockResolvedValue({});
    const refresh = vi.fn();
    render(<StepCast {...props([one({ regens_used: 1 })], { refresh })} />);
    expect(screen.getByText(`1 redraw included for Maya, then ${DEFAULTS.castRegen} credits each.`)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Draw again (included)' }));
    await waitFor(() => expect(client.regenCast).toHaveBeenCalledWith('p1', 'c1', '', 0));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('draws again with a note, and shows the price (19) once the free redraws are used', async () => {
    client.regenCast.mockResolvedValue({});
    expect(DEFAULTS.castRegen).toBe(19);
    render(<StepCast {...props([one({ regens_used: 2, regen_credits: 19 })])} />);
    expect(screen.getByText('0 redraws included for Maya, then 19 credits each.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Describe a change'), { target: { value: 'Round glasses' } });
    fireEvent.click(screen.getByRole('button', { name: 'Draw again (19 credits)' }));
    await waitFor(() => expect(client.regenCast).toHaveBeenCalledWith('p1', 'c1', 'Round glasses', 19));
  });

  it('says when a character has no credits for the paid redraw, before the click', async () => {
    render(
      <BalanceProvider balance={{ available: 5 }}>
        <StepCast {...props([one({ regens_used: 2, regen_credits: 19 })])} />
      </BalanceProvider>
    );
    expect(await screen.findAllByText(/You need 14 more credits/)).not.toHaveLength(0);
  });

  it('a round with three options still lets the customer pick one', async () => {
    client.pickCast.mockResolvedValue({});
    render(<StepCast {...props([three()])} />);
    expect(screen.getAllByRole('img')).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'Pick Maya, option 2' }));
    await waitFor(() => expect(client.pickCast).toHaveBeenCalledWith('p1', 'c1', 1));
    expect(screen.getByText('Every character needs a picture to continue.')).toBeInTheDocument();
  });
});

describe('nothing left stuck now that there is no pick button', () => {
  it('a single picture the server has not picked shows one free button to use it, and it is the existing pick call', async () => {
    client.pickCast.mockResolvedValue({});
    const refresh = vi.fn();
    render(<StepCast {...props([one({ chosen_index: null, image_url: null, image_key: null })], { refresh })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Use this picture' }));
    await waitFor(() => expect(client.pickCast).toHaveBeenCalledWith('p1', 'c1', 0));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('a character sheet that did not come out has a free "Try the character sheet again" (the same pick call, no credits)', async () => {
    client.pickCast.mockResolvedValue({});
    render(<StepCast {...props([one({ sheet_state: 'failed' })])} />);
    expect(screen.getByText(/The character sheet did not come out/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use this picture' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try the character sheet again' }));
    await waitFor(() => expect(client.pickCast).toHaveBeenCalledWith('p1', 'c1', 0));
  });

  it('shows neither while the sheet is ready or being made, or for a picture the customer uploaded', () => {
    for (const row of [one({ sheet_state: 'ready' }), one({ sheet_state: 'making' }), one({ sheet_state: 'none', asset_id: 'a9' })]) {
      const { unmount } = render(<StepCast {...props([row])} />);
      expect(screen.queryByRole('button', { name: /Use this picture|Try the character sheet again/ })).toBeNull();
      unmount();
    }
  });

  it('the simple maker dialog has the same two buttons', async () => {
    client.pickCast.mockResolvedValue({});
    client.getChat.mockResolvedValue({ messages: [], usage: { used: 0, limit: 150 } });
    client.getScript.mockResolvedValue({ id: 'sc', version: 1, scenes: [{ id: 'a', title: 'The shop', visual: 'A shop.', lines: [{ speaker: 'Narrator', text: 'Hello.' }] }] });
    client.getQuote.mockResolvedValue({ total: 33, lines: [], holdNeeded: 0, shotIds: [], spent: 0 });
    const withCast = (row) => ({
      project: project({ step: 'audio' }), cast: [row], jobs: [], balance: { available: 1500 }, render: null, renders: [], renderPrice: null,
      shots: [{ id: 'sh1', ord: 0, scene_id: 'a', description: 'Shot', line: 'L', seconds: 3, quality: 'standard', source: 'generated', still_url: '/s.png', clip_url: null, status: 'still_ready', still_credits: 0, clip_credits: 33, clip_price: 33, reroll_credits: null }],
      audio: { applicable: { narration: true, narrationLines: 2 }, narration: { status: 'ready', credits: 0 }, music: { type: 'generated', status: 'ready', credits: 0 }, plan: {} },
    });
    client.getStatus.mockResolvedValue(withCast(one({ sheet_state: 'failed' })));
    render(<SimpleMaker id="p1" returnTo="/app/p/p1" />);
    fireEvent.click(await screen.findByRole('button', { name: /Maya, change this character/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Try the character sheet again' }));
    await waitFor(() => expect(client.pickCast).toHaveBeenCalledWith('p1', 'c1', 0));
  });
});

describe('a round that could not draw keeps the picture (I1)', () => {
  it('says so in plain words on both screens, only while the character is ready and was kept', async () => {
    const line = "We couldn't draw the new look, so Maya keeps their picture.";
    const { rerender } = render(<StepCast {...props([one({ kept_picture: true })])} />);
    expect(screen.getByText(line)).toBeInTheDocument();
    rerender(<StepCast {...props([one({ kept_picture: false })])} />);
    expect(screen.queryByText(line)).toBeNull();
    cleanup();
    client.getChat.mockResolvedValue({ messages: [], usage: { used: 0, limit: 150 } });
    client.getScript.mockResolvedValue({ id: 'sc', version: 1, scenes: [{ id: 'a', title: 'S', visual: 'A.', lines: [{ speaker: 'Narrator', text: 'Hi.' }] }] });
    client.getQuote.mockResolvedValue({ total: 33, lines: [], holdNeeded: 0, shotIds: [], spent: 0 });
    client.getStatus.mockResolvedValue({
      project: project({ step: 'audio' }), cast: [one({ kept_picture: true })], jobs: [], balance: { available: 1500 }, render: null, renders: [], renderPrice: null,
      shots: [{ id: 'sh1', ord: 0, scene_id: 'a', description: 'Shot', line: 'L', seconds: 3, quality: 'standard', source: 'generated', still_url: '/s.png', clip_url: null, status: 'still_ready', still_credits: 0, clip_credits: 33, clip_price: 33, reroll_credits: null }],
      audio: { applicable: { narration: true, narrationLines: 2 }, narration: { status: 'ready', credits: 0 }, music: { type: 'generated', status: 'ready', credits: 0 }, plan: {} },
    });
    render(<SimpleMaker id="p1" returnTo="/app/p/p1" />);
    fireEvent.click(await screen.findByRole('button', { name: /Maya, change this character/ }));
    expect(within(await screen.findByRole('dialog')).getByText(line)).toBeInTheDocument();
  });
});

describe('detailed maker, make them look like a picture', () => {
  const open = async () => {
    fireEvent.click(screen.getByRole('button', { name: /^Make them look like a picture/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Use my photo' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  };

  it('shows the button with its price, the sentence under it and the rights line', () => {
    render(<StepCast {...props([one()])} />);
    expect(screen.getByRole('button', { name: 'Make them look like a picture (19 credits)' })).toBeEnabled();
    expect(screen.getByText("Upload a picture and we'll draw this character to look like it, in your video's style.")).toBeInTheDocument();
    expect(screen.getByText('Only use pictures you have the right to use.')).toBeInTheDocument();
  });

  it('is priced from the server number, not a guess', () => {
    render(<StepCast {...props([one({ look_credits: 25 })])} />);
    expect(screen.getByRole('button', { name: 'Make them look like a picture (25 credits)' })).toBeInTheDocument();
  });

  it('picking a picture charges nothing: it shows the picture and the price, then draws only on the second press, with the price and the note', async () => {
    client.drawLikePicture.mockResolvedValue({});
    const refresh = vi.fn();
    render(<StepCast {...props([one()], { refresh })} />);
    await open();
    expect(client.drawLikePicture).not.toHaveBeenCalled();
    const panel = screen.getByTestId('look-confirm');
    expect(within(panel).getByRole('img')).toHaveAttribute('src', photo.url);
    fireEvent.change(within(panel).getByLabelText('Anything to add? (optional)'), { target: { value: 'with a beard' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Draw Maya like this (19 credits)' }));
    await waitFor(() => expect(client.drawLikePicture).toHaveBeenCalledWith('p1', 'c1', 'a1', 'with a beard', 19));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId('look-confirm')).toBeNull());
  });

  it('never counts against the free redraws: the count line is the same before and after', async () => {
    render(<StepCast {...props([one({ regens_used: 0 })])} />);
    expect(screen.getByText(`2 redraws included for Maya, then ${DEFAULTS.castRegen} credits each.`)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Make them look like a picture (19 credits)' })).toBeInTheDocument();
  });

  it('a changed price (409) refreshes and keeps the picture so the customer sees the new price and presses again', async () => {
    client.drawLikePicture.mockRejectedValue(new StoryApiError({ status: 409, code: 'quote_changed', message: 'The price for Maya is now 25 credits. Check it and try again.' }));
    const refresh = vi.fn();
    render(<StepCast {...props([one()], { refresh })} />);
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Draw Maya like this (19 credits)' }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(screen.getByTestId('look-confirm')).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent(/25 credits/);
  });

  it('too few credits says so under the button before the click', async () => {
    render(
      <BalanceProvider balance={{ available: 10 }}>
        <StepCast {...props([one()])} />
      </BalanceProvider>
    );
    expect(await screen.findAllByText(/You need 9 more credits/)).not.toHaveLength(0);
  });

  it('says which picture the character was drawn from, and the look round is not blocked while drawing', () => {
    const { rerender } = render(<StepCast {...props([one({ look_asset_id: 'a1' })])} />);
    expect(screen.getByText('Drawn to look like a picture you chose.')).toBeInTheDocument();
    rerender(<StepCast {...props([one({ status: 'pending', candidates: [], image_url: null, chosen_index: null })])} />);
    expect(screen.queryByRole('button', { name: /Make them look like a picture/ })).toBeNull();
  });
});

describe('simple maker, the character dialog', () => {
  const status = (cast) => ({
    project: project({ step: 'audio' }),
    cast,
    shots: [1, 2].map((i) => ({
      id: `sh${i}`, ord: i - 1, scene_id: 'a', description: `Shot ${i}`, line: `Line ${i}`, seconds: 3, quality: 'standard', source: 'generated',
      still_url: `/s${i}.png`, clip_url: null, status: 'still_ready', still_credits: 0, clip_credits: 33, clip_price: 33, reroll_credits: null,
    })),
    jobs: [], balance: { available: 1500 }, render: null, renders: [], renderPrice: null,
    audio: { applicable: { narration: true, narrationLines: 2 }, narration: { status: 'ready', credits: 0 }, music: { type: 'generated', status: 'ready', credits: 0 }, plan: {} },
  });
  const SCRIPT = { id: 'sc', version: 1, scenes: [{ id: 'a', title: 'The shop', visual: 'A shop.', lines: [{ speaker: 'Narrator', text: 'Hello.' }] }] };
  beforeEach(() => {
    client.getChat.mockResolvedValue({ messages: [], usage: { used: 0, limit: 150 } });
    client.getScript.mockResolvedValue(SCRIPT);
    client.getQuote.mockImplementation(async (id, ids) => ({ total: ids.length * 33, lines: [], holdNeeded: 0, shotIds: ids, spent: 0 }));
  });
  const openDialog = async (cast) => {
    client.getStatus.mockResolvedValue(status(cast));
    render(<SimpleMaker id="p1" returnTo="/app/p/p1" />);
    fireEvent.click(await screen.findByRole('button', { name: /Maya, change this character/ }));
    return screen.findByRole('dialog');
  };

  it('shows the character\'s picture, Draw again with its price, and the new option below, with no choosing step', async () => {
    const dialog = await openDialog([one({ regens_used: 2, regen_credits: 19 })]);
    expect(within(dialog).queryByRole('button', { name: /Pick Maya/ })).toBeNull();
    expect(within(dialog).getByRole('img', { name: 'Maya' })).toHaveAttribute('src', '/maya.png');
    expect(within(dialog).getByRole('button', { name: 'Draw again (19 credits)' })).toBeEnabled();
    expect(within(dialog).getByRole('button', { name: 'Make them look like a picture (19 credits)' })).toBeEnabled();
    expect(within(dialog).getByText("Upload a picture and we'll draw this character to look like it, in your video's style.")).toBeInTheDocument();
    expect(within(dialog).getByText('Only use pictures you have the right to use.')).toBeInTheDocument();
    expect(within(dialog).getByText(`0 redraws included for Maya, then 19 credits each.`)).toBeInTheDocument();
  });

  it('Draw again is free while redraws are included, needs no note, and sends the quote it showed', async () => {
    client.regenCast.mockResolvedValue({});
    const dialog = await openDialog([one()]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Draw again (included)' }));
    await waitFor(() => expect(client.regenCast).toHaveBeenCalledWith('p1', 'c1', '', 0));
  });

  it('make them look like a picture: pick, see the price, then draw with the price and the note', async () => {
    client.drawLikePicture.mockResolvedValue({});
    const dialog = await openDialog([one()]);
    fireEvent.click(within(dialog).getByRole('button', { name: /^Make them look like a picture/ }));
    const chooser = (await screen.findAllByRole('dialog')).at(-1);
    fireEvent.click(await within(chooser).findByRole('button', { name: 'Use my photo' }));
    const panel = await screen.findByTestId('look-confirm');
    fireEvent.change(within(panel).getByLabelText('Anything to add? (optional)'), { target: { value: 'older' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Draw Maya like this (19 credits)' }));
    await waitFor(() => expect(client.drawLikePicture).toHaveBeenCalledWith('p1', 'c1', 'a1', 'older', 19));
  });

  it('a round with three options still shows its pick buttons in the dialog and in the plan', async () => {
    client.pickCast.mockResolvedValue({});
    client.getStatus.mockResolvedValue(status([three()]));
    render(<SimpleMaker id="p1" returnTo="/app/p/p1" />);
    const card = await screen.findByTestId('pick-look');
    expect(card).toHaveTextContent('Pick a look for Maya');
    fireEvent.click(within(card).getByRole('button', { name: 'Pick Maya, option 2' }));
    await waitFor(() => expect(client.pickCast).toHaveBeenCalledWith('p1', 'c1', 1));
  });

  it('one picture that the server has not picked yet shows no "Pick a look" question', async () => {
    client.getStatus.mockResolvedValue(status([one({ chosen_index: null, image_url: null, image_key: null })]));
    render(<SimpleMaker id="p1" returnTo="/app/p/p1" />);
    await screen.findByRole('button', { name: /Maya, change this character/ });
    expect(screen.queryByTestId('pick-look')).toBeNull();
    expect(screen.queryByText(/Pick a look/)).toBeNull();
  });
});
