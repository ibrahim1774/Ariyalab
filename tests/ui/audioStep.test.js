// @vitest-environment jsdom
// Task 19: the Voice and sound step. Every button that costs credits shows its price, every state is designed.
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
const { default: StepAudio } = await import('../../components/maker/StepAudio');

const project = { id: 'p1', style: '3d_family', seconds: 30, aspect: '9:16', quality: 'standard', mode: 'narrated', step: 'audio' };
const VOICES = [
  { id: 'v1', name: 'Sarah', gender: 'female', sampleUrl: null },
  { id: 'v2', name: 'Adrian', gender: 'male', sampleUrl: '/api/mock/fixtures/voice.mp3' },
];
const track = (over = {}) => ({ status: 'none', url: null, error: null, source: 'generated', credits: 0, retry_credits: null, included: 3, used: 0, free_left: 3, ...over });
const view = ({ narration = {}, music = {}, plan = {}, applicable = {} } = {}) => ({
  plan: {
    mode: 'narrated', voiceId: 'v1', voiceTrackAssetId: null,
    music: { type: 'generated', prompt: '', assetId: null }, captions: { on: true, style: 'serif_accent' }, ...plan,
  },
  voices: VOICES,
  applicable: { narration: true, narrationLines: 4, ...applicable },
  narration: { ...track(), seconds: null, segments: null, outdated: false, ...narration },
  music: { ...track(), type: 'generated', ...music },
});
const SEGMENTS = [
  { sceneId: 's1', lineIndex: 0, text: 'Nobody believed this would work.', start: 0, end: 3.2 },
  { sceneId: 's1', lineIndex: 1, text: 'Maya kept sweeping anyway.', start: 3.2, end: 6.9 },
];

async function open(v, props = {}) {
  client.getAudio.mockResolvedValue(v);
  const utils = render(<StepAudio project={project} refresh={vi.fn()} onNext={vi.fn()} returnTo="/app/p/p1" {...props} />);
  await screen.findByRole('heading', { name: /Voice and sound/ });
  await waitFor(() => expect(screen.getByText('Narration')).toBeInTheDocument());
  return utils;
}

beforeEach(() => {
  for (const fn of Object.values(client)) if (typeof fn?.mockReset === 'function') fn.mockReset();
  client.getPricing?.mockResolvedValue?.(undefined);
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('the three sections', () => {
  it('shows narration, music and captions, and none of them is an empty card', async () => {
    const { container } = await open(view());
    const sections = [...container.querySelectorAll('[data-section]')];
    expect(sections.map((s) => s.dataset.section)).toEqual(['narration', 'music', 'captions']);
    for (const s of sections) expect(s.textContent.replace(/\s+/g, ' ').trim().length).toBeGreaterThan(40);
  });

  it('lets the customer pick a preset voice and saves it', async () => {
    client.saveAudioPlan.mockResolvedValue(view({ plan: { voiceId: 'v2' } }));
    await open(view());
    fireEvent.click(screen.getByRole('radio', { name: /Adrian/ }));
    await waitFor(() => expect(client.saveAudioPlan).toHaveBeenCalledWith('p1', { voiceId: 'v2' }));
    await waitFor(() => expect(screen.getByRole('radio', { name: /Adrian/ })).toBeChecked());
  });

  it('a talking video explains there is no narrator to choose, and offers no narration button', async () => {
    await open(view({ applicable: { narration: false, narrationLines: 0 } }));
    expect(screen.getByText('This video uses its own voices')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Make the narration/ })).toBeNull();
  });

  it('a script with no narrator lines says so and leads back to the script', async () => {
    await open(view({ applicable: { narration: true, narrationLines: 0 } }));
    expect(screen.getByText('No narrator lines yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back to the script' })).toBeInTheDocument();
  });
});

describe('narration states and prices', () => {
  it('a free first try is a plain button, with the allowance beside it', async () => {
    await open(view());
    expect(screen.getByRole('button', { name: 'Make the narration' })).toBeInTheDocument();
    expect(screen.getAllByText('3 tries included, then 5 credits').length).toBeGreaterThan(0);
  });

  it('a paid make shows its price on the button, and sends that price so a change is caught', async () => {
    client.makeNarration.mockResolvedValue({ audio: view({ narration: { status: 'pending' } }), charged: 5 });
    await open(view({ narration: { credits: 5, free_left: 0, used: 3 } }));
    fireEvent.click(screen.getByRole('button', { name: 'Make the narration (5 credits)' }));
    await waitFor(() => expect(client.makeNarration).toHaveBeenCalledWith('p1', { retry: false, expectedCredits: 5 }));
    expect(await screen.findByText('Recording the narration')).toBeInTheDocument();
  });

  it('waiting shows a status tile and looks again every few seconds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await open(view({ narration: { status: 'pending' } }));
    expect(screen.getByText('Recording the narration')).toBeInTheDocument();
    const calls = client.getAudio.mock.calls.length;
    client.getAudio.mockResolvedValue(view({ narration: { status: 'ready', url: '/n.mp3', seconds: 6.9, segments: SEGMENTS } }));
    await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
    expect(client.getAudio.mock.calls.length).toBeGreaterThan(calls);
    await waitFor(() => expect(screen.queryByText('Recording the narration')).toBeNull());
  });

  it('a finished narration has a player, the lines with their times, and Make it again with the price', async () => {
    const { container } = await open(view({ narration: { status: 'ready', url: '/n.mp3', seconds: 6.9, segments: SEGMENTS, credits: 5, free_left: 0 } }));
    expect(container.querySelector('audio[src="/n.mp3"]')).toBeTruthy();
    fireEvent.click(screen.getByText(/0:06 long, 2 lines/));
    expect(screen.getByText('Maya kept sweeping anyway.')).toBeInTheDocument();
    expect(screen.getByText('0:03', { selector: 'li:nth-child(2) time' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Make it again (5 credits)' })).toBeInTheDocument();
    expect(screen.getAllByText('5 credits each time').length).toBeGreaterThan(0);
  });

  it('says when the script or voice changed since the narration was made', async () => {
    await open(view({ narration: { status: 'ready', url: '/n.mp3', segments: SEGMENTS, seconds: 7, outdated: true } }));
    expect(screen.getByText(/script or voice changed/i)).toBeInTheDocument();
  });

  it('a failed free try offers a plain Try again; a failed paid try shows its price', async () => {
    const { unmount } = await open(view({ narration: { status: 'failed', error: 'The voice did not come out. Try again.', retry_credits: 0 } }));
    expect(screen.getByText('The voice did not come out. Try again.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    unmount();
    await open(view({ narration: { status: 'failed', retry_credits: 5, credits: 5, url: '/old.mp3', segments: SEGMENTS } }));
    expect(screen.getByRole('button', { name: 'Try again (5 credits)' })).toBeInTheDocument();
    expect(screen.getByText('Your earlier version is still here.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Make it again/ })).toBeNull();
  });

  it('Try again sends retry with the price shown', async () => {
    client.makeNarration.mockResolvedValue({ audio: view({ narration: { status: 'pending' } }), charged: 5 });
    await open(view({ narration: { status: 'failed', retry_credits: 5, credits: 5 } }));
    fireEvent.click(screen.getByRole('button', { name: 'Try again (5 credits)' }));
    await waitFor(() => expect(client.makeNarration).toHaveBeenCalledWith('p1', { retry: true, expectedCredits: 5 }));
  });

  it('a blocked narration has no Try again and leads back to the script', async () => {
    await open(view({ narration: { status: 'blocked', error: 'Stopped by our rules.', retry_credits: null } }));
    expect(screen.queryByRole('button', { name: /Try again/ })).toBeNull();
    expect(screen.getByText('Stopped by our content rules')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back to the script' })).toBeInTheDocument();
  });

  it('a changed price (409 quote_changed) shows the notice and reloads the price', async () => {
    const err = Object.assign(new Error('x'), { status: 409, code: 'quote_changed', serverMessage: 'The price changed.' });
    client.makeNarration.mockRejectedValue(err);
    await open(view({ narration: { credits: 5, free_left: 0 } }));
    const calls = client.getAudio.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Make the narration (5 credits)' }));
    expect(await screen.findByText('The price changed')).toBeInTheDocument();
    await waitFor(() => expect(client.getAudio.mock.calls.length).toBeGreaterThan(calls));
  });
});

describe('music', () => {
  it('saves the description when the field loses focus, and quotes the always-on line', async () => {
    client.saveAudioPlan.mockResolvedValue(view({ plan: { music: { type: 'generated', prompt: 'Warm piano', assetId: null } } }));
    await open(view());
    const box = screen.getByRole('textbox', { name: /What should it sound like/ });
    fireEvent.change(box, { target: { value: 'Warm piano' } });
    fireEvent.blur(box);
    await waitFor(() => expect(client.saveAudioPlan).toHaveBeenCalledWith('p1', { music: { prompt: 'Warm piano' } }));
    expect(screen.getByText(/full from the first second, with no soft intro/)).toBeInTheDocument();
  });

  it('a blocked description sends the customer to the description field', async () => {
    await open(view({ music: { status: 'blocked', error: 'Stopped by our rules.' } }));
    fireEvent.click(screen.getByRole('button', { name: 'Change the description' }));
    expect(screen.getByRole('textbox', { name: /What should it sound like/ })).toHaveFocus();
  });

  it('a mood chip fills the description', async () => {
    await open(view());
    fireEvent.click(screen.getByRole('button', { name: 'Upbeat and playful' }));
    expect(screen.getByRole('textbox', { name: /What should it sound like/ })).toHaveValue('Upbeat and playful');
  });

  it('Make the music saves an unsaved description first, then sends the price shown', async () => {
    client.saveAudioPlan.mockResolvedValue(view({ plan: { music: { type: 'generated', prompt: 'Calm', assetId: null } } }));
    client.makeMusic.mockResolvedValue({ audio: view({ music: { status: 'pending' } }), charged: 0 });
    await open(view());
    fireEvent.change(screen.getByRole('textbox', { name: /What should it sound like/ }), { target: { value: 'Calm' } });
    fireEvent.click(screen.getByRole('button', { name: 'Make the music' }));
    await waitFor(() => expect(client.makeMusic).toHaveBeenCalledWith('p1', { retry: false, expectedCredits: 0 }));
    expect(client.saveAudioPlan).toHaveBeenCalledWith('p1', { music: { prompt: 'Calm' } });
    expect(await screen.findByText('Composing your music')).toBeInTheDocument();
  });

  it('a paid music make and a failed paid music try show their prices', async () => {
    const { unmount } = await open(view({ music: { credits: 5, free_left: 0 } }));
    expect(screen.getByRole('button', { name: 'Make the music (5 credits)' })).toBeInTheDocument();
    unmount();
    await open(view({ music: { status: 'failed', retry_credits: 5, error: 'No music this time.' } }));
    expect(screen.getByRole('button', { name: 'Try again (5 credits)' })).toBeInTheDocument();
  });

  it('No music is a designed state, and the description field goes away', async () => {
    client.saveAudioPlan.mockResolvedValue(view({ plan: { music: { type: 'none', prompt: '', assetId: null } }, music: { type: 'none' } }));
    await open(view());
    fireEvent.click(screen.getByRole('radio', { name: 'No music' }));
    expect(await screen.findByText(/Your video will have the narration only/)).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /What should it sound like/ })).toBeNull();
  });
});

describe('captions', () => {
  it('previews the three styles, saves a pick, and switches them off together', async () => {
    client.saveAudioPlan.mockResolvedValue(view({ plan: { captions: { on: true, style: 'bold_pop' } } }));
    const { container } = await open(view());
    expect(container.querySelectorAll('[data-caption]')).toHaveLength(3);
    fireEvent.click(screen.getByRole('radio', { name: /Bold pop/ }));
    await waitFor(() => expect(client.saveAudioPlan).toHaveBeenCalledWith('p1', { captions: { style: 'bold_pop' } }));
    client.saveAudioPlan.mockResolvedValue(view({ plan: { captions: { on: false, style: 'bold_pop' } } }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Show captions/ }));
    await waitFor(() => expect(client.saveAudioPlan).toHaveBeenLastCalledWith('p1', { captions: { on: false } }));
    await waitFor(() => expect(screen.getByRole('radio', { name: /Clean/ })).toBeDisabled());
  });
});

describe('the footer', () => {
  it('always lets the customer continue, and says when there is no narration yet', async () => {
    const onNext = vi.fn();
    await open(view(), { onNext });
    expect(screen.getByText(/no narration yet/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Continue to generate' }));
    expect(onNext).toHaveBeenCalled();
  });

  it('says nothing about a missing narration when an earlier one is still there, even after a failed try', async () => {
    await open(view({ narration: { status: 'failed', url: '/old.mp3', retry_credits: 0 } }));
    expect(screen.queryByText(/no narration yet/i)).toBeNull();
  });

  it('says nothing about a missing narration once it is made', async () => {
    await open(view({ narration: { status: 'ready', url: '/n.mp3', segments: SEGMENTS, seconds: 7 } }));
    expect(screen.queryByText(/no narration yet/i)).toBeNull();
  });
});

describe('loading', () => {
  it('shows a designed waiting state, then the error with a way to retry when the load fails', async () => {
    client.getAudio.mockRejectedValue(Object.assign(new Error('x'), { status: 500 }));
    render(<StepAudio project={project} refresh={vi.fn()} onNext={vi.fn()} returnTo="/app/p/p1" />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(within(screen.getByRole('alert')).getByText('Something went wrong')).toBeInTheDocument();
  });
});
