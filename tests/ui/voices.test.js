// @vitest-environment jsdom
// Task 24: the Voices page, voice previews, and the own-recording and own-track uploads on the Voice and sound step.
// Every state is designed (empty, waiting, failed, ready), every priced button shows its price.
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
vi.mock('next/router', () => ({ useRouter: () => ({ replace: vi.fn(), isReady: true, query: {}, asPath: '/app/voices', pathname: '/app/voices' }) }));
vi.mock('next/head', () => ({ default: ({ children }) => <>{children}</> }));

const client = await import('../../lib/story/client');
const { default: VoicesPage } = await import('../../pages/app/voices');
const { default: StepAudio } = await import('../../components/maker/StepAudio');
const { CONSENT_STATEMENT } = await import('../../lib/story/voiceRules');
const { StoryApiError } = client;

const voice = (over = {}) => ({
  id: 'c1', name: 'Maya', status: 'ready', error: null, voiceId: 'fish-c1', sampleUrl: '/api/mock/storage/story-audio/u/take.wav', seconds: 12.4,
  consent_at: '2026-11-14T10:00:00.000Z', created_at: '2026-11-14T10:00:00.000Z', credits: 20, retry_credits: null, ...over,
});
const listing = (over = {}) => ({
  voices: [],
  presets: [
    { id: 'p1', name: 'Sarah', gender: 'female', sampleUrl: '/api/mock/fixtures/voice.mp3' },
    { id: 'p2', name: 'Adrian', gender: 'male', sampleUrl: null },
  ],
  price: 20,
  statement: CONSENT_STATEMENT,
  limits: { sampleMinSeconds: 10, sampleMaxSeconds: 60, maxBytes: 20 * 1024 * 1024 },
  ...over,
});
const asset = (over = {}) => ({ id: 'a1', kind: 'voice_sample', name: 'take', url: '/api/mock/storage/story-audio/u/take.wav', seconds: 12.4, bytes: 500000, ...over });
const file = (name = 'take.wav', type = 'audio/wav') => new File([new Uint8Array(1000)], name, { type });

async function openPage(data = listing()) {
  client.getVoices.mockResolvedValue(data);
  const utils = render(<VoicesPage />);
  await screen.findByRole('heading', { name: /voices/i, level: 1 });
  await waitFor(() => expect(client.getVoices).toHaveBeenCalled());
  await waitFor(() => expect(screen.queryByText('Loading your voices')).not.toBeInTheDocument());
  return utils;
}
const pickSample = async (f = file()) => {
  const input = document.querySelector('input[type="file"]');
  await act(async () => { fireEvent.change(input, { target: { files: [f] } }); });
};

beforeEach(() => {
  for (const fn of Object.values(client)) if (typeof fn?.mockReset === 'function') fn.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('the Voices page', () => {
  it('with no clones shows a designed empty state, the clone form with its price, and the included voices with previews', async () => {
    await openPage();
    expect(screen.getByText('No cloned voices yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Clone this voice \(20 credits\)/ })).toBeDisabled();
    const included = screen.getByRole('region', { name: 'Included voices' });
    expect(within(included).getByText('Sarah')).toBeInTheDocument();
    expect(included.querySelectorAll('audio')).toHaveLength(1); // Sarah plays
    expect(within(included).getByText('Preview not available')).toBeInTheDocument(); // Adrian has none: a designed state, not a gap
  });

  it('shows the consent statement exactly as the server sent it, unticked', async () => {
    await openPage(listing({ statement: 'Server words for consent.' }));
    const box = screen.getByRole('checkbox', { name: 'Server words for consent.' });
    expect(box).not.toBeChecked();
  });

  it('keeps Clone disabled until there is a name, a sample and consent, then clones with consent true and the shown price', async () => {
    client.uploadAudio.mockResolvedValue(asset());
    client.cloneVoice.mockResolvedValue({ voice: voice(), charged: 20 });
    await openPage();
    const button = screen.getByRole('button', { name: /Clone this voice/ });
    fireEvent.change(screen.getByLabelText('Name this voice'), { target: { value: 'Maya' } });
    expect(button).toBeDisabled();
    await pickSample();
    expect(client.uploadAudio).toHaveBeenCalledWith(expect.any(File), 'voice_sample', expect.any(Object));
    await screen.findByText(/12 seconds/);
    expect(button).toBeDisabled(); // still no consent
    fireEvent.click(screen.getByRole('checkbox', { name: CONSENT_STATEMENT }));
    expect(button).toBeEnabled();
    client.getVoices.mockResolvedValue(listing({ voices: [voice()] }));
    await act(async () => { fireEvent.click(button); });
    expect(client.cloneVoice).toHaveBeenCalledWith({ name: 'Maya', consent: true, sampleAssetId: 'a1', expectedCredits: 20 });
    await screen.findByText('Ready to pick on the Voice and sound step');
  });

  it('shows the waiting state while a clone is made, and looks again by itself', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    client.getVoices.mockResolvedValueOnce(listing({ voices: [voice({ status: 'pending', voiceId: null, retry_credits: null })] }));
    render(<VoicesPage />);
    await screen.findByText('Cloning your voice');
    client.getVoices.mockResolvedValue(listing({ voices: [voice()] }));
    await act(async () => { await vi.advanceTimersByTimeAsync(3200); });
    await screen.findByText('Ready to pick on the Voice and sound step');
    expect(screen.queryByText('Cloning your voice')).not.toBeInTheDocument();
  });

  it('a failed clone says why, that nothing was charged, and offers Try again with its price', async () => {
    client.retryVoiceClone.mockResolvedValue({ voice: voice(), charged: 20 });
    await openPage(listing({ voices: [voice({ status: 'failed', voiceId: null, error: 'The service is busy right now. Please try again in a minute.', retry_credits: 20 })] }));
    expect(screen.getByText('The voice could not be cloned')).toBeInTheDocument();
    expect(screen.getByText(/The service is busy right now/)).toBeInTheDocument();
    client.getVoices.mockResolvedValue(listing({ voices: [voice()] }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Try again (20 credits)' })); });
    expect(client.retryVoiceClone).toHaveBeenCalledWith('c1', 20);
  });

  it('a ready voice plays back the customer\'s own recording, and a voice with no recording has a designed preview state', async () => {
    await openPage(listing({ voices: [voice(), voice({ id: 'c2', name: 'Leo', voiceId: 'fish-c2', sampleUrl: null })] }));
    const mine = screen.getByRole('region', { name: 'Your voices' });
    const cards = within(mine).getAllByRole('listitem');
    expect(cards).toHaveLength(2);
    expect(cards[0].querySelector('audio')).toBeTruthy();
    expect(within(cards[1]).getByText('Preview not available')).toBeInTheDocument();
  });

  it('deleting asks first, then removes the voice and reloads', async () => {
    client.deleteVoiceClone.mockResolvedValue({ deleted: true });
    await openPage(listing({ voices: [voice()] }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete Maya' }));
    expect(client.deleteVoiceClone).not.toHaveBeenCalled();
    expect(screen.getByText(/Delete this voice\?/)).toBeInTheDocument();
    client.getVoices.mockResolvedValue(listing());
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Yes, delete it' })); });
    expect(client.deleteVoiceClone).toHaveBeenCalledWith('c1');
    await screen.findByText('No cloned voices yet');
  });

  it('refused uploads and failed clones show the server\'s words, and the page reloads its list', async () => {
    client.uploadAudio.mockRejectedValue(new StoryApiError({ status: 422, code: 'validation_failed', message: 'Your sample is 9 seconds. Record at least 10 seconds of clear speech.' }));
    await openPage();
    await pickSample();
    expect(await screen.findByText(/Your sample is 9 seconds/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Clone this voice/ })).toBeDisabled();

    client.uploadAudio.mockResolvedValue(asset());
    await pickSample();
    await screen.findByText(/12 seconds/);
    fireEvent.change(screen.getByLabelText('Name this voice'), { target: { value: 'Maya' } });
    fireEvent.click(screen.getByRole('checkbox', { name: CONSENT_STATEMENT }));
    client.cloneVoice.mockRejectedValue(new StoryApiError({ status: 402, code: 'insufficient_credits', needed: 20, available: 5 }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Clone this voice/ })); });
    expect(await screen.findByText('Not enough credits')).toBeInTheDocument();
    expect(client.getVoices.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('a price that changed is shown, not charged: the page reloads the new price', async () => {
    client.uploadAudio.mockResolvedValue(asset());
    await openPage();
    await pickSample();
    await screen.findByText(/12 seconds/);
    fireEvent.change(screen.getByLabelText('Name this voice'), { target: { value: 'Maya' } });
    fireEvent.click(screen.getByRole('checkbox', { name: CONSENT_STATEMENT }));
    client.cloneVoice.mockRejectedValue(new StoryApiError({ status: 409, code: 'quote_changed' }));
    client.getVoices.mockResolvedValue(listing({ price: 25 }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Clone this voice (20 credits)' })); });
    expect(await screen.findByRole('button', { name: 'Clone this voice (25 credits)' })).toBeInTheDocument();
  });

  it('has no empty card and no dashes in its words', async () => {
    const { container } = await openPage(listing({ voices: [voice(), voice({ id: 'c2', status: 'failed', voiceId: null, error: null, retry_credits: 20 }), voice({ id: 'c3', status: 'pending', voiceId: null })] }));
    for (const card of container.querySelectorAll('[data-card]')) expect(card.textContent.replace(/\s+/g, ' ').trim().length).toBeGreaterThan(30);
    expect(container.textContent).not.toMatch(/[–—]| - /);
  });

  it('a page that cannot load says so, with a way to try again', async () => {
    client.getVoices.mockRejectedValueOnce(new StoryApiError({ status: 0, code: 'network' }));
    render(<VoicesPage />);
    expect(await screen.findByText('No connection')).toBeInTheDocument();
    client.getVoices.mockResolvedValue(listing());
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Refresh' })); });
    await screen.findByText('No cloned voices yet');
  });
});

describe('uploadAudio (the checks before anything is uploaded)', () => {
  it('refuses another type and a file over 20 MB with the same words the server uses', async () => {
    const real = await vi.importActual('../../lib/story/client');
    await expect(real.uploadAudio(file('song.ogg', 'audio/ogg'), 'music')).rejects.toMatchObject({ status: 422, message: 'Only MP3, WAV and M4A files can be used.' });
    const big = new File([new Uint8Array(1)], 'big.wav');
    Object.defineProperty(big, 'size', { value: 21 * 1024 * 1024 });
    await expect(real.uploadAudio(big, 'music')).rejects.toMatchObject({ status: 422, message: 'This file is larger than 20 MB. Trim or compress it and try again.' });
  });
});

// ---------------------------------------------------------------- the Voice and sound step

const project = { id: 'p1', style: '3d_family', seconds: 30, aspect: '9:16', quality: 'standard', mode: 'narrated', step: 'audio' };
const track = (over = {}) => ({ status: 'none', url: null, error: null, source: 'generated', credits: 0, retry_credits: null, included: 3, used: 0, free_left: 3, ...over });
const audioView = ({ voices, plan = {}, uploads = { voiceTrack: null, music: null }, narration = {}, music = {} } = {}) => ({
  plan: { mode: 'narrated', voiceId: 'v1', voiceTrackAssetId: null, music: { type: 'generated', prompt: '', assetId: null }, captions: { on: true, style: 'serif_accent' }, ...plan },
  uploads,
  voices: voices || [
    { id: 'v1', name: 'Sarah', gender: 'female', sampleUrl: '/api/mock/fixtures/voice.mp3' },
    { id: 'v2', name: 'Adrian', gender: 'male', sampleUrl: null },
    { id: 'fish-c1', name: 'Maya', gender: null, sampleUrl: '/api/mock/storage/story-audio/u/take.wav', own: true },
  ],
  applicable: { narration: true, narrationLines: 4 },
  narration: { ...track(), seconds: null, segments: null, outdated: false, ...narration },
  music: { ...track(), type: 'generated', ...music },
});
async function openStep(view) {
  client.getAudio.mockResolvedValue(view);
  client.getPricing?.mockResolvedValue?.(undefined);
  const utils = render(<StepAudio project={project} refresh={vi.fn()} onNext={vi.fn()} returnTo="/app/p/p1" />);
  await screen.findByRole('heading', { name: /Voice and sound/ });
  await waitFor(() => expect(screen.getByText('Narration')).toBeInTheDocument());
  return utils;
}
const narrationCard = (container) => container.querySelector('[data-section="narration"]');
const musicCard = (container) => container.querySelector('[data-section="music"]');
const chooseFile = async (card, f) => {
  const input = card.querySelector('input[type="file"]');
  await act(async () => { fireEvent.change(input, { target: { files: [f] } }); });
};

describe('Voice and sound: voices', () => {
  it('lists the customer\'s own voice beside the included ones, marked as theirs, and picks it', async () => {
    const { container } = await openStep(audioView());
    const card = narrationCard(container);
    const own = within(card).getByRole('radio', { name: /Maya/ });
    expect(own.closest('label')).toHaveTextContent('Your voice');
    client.saveAudioPlan.mockResolvedValue(audioView({ plan: { voiceId: 'fish-c1' } }));
    await act(async () => { fireEvent.click(own); });
    expect(client.saveAudioPlan).toHaveBeenCalledWith('p1', { voiceId: 'fish-c1' });
    const player = card.querySelector('audio[aria-label="Voice sample"]');
    expect(player).toHaveAttribute('src', '/api/mock/storage/story-audio/u/take.wav');
  });

  it('a voice with no sample shows a designed "Preview not available" state instead of nothing', async () => {
    const { container } = await openStep(audioView({ plan: { voiceId: 'v2' } }));
    const card = narrationCard(container);
    expect(card.querySelector('audio[aria-label="Voice sample"]')).toBeNull();
    expect(within(card).getByText('Preview not available')).toBeInTheDocument();
  });

  it('links to the Voices page to clone a voice, and says what a clone costs only on that page', async () => {
    const { container } = await openStep(audioView({ voices: [{ id: 'v1', name: 'Sarah', gender: 'female', sampleUrl: null }] }));
    const link = within(narrationCard(container)).getByRole('link', { name: /Clone my voice/ });
    expect(link).toHaveAttribute('href', '/app/voices');
  });
});

describe('Voice and sound: own recording and own track', () => {
  it('uploads the customer\'s own recording as a voice track and puts it in the plan', async () => {
    client.uploadAudio.mockResolvedValue({ id: 'a9', kind: 'voice_track', name: 'My narration', url: '/x.wav', seconds: 31, bytes: 1 });
    client.saveAudioPlan.mockResolvedValue(audioView({ plan: { voiceTrackAssetId: 'a9' }, uploads: { voiceTrack: { id: 'a9', name: 'My narration', seconds: 31 }, music: null } }));
    const { container } = await openStep(audioView());
    const card = narrationCard(container);
    expect(within(card).getByRole('button', { name: /Use my own recording/ })).toBeEnabled();
    expect(within(card).queryByText(/coming with brand kit/i)).toBeNull();
    const f = file('my-narration.mp3', 'audio/mpeg');
    await chooseFile(card, f);
    expect(client.uploadAudio).toHaveBeenCalledWith(f, 'voice_track', expect.any(Object));
    expect(client.saveAudioPlan).toHaveBeenCalledWith('p1', { voiceTrackAssetId: 'a9' });
    expect(await within(card).findByText(/My narration/)).toBeInTheDocument();
    expect(within(card).getByText(/It costs nothing/)).toBeInTheDocument();
  });

  it('removes the recording and goes back to a voice from the list', async () => {
    client.saveAudioPlan.mockResolvedValue(audioView());
    const { container } = await openStep(audioView({ plan: { voiceTrackAssetId: 'a9' }, uploads: { voiceTrack: { id: 'a9', name: 'My narration', seconds: 31 }, music: null } }));
    const card = narrationCard(container);
    await act(async () => { fireEvent.click(within(card).getByRole('button', { name: 'Remove my recording' })); });
    expect(client.saveAudioPlan).toHaveBeenCalledWith('p1', { voiceTrackAssetId: null });
  });

  it('shows the upload\'s refusal in words and leaves the plan alone', async () => {
    client.uploadAudio.mockRejectedValue(new StoryApiError({ status: 422, code: 'validation_failed', message: 'This file is larger than 20 MB. Trim or compress it and try again.' }));
    const { container } = await openStep(audioView());
    await chooseFile(narrationCard(container), file('huge.wav'));
    expect(await screen.findByText(/larger than 20 MB/)).toBeInTheDocument();
    expect(client.saveAudioPlan).not.toHaveBeenCalled();
  });

  it('uploads the customer\'s own music and switches the music to it', async () => {
    client.uploadAudio.mockResolvedValue({ id: 'm1', kind: 'music', name: 'My song', url: '/m.mp3', seconds: 61, bytes: 1 });
    client.saveAudioPlan.mockResolvedValue(audioView({ plan: { music: { type: 'upload', prompt: '', assetId: 'm1' } }, music: { type: 'upload', status: 'ready', url: '/m.mp3', source: 'upload' }, uploads: { voiceTrack: null, music: { id: 'm1', name: 'My song', seconds: 61 } } }));
    const { container } = await openStep(audioView());
    const card = musicCard(container);
    expect(within(card).getByRole('button', { name: /Use my own track/ })).toBeEnabled();
    const f = file('song.m4a', 'audio/mp4');
    await chooseFile(card, f);
    expect(client.uploadAudio).toHaveBeenCalledWith(f, 'music', expect.any(Object));
    expect(client.saveAudioPlan).toHaveBeenCalledWith('p1', { music: { type: 'upload', assetId: 'm1' } });
    expect(await within(card).findByText(/My song/)).toBeInTheDocument();
  });

  it('shows the upload while it is going, and the buttons that cost nothing say so', async () => {
    let finish;
    client.uploadAudio.mockImplementation((f, kind, { onProgress }) => new Promise((resolve) => { onProgress?.(40); finish = () => resolve({ id: 'm1', kind, name: 'x', url: '/m.mp3', seconds: 5, bytes: 1 }); }));
    client.saveAudioPlan.mockResolvedValue(audioView());
    const { container } = await openStep(audioView());
    const card = musicCard(container);
    expect(within(card).getByText(/Free\. MP3, WAV or M4A, up to 20 MB/)).toBeInTheDocument();
    await chooseFile(card, file('song.mp3', 'audio/mpeg'));
    expect(within(card).getByRole('button', { name: /Uploading/ })).toBeDisabled();
    await act(async () => { finish(); });
  });
});
