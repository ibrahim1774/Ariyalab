// @vitest-environment jsdom
// Task 21: project cards on the home page: thumbnail, download, duplicate, delete, retention.
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

vi.mock('../../lib/story/client', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, deleteProject: vi.fn(), duplicateProject: vi.fn() };
});
const push = vi.fn();
vi.mock('next/router', () => ({ default: { push: (...a) => push(...a) } }));

const client = await import('../../lib/story/client');
const { default: ProjectCard, projectStatus } = await import('../../components/app/ProjectCard');
const { default: AppHome } = await import('../../pages/app/index');

const finished = { id: 'p1', title: 'Fox and the moon', step: 'done', style: 'clay', latest_render_url: 'https://blob.example/r.mp4', latest_render_version: 2, files_expire_at: '2999-01-01T00:00:00Z', updated_at: '2026-11-14' };

afterEach(() => {
  cleanup();
  client.deleteProject.mockReset();
  client.duplicateProject.mockReset();
  push.mockReset();
  vi.unstubAllGlobals();
});

describe('ProjectCard actions', () => {
  it('a finished project has a download link named from its title, and says when files go', () => {
    render(<ProjectCard project={finished} />);
    const link = screen.getByRole('link', { name: /download/i });
    expect(link).toHaveAttribute('href', 'https://blob.example/r.mp4?download=1');
    expect(link).toHaveAttribute('download', 'fox-and-the-moon.mp4');
    expect(screen.getByTestId('card-files-note')).toHaveTextContent(/files are removed on/i);
  });

  it('a draft has no download, and no retention line when no files were stored', () => {
    render(<ProjectCard project={{ id: 'p', title: 'T', step: 'script' }} />);
    expect(screen.queryByRole('link', { name: /download/i })).toBeNull();
    expect(screen.queryByTestId('card-files-note')).toBeNull();
  });

  it('an expired project says its files are gone and offers no download', () => {
    const p = { ...finished, status: 'expired', files_expire_at: '2020-01-01T00:00:00Z' };
    expect(projectStatus(p)).toBe('expired');
    render(<ProjectCard project={p} />);
    expect(screen.queryByRole('link', { name: /download/i })).toBeNull();
    expect(screen.getByText('Files removed', { selector: '[data-status]' })).toBeInTheDocument();
  });

  it('a past files_expire_at counts as expired even before the clean-up has run', () => {
    expect(projectStatus({ ...finished, files_expire_at: '2020-01-01T00:00:00Z' })).toBe('expired');
  });

  it('duplicate opens the copy', async () => {
    client.duplicateProject.mockResolvedValue({ id: 'p9' });
    render(<ProjectCard project={finished} />);
    fireEvent.click(screen.getByRole('button', { name: /duplicate/i }));
    await waitFor(() => expect(client.duplicateProject).toHaveBeenCalledWith('p1'));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/app/p/p9'));
  });

  it('delete asks first, then removes the card', async () => {
    client.deleteProject.mockResolvedValue({ deleted: true });
    const onDeleted = vi.fn();
    render(<ProjectCard project={finished} onDeleted={onDeleted} />);
    fireEvent.click(screen.getByRole('button', { name: /^delete/i }));
    const dialog = screen.getByRole('dialog');
    expect(client.deleteProject).not.toHaveBeenCalled();
    expect(dialog).toHaveTextContent(/cannot be undone/i);
    fireEvent.click(within(dialog).getByRole('button', { name: /delete video/i }));
    await waitFor(() => expect(client.deleteProject).toHaveBeenCalledWith('p1'));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith('p1'));
  });

  it('delete shows the server message when the project is busy and keeps the card', async () => {
    client.deleteProject.mockRejectedValue(Object.assign(new Error('x'), { status: 409, serverMessage: 'This video is still generating. Try again when it has finished.' }));
    const onDeleted = vi.fn();
    render(<ProjectCard project={finished} onDeleted={onDeleted} />);
    fireEvent.click(screen.getByRole('button', { name: /^delete/i }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /delete video/i }));
    expect(await within(screen.getByRole('dialog')).findByRole('alert')).toHaveTextContent('This video is still generating. Try again when it has finished.');
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it('the home page drops a deleted project from the list', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ projects: [finished, { id: 'p2', title: 'Other', step: 'script' }] }) })));
    client.deleteProject.mockResolvedValue({ deleted: true });
    render(<AppHome />);
    expect(await screen.findByText('Fox and the moon')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: /^delete/i })[0]);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /delete video/i }));
    await waitFor(() => expect(screen.queryByText('Fox and the moon')).toBeNull());
    expect(screen.getByText('Other')).toBeInTheDocument();
  });
});
