// @vitest-environment jsdom
// Task 20: the minimal "Make my video" trigger in the Finish slot (Task 21 builds the full screen).
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

vi.mock('../../lib/story/client', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, startRender: vi.fn() };
});

const client = await import('../../lib/story/client');
const { FinishSlot } = await import('../../components/maker/slots');

const project = { id: 'p1', step: 'review' };
afterEach(() => {
  cleanup();
  client.startRender.mockReset();
});

describe('FinishSlot', () => {
  it('starts a render and refreshes', async () => {
    client.startRender.mockResolvedValue({ id: 'r1', version: 1, status: 'queued' });
    const refresh = vi.fn();
    render(<FinishSlot project={project} status={{ render: null }} refresh={refresh} />);
    fireEvent.click(screen.getByRole('button', { name: /make my video/i }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(client.startRender).toHaveBeenCalledWith('p1');
  });

  it('waits while a render runs, links the finished file, and offers a new version', () => {
    const { rerender } = render(<FinishSlot project={project} status={{ render: { version: 1, status: 'running' } }} />);
    expect(screen.getByText(/being made/i)).toBeInTheDocument();
    expect(screen.getByRole('button')).toBeDisabled();
    rerender(<FinishSlot project={project} status={{ render: { version: 2, status: 'done', file_url: '/api/mock/storage/x.mp4' } }} />);
    expect(screen.getByRole('link', { name: /watch your video/i })).toHaveAttribute('href', '/api/mock/storage/x.mp4');
    expect(screen.getByRole('button', { name: /make it again/i })).toBeEnabled();
  });

  it('shows why a start was refused', async () => {
    client.startRender.mockRejectedValue(Object.assign(new Error('x'), { status: 409, code: 'shots_not_ready', serverMessage: 'Every shot needs its clip before the video can be made.' }));
    render(<FinishSlot project={project} status={{ render: null }} refresh={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /make my video/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/./);
  });
});
