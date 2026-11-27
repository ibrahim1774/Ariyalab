// @vitest-environment jsdom
// Task 22: StepReference (upload or paste a link, plus the rights box) and StepBreakdown (the beats with times and thumbnails).
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
const { default: StepReference, checkVideoFile } = await import('../../components/maker/StepReference');
const { default: StepBreakdown } = await import('../../components/maker/StepBreakdown');
const { default: StepStart } = await import('../../components/maker/StepStart');
const { REFERENCE_MESSAGES, RIGHTS_STATEMENT } = await import('../../lib/story/referenceRules');

const project = { id: 'p1', title: 'Barber story', style: '3d_family', seconds: 30, quality: 'standard', mode: 'narrated', step: 'brief', reference_id: 'r1' };
const BEATS = [
  { ord: 1, start: 0, end: 2.1, visual: 'A barber looks straight at the camera.', said: 'Nobody books on a Monday.', why: 'Opens on a face and a doubt.', thumb: '/api/mock/storage/story/p1/reference/r1/beat-1.jpg' },
  { ord: 2, start: 2.1, end: 6, visual: 'The empty shop, chairs turned up.', said: '', why: 'Shows the problem.', thumb: null },
  { ord: 3, start: 6, end: 64.5, visual: 'The shop is full and loud.', said: 'Now we turn people away.', why: 'Pays off the opening.', thumb: '/api/mock/storage/story/p1/reference/r1/beat-3.jpg' },
];
const ref = (over = {}) => ({
  id: 'r1', status: 'ready', error: null, source_type: 'link', source_url: 'https://www.tiktok.com/@shop/video/1', platform: 'tiktok', duration: 64.5,
  beats: BEATS, hook: 'Opens on a face and a doubt.', structure: 'Problem, turning point, payoff.', mood: 'Warm acoustic, slow build', mode: 'narrated', shots: 3,
  rights_confirmed_at: '2026-11-15T10:00:00.000Z', ...over,
});

beforeEach(() => {
  for (const fn of Object.values(client)) if (typeof fn?.mockReset === 'function') fn.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

// ---------------------------------------------------------------- StepReference

function renderReference(props = {}) {
  const onStarted = vi.fn();
  const ensureProject = vi.fn(async () => 'p1');
  render(<StepReference ensureProject={ensureProject} onStarted={onStarted} returnTo="/app/new" {...props} />);
  return { onStarted, ensureProject };
}
const linkTab = () => fireEvent.click(screen.getByRole('radio', { name: /Paste a link/ }));
const rightsBox = () => screen.getByRole('checkbox', { name: /right to use this video/i });
const submit = () => screen.getByRole('button', { name: /Break down my video/ });

describe('StepReference capabilities', () => {
  it('hides "Paste a link" when the server has no downloader key, and says speech is not transcribed when it has no transcription key', async () => {
    client.getCapabilities.mockResolvedValue({ linkDownload: false, transcription: false });
    renderReference();
    await waitFor(() => expect(screen.queryByRole('radio', { name: /Paste a link/ })).toBeNull());
    expect(screen.getByLabelText('Choose a video file')).toBeInTheDocument();
    expect(await screen.findByText(/not transcribed right now/)).toBeInTheDocument();
  });

  it('keeps both doors and no note when everything is configured, and when the capabilities cannot be read', async () => {
    client.getCapabilities.mockResolvedValue({ linkDownload: true, transcription: true });
    renderReference();
    expect(screen.getByRole('radio', { name: /Paste a link/ })).toBeInTheDocument();
    await act(async () => {});
    expect(screen.queryByText(/not transcribed right now/)).toBeNull();
    cleanup();
    client.getCapabilities.mockRejectedValue(new Error('offline'));
    renderReference();
    await act(async () => {});
    expect(screen.getByRole('radio', { name: /Paste a link/ })).toBeInTheDocument();
  });
});

describe('StepReference', () => {
  it('offers an upload and a link, says the limits, and shows the rights statement', () => {
    renderReference();
    expect(screen.getByRole('heading', { name: /Start from a video/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Upload a file/ })).toBeChecked();
    expect(screen.getByText(/MP4 or MOV, up to 100 MB and 3 minutes/)).toBeInTheDocument();
    linkTab();
    expect(screen.getByLabelText(/Link to the video/)).toBeInTheDocument();
    expect(screen.getByText(/Instagram, TikTok or Facebook/)).toBeInTheDocument();
    expect(rightsBox()).not.toBeChecked();
    expect(screen.getByText(RIGHTS_STATEMENT)).toBeInTheDocument();
  });

  it('keeps the button off until there is a source and the box is ticked', () => {
    renderReference();
    linkTab();
    expect(submit()).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Link to the video/), { target: { value: 'https://www.instagram.com/reel/abc/' } });
    expect(submit()).toBeDisabled();
    fireEvent.click(rightsBox());
    expect(submit()).toBeEnabled();
  });

  it('says no to a YouTube link before anything is sent or created', async () => {
    const { ensureProject } = renderReference();
    linkTab();
    fireEvent.change(screen.getByLabelText(/Link to the video/), { target: { value: 'https://www.youtube.com/watch?v=1' } });
    fireEvent.click(rightsBox());
    expect(screen.getByText(REFERENCE_MESSAGES.link)).toBeInTheDocument();
    expect(submit()).toBeDisabled();
    expect(ensureProject).not.toHaveBeenCalled();
    expect(client.startAnalysis).not.toHaveBeenCalled();
  });

  it('starts the analysis of a link with the rights box, then hands over', async () => {
    client.startAnalysis.mockResolvedValue(ref({ status: 'pending', beats: [] }));
    const { onStarted, ensureProject } = renderReference();
    linkTab();
    fireEvent.change(screen.getByLabelText(/Link to the video/), { target: { value: ' https://www.tiktok.com/@shop/video/1 ' } });
    fireEvent.click(rightsBox());
    fireEvent.click(submit());
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith('p1', expect.objectContaining({ status: 'pending' })));
    expect(ensureProject).toHaveBeenCalledTimes(1);
    expect(client.startAnalysis).toHaveBeenCalledWith('p1', { source: { type: 'link', url: 'https://www.tiktok.com/@shop/video/1' }, rights: true });
  });

  it('shows the server\'s message (422) and lets the customer try again', async () => {
    client.startAnalysis.mockRejectedValue(new StoryApiError({ status: 422, code: 'validation_failed', message: REFERENCE_MESSAGES.tooLong }));
    renderReference();
    linkTab();
    fireEvent.change(screen.getByLabelText(/Link to the video/), { target: { value: 'https://fb.watch/abc/' } });
    fireEvent.click(rightsBox());
    fireEvent.click(submit());
    expect(await screen.findByText(REFERENCE_MESSAGES.tooLong)).toBeInTheDocument();
    expect(submit()).toBeEnabled();
  });

  it('checks an upload\'s type, size and length in the browser before creating anything', async () => {
    expect(await checkVideoFile({ name: 'a.webm', type: 'video/webm', size: 10 }, { readDuration: async () => 10 })).toBe(REFERENCE_MESSAGES.notVideo);
    expect(await checkVideoFile({ name: 'a.mov', type: 'video/quicktime', size: 10 }, { readDuration: async () => 10 })).toBeNull();
    expect(await checkVideoFile({ name: 'a.mp4', type: 'video/mp4', size: 101 * 1024 * 1024 }, { readDuration: async () => 10 })).toBe(REFERENCE_MESSAGES.tooBig);
    expect(await checkVideoFile({ name: 'a.mp4', type: 'video/mp4', size: 1000 }, { readDuration: async () => 181 })).toBe(REFERENCE_MESSAGES.tooLong);
    expect(await checkVideoFile({ name: 'a.mp4', type: 'video/mp4', size: 1000 }, { readDuration: async () => null })).toBeNull();
    expect(await checkVideoFile({ name: 'a.mp4', type: '', size: 1000 }, { readDuration: async () => 30 })).toBeNull();
  });

  it('uploads the file for the project, then starts the analysis of that upload', async () => {
    client.uploadReference.mockImplementation(async (id, file, { onProgress }) => { onProgress?.(50); return '/api/mock/storage/story-uploads/p1/ref.mp4'; });
    client.startAnalysis.mockResolvedValue(ref({ status: 'pending', beats: [] }));
    const { onStarted } = renderReference({ readDuration: async () => 12 });
    const file = new File(['x'], 'ref.mp4', { type: 'video/mp4' });
    fireEvent.change(screen.getByLabelText(/Choose a video file/), { target: { files: [file] } });
    expect(await screen.findByText(/ref\.mp4/)).toBeInTheDocument();
    fireEvent.click(rightsBox());
    fireEvent.click(submit());
    await waitFor(() => expect(onStarted).toHaveBeenCalled());
    expect(client.uploadReference).toHaveBeenCalledWith('p1', file, expect.any(Object));
    expect(client.startAnalysis).toHaveBeenCalledWith('p1', { source: { type: 'upload', url: '/api/mock/storage/story-uploads/p1/ref.mp4' }, rights: true });
  });

  it('a file that is too long is refused on the spot', async () => {
    renderReference({ readDuration: async () => 200 });
    fireEvent.change(screen.getByLabelText(/Choose a video file/), { target: { files: [new File(['x'], 'long.mp4', { type: 'video/mp4' })] } });
    expect(await screen.findByText(REFERENCE_MESSAGES.tooLong)).toBeInTheDocument();
    fireEvent.click(rightsBox());
    expect(submit()).toBeDisabled();
  });
});

describe('StepStart', () => {
  it('shows the video door on the first screen and on a project with no reference yet', () => {
    render(<StepStart onCreate={vi.fn()} onCreateForVideo={vi.fn()} onOpenProject={vi.fn()} returnTo="/app/new" />);
    expect(screen.getByRole('heading', { name: /Start from a video/ })).toBeInTheDocument();
    cleanup();
    render(<StepStart project={{ ...project, reference_id: null }} save={vi.fn()} onNext={vi.fn()} refresh={vi.fn()} returnTo="/app/p/p1" />);
    expect(screen.getByRole('heading', { name: /Start from a video/ })).toBeInTheDocument();
    cleanup();
    render(<StepStart project={project} save={vi.fn()} onNext={vi.fn()} refresh={vi.fn()} returnTo="/app/p/p1" />);
    expect(screen.queryByRole('heading', { name: /Start from a video/ })).toBeNull();
    expect(screen.getByText(/Started from a video/)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------- StepBreakdown

async function openBreakdown(view, props = {}) {
  client.getReference.mockResolvedValue(view);
  const onNext = vi.fn();
  const refresh = vi.fn();
  render(<StepBreakdown project={project} onNext={onNext} refresh={refresh} returnTo="/app/p/p1" {...props} />);
  await screen.findByRole('heading', { name: /Breakdown/ });
  return { onNext, refresh };
}

describe('StepBreakdown', () => {
  it('lists every beat with its times, what we see, what is said and why it works', async () => {
    await openBreakdown(ref());
    const rows = await screen.findAllByRole('listitem', { name: /^Beat \d/ });
    expect(rows).toHaveLength(3);
    expect(screen.getByText('0:00 to 0:02')).toBeInTheDocument();
    expect(screen.getByText('0:06 to 1:04')).toBeInTheDocument();
    expect(screen.getByText('A barber looks straight at the camera.')).toBeInTheDocument();
    expect(screen.getByText(/Nobody books on a Monday/)).toBeInTheDocument();
    expect(screen.getByText('Opens on a face and a doubt.', { selector: '[data-why]' })).toBeInTheDocument();
    expect(screen.getByText(/No words in this beat/)).toBeInTheDocument();
  });

  it('shows the thumbnail of each beat, and a labelled tile when one is missing (no blank card)', async () => {
    await openBreakdown(ref());
    await screen.findAllByRole('listitem', { name: /^Beat \d/ });
    const imgs = screen.getAllByRole('img', { name: /Beat \d at/ });
    expect(imgs).toHaveLength(2);
    expect(imgs[0]).toHaveAttribute('src', BEATS[0].thumb);
    expect(document.querySelectorAll('[data-beat="2"] [data-tile]')).toHaveLength(1);
  });

  it('sums up the hook, the shape, the music and how it is told', async () => {
    await openBreakdown(ref());
    expect(await screen.findByText('Problem, turning point, payoff.')).toBeInTheDocument();
    expect(screen.getByText('Warm acoustic, slow build')).toBeInTheDocument();
    expect(screen.getByText(/3 beats/)).toBeInTheDocument();
    expect(screen.getByText(/Told with a voice over/)).toBeInTheDocument();
  });

  it('continues to the script, which keeps this order and pacing', async () => {
    const { onNext } = await openBreakdown(ref());
    expect(await screen.findByText(/same order and pacing/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Continue to the script/ }));
    expect(onNext).toHaveBeenCalled();
  });

  it('while it is being made shows a designed waiting state and looks again by itself', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await openBreakdown(ref({ status: 'pending', beats: [], hook: null, structure: null, mood: null, mode: null }));
    expect(await screen.findAllByText(/Watching your video shot by shot/)).not.toHaveLength(0);
    expect(document.querySelectorAll('[data-skeleton]').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /Continue to the script/ })).toBeDisabled();
    client.getReference.mockResolvedValue(ref());
    await act(async () => { vi.advanceTimersByTime(3100); });
    expect(await screen.findAllByRole('listitem', { name: /^Beat \d/ })).toHaveLength(3);
    expect(client.getReference.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('R7: the waiting state shows at most two short skeletons, not three tall empty cards', async () => {
    await openBreakdown(ref({ status: 'pending', beats: [], hook: null, structure: null, mood: null, mode: null }));
    await screen.findAllByText(/Watching your video shot by shot/);
    expect(document.querySelectorAll('[data-skeleton]').length).toBeLessThanOrEqual(2);
  });

  it('a failed analysis says why and offers another video or carrying on without it', async () => {
    const { onNext } = await openBreakdown(ref({ status: 'failed', error: REFERENCE_MESSAGES.tooLong, beats: [] }));
    expect(await screen.findByText(REFERENCE_MESSAGES.tooLong)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Continue without it/ }));
    expect(onNext).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Try another video/ }));
    expect(screen.getByRole('heading', { name: /Start from a video/ })).toBeInTheDocument();
  });

  it('a new video started from the breakdown refreshes the project and shows the wait', async () => {
    const { refresh } = await openBreakdown(ref());
    fireEvent.click(await screen.findByRole('button', { name: /Use a different video/ }));
    client.startAnalysis.mockResolvedValue(ref({ id: 'r2', status: 'pending', beats: [] }));
    fireEvent.click(screen.getByRole('radio', { name: /Paste a link/ }));
    fireEvent.change(screen.getByLabelText(/Link to the video/), { target: { value: 'https://www.instagram.com/reel/x/' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /right to use this video/i }));
    fireEvent.click(screen.getByRole('button', { name: /Break down my video/ }));
    expect((await screen.findAllByText(/Watching your video shot by shot/)).length).toBeGreaterThan(0);
    expect(refresh).toHaveBeenCalled();
  });

  it('a load error shows the notice with a way to try again, not an empty page', async () => {
    client.getReference.mockRejectedValue(new StoryApiError({ status: 0, code: 'network' }));
    render(<StepBreakdown project={project} onNext={vi.fn()} refresh={vi.fn()} returnTo="/app/p/p1" />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/No connection/);
  });
});
