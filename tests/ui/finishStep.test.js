// @vitest-environment jsdom
// Task 21: the Finish screen (StepFinish), the player, and the download helpers.
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const push = vi.fn();
vi.mock('next/router', () => ({ default: { push: (...a) => push(...a) }, useRouter: () => ({ push }) }));
vi.mock('../../lib/story/client', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, startRender: vi.fn(), duplicateProject: vi.fn() };
});

const client = await import('../../lib/story/client');
const { default: StepFinish } = await import('../../components/maker/StepFinish');
const { default: VideoPlayer } = await import('../../components/app/VideoPlayer');
const { downloadFilename, downloadHref, filesExpired, renderActive } = await import('../../components/maker/finish');

const project = { id: 'p1', title: 'The line outside the barbershop', step: 'done', aspect: '16:9', files_expire_at: '2999-01-01T00:00:00Z' };
const done = (extra = {}) => ({ id: 'r2', version: 2, status: 'done', url: 'https://blob.example/renders/abc.mp4', warnings: [], created_at: '2026-11-14T10:00:00Z', finished_at: '2026-11-14T10:01:00Z', error: null, duration_seconds: 15.6, ...extra });

afterEach(() => {
  cleanup();
  client.startRender.mockReset();
  client.duplicateProject.mockReset();
  push.mockReset();
  vi.useRealTimers();
});

describe('download helpers', () => {
  it('names the file from the project title, safe and ending .mp4', () => {
    expect(downloadFilename('The line outside the barbershop')).toBe('the-line-outside-the-barbershop.mp4');
    expect(downloadFilename('  Jack’s: 50% off / today!! ')).toBe('jack-s-50-off-today.mp4');
    expect(downloadFilename('../../etc/passwd')).toBe('etc-passwd.mp4');
    expect(downloadFilename('')).toBe('my-video.mp4');
    expect(downloadFilename(null)).toBe('my-video.mp4');
    expect(downloadFilename('x'.repeat(200)).length).toBeLessThanOrEqual(64);
    expect(downloadFilename('مرحبا story')).toMatch(/^[\p{L}\p{N}-]+\.mp4$/u);
  });

  it('asks the file host for an attachment with ?download=1 and keeps other query parts', () => {
    expect(downloadHref('https://blob.example/a.mp4')).toBe('https://blob.example/a.mp4?download=1');
    expect(downloadHref('https://blob.example/a.mp4?x=1')).toBe('https://blob.example/a.mp4?x=1&download=1');
    expect(downloadHref('/api/mock/storage/a.mp4')).toBe('/api/mock/storage/a.mp4?download=1');
    expect(downloadHref('')).toBe('');
  });

  it('knows an expired project and an active render', () => {
    expect(filesExpired({ status: 'expired' })).toBe(true);
    expect(filesExpired({ files_expire_at: '2020-01-01T00:00:00Z' })).toBe(true);
    expect(filesExpired({ files_expire_at: '2999-01-01T00:00:00Z' })).toBe(false);
    expect(filesExpired({})).toBe(false);
    expect(renderActive({ status: 'queued' })).toBe(true);
    expect(renderActive({ status: 'running' })).toBe(true);
    expect(renderActive({ status: 'done' })).toBe(false);
    expect(renderActive(null)).toBe(false);
  });
});

describe('VideoPlayer', () => {
  it('plays the file with controls and says so plainly when it cannot be played', () => {
    const { container } = render(<VideoPlayer src="https://blob.example/a.mp4" aspect="9:16" title="My video" />);
    const video = container.querySelector('video');
    expect(video).toHaveAttribute('src', 'https://blob.example/a.mp4');
    expect(video).toHaveAttribute('controls');
    expect(container.querySelector('[data-player]')).toHaveAttribute('data-aspect', '9:16');
    fireEvent.error(video);
    expect(screen.getByRole('alert')).toHaveTextContent(/could not be played/i);
    expect(container.querySelector('video')).toBeNull();
  });
});

describe('StepFinish', () => {
  it('with no render yet explains what happens and starts one', async () => {
    client.startRender.mockResolvedValue({ id: 'r1', version: 1, status: 'queued' });
    const refresh = vi.fn();
    render(<StepFinish project={project} status={{ render: null, renders: [], renderPrice: { credits: 0 } }} refresh={refresh} />);
    expect(screen.getByText(/clips, voice, music and captions/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /make my video/i }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(client.startRender).toHaveBeenCalledWith('p1', 0);
  });

  it('N2: without a known price it shows Checking the price, starts nothing and asks for the status again', async () => {
    const refresh = vi.fn();
    render(<StepFinish project={project} status={{ render: null, renders: [], renderPrice: null }} refresh={refresh} />);
    expect(screen.getByRole('button', { name: /checking the price/i })).toBeDisabled();
    await waitFor(() => expect(refresh).toHaveBeenCalled(), { timeout: 4000 });
    expect(client.startRender).not.toHaveBeenCalled();
  });

  it('N1: shows the project fee and the render as separate lines and the total on the button', async () => {
    client.startRender.mockResolvedValue({ id: 'r1', version: 1, status: 'queued' });
    const price = { credits: 90, fee: 90, render: 0, lines: [{ label: 'Project fee', credits: 90 }, { label: 'Render', credits: 0 }] };
    render(<StepFinish project={project} status={{ render: null, renders: [], renderPrice: price }} refresh={vi.fn()} />);
    const lines = screen.getByTestId('render-price-lines');
    expect(lines).toHaveTextContent('Project fee');
    expect(lines).toHaveTextContent('90 credits');
    expect(lines).toHaveTextContent(/Video render/);
    expect(lines).toHaveTextContent(/free|included/i);
    fireEvent.click(screen.getByRole('button', { name: 'Make my video (90 credits)' }));
    await waitFor(() => expect(client.startRender).toHaveBeenCalledWith('p1', 90));
  });

  it('shows progress from /status while the render is queued or running, and blocks a second start', () => {
    const { rerender } = render(<StepFinish project={project} status={{ render: { id: 'r1', version: 1, status: 'queued', created_at: new Date().toISOString(), warnings: [] }, renders: [] }} />);
    const bar = screen.getByRole('progressbar');
    expect(bar).toBeInTheDocument();
    expect(screen.getByTestId('render-progress')).toHaveTextContent(/waiting/i);
    expect(screen.getByRole('button', { name: /making your video/i })).toBeDisabled();
    rerender(<StepFinish project={project} status={{ render: { id: 'r1', version: 1, status: 'running', created_at: new Date().toISOString(), warnings: [] }, renders: [] }} />);
    expect(screen.getByTestId('render-progress')).toHaveTextContent(/putting your video together/i);
    expect(screen.getByRole('button', { name: /making your video/i })).toBeDisabled();
  });

  it('plays the finished video and downloads the render URL with a filename from the title', () => {
    const r = done();
    const { container } = render(<StepFinish project={project} status={{ render: r, renders: [r], renderPrice: { credits: 5 } }} />);
    expect(container.querySelector('video')).toHaveAttribute('src', 'https://blob.example/renders/abc.mp4');
    const link = screen.getByRole('link', { name: /download/i });
    expect(link).toHaveAttribute('href', 'https://blob.example/renders/abc.mp4?download=1');
    expect(link).toHaveAttribute('download', 'the-line-outside-the-barbershop.mp4');
    expect(screen.getByText(/version 2/i)).toBeInTheDocument();
    expect(screen.getByTestId('files-note')).toHaveTextContent(/files are removed on/i);
    expect(screen.getByRole('button', { name: /make it again/i })).toBeEnabled();
  });

  it('lists warnings from the checks verbatim and each can be dismissed', () => {
    const r = done({ warnings: [{ code: 'loudness', message: 'The music is a little loud under the voice.' }, { code: 'narration_gap', message: 'There is a pause of 4 seconds after scene 3.' }] });
    render(<StepFinish project={project} status={{ render: r, renders: [r] }} />);
    const list = screen.getByRole('list', { name: /worth a look/i });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('The music is a little loud under the voice.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /dismiss.*music is a little loud/i }));
    expect(screen.queryByText('The music is a little loud under the voice.')).toBeNull();
    expect(screen.getByText('There is a pause of 4 seconds after scene 3.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /dismiss.*pause of 4 seconds/i }));
    expect(screen.queryByRole('list', { name: /worth a look/i })).toBeNull();
  });

  it('shows no warning list when there are none', () => {
    const r = done();
    render(<StepFinish project={project} status={{ render: r, renders: [r] }} />);
    expect(screen.queryByRole('list', { name: /worth a look/i })).toBeNull();
  });

  it('failed: shows the message and offers Try again, with the older video still watchable', async () => {
    const older = done({ id: 'r1', version: 1, url: 'https://blob.example/renders/old.mp4' });
    const failed = { id: 'r2', version: 2, status: 'failed', url: null, warnings: [], error: 'The video could not be made this time. Try again.', created_at: '2026-11-14T11:00:00Z' };
    client.startRender.mockResolvedValue({ id: 'r3', version: 3, status: 'queued' });
    const { container } = render(<StepFinish project={project} status={{ render: failed, renders: [failed, older], renderPrice: { credits: 0 } }} refresh={() => {}} />);
    expect(screen.getByRole('alert')).toHaveTextContent('The video could not be made this time. Try again.');
    expect(container.querySelector('video')).toHaveAttribute('src', 'https://blob.example/renders/old.mp4');
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    await waitFor(() => expect(client.startRender).toHaveBeenCalledWith('p1', 0));
  });

  it('shows why a start was refused in the server words and refreshes on a 409', async () => {
    client.startRender.mockRejectedValue(Object.assign(new Error('x'), { status: 409, code: 'audio_not_ready', serverMessage: 'Your voice or music is still being made. Wait for it to finish, then make your video.' }));
    const refresh = vi.fn();
    render(<StepFinish project={project} status={{ render: null, renders: [], renderPrice: { credits: 0 } }} refresh={refresh} />);
    fireEvent.click(screen.getByRole('button', { name: /make my video/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Your voice or music is still being made. Wait for it to finish, then make your video.');
    expect(refresh).toHaveBeenCalled();
  });

  it('lets the customer switch between versions', () => {
    const v1 = done({ id: 'r1', version: 1, url: 'https://blob.example/renders/v1.mp4' });
    const v2 = done();
    const { container } = render(<StepFinish project={project} status={{ render: v2, renders: [v2, v1] }} />);
    expect(container.querySelector('video')).toHaveAttribute('src', 'https://blob.example/renders/abc.mp4');
    fireEvent.click(screen.getByRole('button', { name: /version 1/i }));
    expect(container.querySelector('video')).toHaveAttribute('src', 'https://blob.example/renders/v1.mp4');
    expect(screen.getByRole('link', { name: /download/i })).toHaveAttribute('href', 'https://blob.example/renders/v1.mp4?download=1');
  });

  it('expired: no player and no download, a plain message, and a way to start again from a copy', async () => {
    const expired = { ...project, status: 'expired', files_expire_at: '2020-01-01T00:00:00Z' };
    client.duplicateProject.mockResolvedValue({ id: 'p2' });
    const r = done();
    const { container } = render(<StepFinish project={expired} status={{ render: r, renders: [r] }} />);
    expect(container.querySelector('video')).toBeNull();
    expect(screen.queryByRole('link', { name: /download/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /make it again|make my video/i })).toBeNull();
    expect(screen.getByText(/have been removed/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /make a copy/i }));
    await waitFor(() => expect(client.duplicateProject).toHaveBeenCalledWith('p1'));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/app/p/p2'));
  });

  it('keeps an elapsed time ticking while it works', () => {
    vi.useFakeTimers();
    const start = new Date('2026-11-14T10:00:00Z');
    vi.setSystemTime(new Date(start.getTime() + 5000));
    render(<StepFinish project={project} status={{ render: { id: 'r1', version: 1, status: 'running', created_at: start.toISOString(), warnings: [] }, renders: [] }} />);
    expect(screen.getByTestId('render-progress')).toHaveTextContent('0:05');
    act(() => { vi.advanceTimersByTime(10000); });
    expect(screen.getByTestId('render-progress')).toHaveTextContent('0:15');
  });
});

describe('round 1', () => {
  it('keeps Make it again busy until the refresh has answered', async () => {
    client.startRender.mockResolvedValue({ id: 'r3', version: 3, status: 'queued' });
    let release;
    const refresh = vi.fn(() => new Promise((res) => { release = res; }));
    const r = done();
    render(<StepFinish project={project} status={{ render: r, renders: [r], renderPrice: { credits: 5 } }} refresh={refresh} />);
    fireEvent.click(screen.getByRole('button', { name: /make it again/i }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /^make it again/i })).toBeNull();
    expect(screen.getByRole('button', { name: /starting|making your video/i })).toBeDisabled();
    await act(async () => { release(); });
  });

  it('the delete dialog is rendered in document.body, outside any card', async () => {
    const { default: Modal } = await import('../../components/ui/Modal');
    const { container } = render(<div style={{ overflow: 'hidden' }}><Modal open title="T" onClose={() => {}}>x</Modal></div>);
    const dialog = await screen.findByRole('dialog');
    expect(container.contains(dialog)).toBe(false);
    expect(document.body.contains(dialog)).toBe(true);
  });

  it('names the stored render after the title', async () => {
    const { renderFilename } = await import('../../lib/story/filenames');
    expect(renderFilename('The line outside the barbershop', 2)).toBe('the-line-outside-the-barbershop-v2.mp4');
  });
});

describe('render charge (owner decision 2026-11-16)', () => {
  it('the button shows (free) for the included render and (5 credits) after, and sends that price', async () => {
    client.startRender.mockResolvedValue({ id: 'r1', version: 1, status: 'queued' });
    const { rerender } = render(<StepFinish project={project} status={{ render: null, renders: [], renderPrice: { credits: 0 } }} refresh={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Make my video (free)' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /make my video/i }));
    await waitFor(() => expect(client.startRender).toHaveBeenCalledWith('p1', 0));
    const r = done();
    rerender(<StepFinish project={project} status={{ render: r, renders: [r], renderPrice: { credits: 5 } }} refresh={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Make it again (5 credits)' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /make it again/i }));
    await waitFor(() => expect(client.startRender).toHaveBeenLastCalledWith('p1', 5));
  });

  it('a 409 quote_changed refreshes, so the new price shows', async () => {
    client.startRender.mockRejectedValue(Object.assign(new Error('x'), { status: 409, code: 'quote_changed', serverMessage: 'The price changed. Check the new price and try again.' }));
    const refresh = vi.fn();
    const r = done();
    render(<StepFinish project={project} status={{ render: r, renders: [r], renderPrice: { credits: 0 } }} refresh={refresh} />);
    fireEvent.click(screen.getByRole('button', { name: 'Make it again (free)' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The price changed.');
    expect(refresh).toHaveBeenCalled();
  });

  it('without a price the label is empty and the button waits for one', async () => {
    const { renderPriceLabel } = await import('../../components/maker/StepFinish');
    expect(renderPriceLabel(null)).toBe('');
    expect(renderPriceLabel({ credits: 1 })).toBe(' (1 credit)');
    render(<StepFinish project={project} status={{ render: null, renders: [] }} />);
    expect(screen.getByRole('button', { name: /checking the price/i })).toBeDisabled();
  });
});
