// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
const { FORBIDDEN_NAMES } = await import('../../lib/story/script.js');
const { default: ChatPanel } = await import('../../components/maker/ChatPanel');

const project = { id: 'p1', title: 'Fox', step: 'cast' };
const CONFIRM = {
  tool: 'regenerate_character',
  needsConfirm: true,
  quote: { label: 'New pictures of Maya', credits: 5 },
  confirm: { action: 'cast-regen', method: 'POST', body: { castId: 'c1', note: 'a red cap', expected_credits: 5 } },
};
const msg = (id, role, text, confirms = []) => ({ id, role, text, confirms, created_at: '2026-11-14T12:00:00.000Z' });

beforeEach(() => {
  client.getChat.mockResolvedValue({ messages: [], usage: { used: 0, limit: 150 } });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ChatPanel', () => {
  it('shows a compact empty state with suggestions that send', async () => {
    client.sendChat.mockResolvedValue({ messages: [msg('u1', 'user', 'Make the opening funnier'), msg('a1', 'assistant', 'Done.')], usage: { used: 1, limit: 150 }, changed: [] });
    render(<ChatPanel project={project} onChanged={vi.fn()} />);
    expect(await screen.findByText(/Ask for a change in plain words/)).toBeInTheDocument();
    expect(screen.getByText('0 of 150')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Make the opening funnier' }));
    expect(client.sendChat).toHaveBeenCalledWith('p1', 'Make the opening funnier');
    expect(await screen.findByText('Done.')).toBeInTheDocument();
    expect(screen.getByText('1 of 150')).toBeInTheDocument();
  });

  it('shows a waiting line while the reply is on its way, then reloads the project when something changed', async () => {
    let finish;
    client.sendChat.mockReturnValue(new Promise((r) => { finish = r; }));
    const onChanged = vi.fn();
    render(<ChatPanel project={project} onChanged={onChanged} />);
    const input = await screen.findByLabelText('Message to the chat helper');
    fireEvent.change(input, { target: { value: 'Make it 45 seconds' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByTestId('chat-waiting')).toHaveTextContent('Working on it');
    finish({ messages: [msg('u1', 'user', 'Make it 45 seconds'), msg('a1', 'assistant', 'Done: set length.')], usage: { used: 1, limit: 150 }, changed: ['project'] });
    expect(await screen.findByText('Done: set length.')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-waiting')).toBeNull();
    expect(onChanged).toHaveBeenCalledWith(['project']);
  });

  it('renders a confirm card whose button calls the normal route with the shown price', async () => {
    client.getChat.mockResolvedValue({ messages: [msg('u1', 'user', 'New look'), msg('a1', 'assistant', 'That costs 5 credits.', [CONFIRM])], usage: { used: 1, limit: 150 } });
    client.confirmChatAction.mockResolvedValue({ cast: {}, charged: 5 });
    const onChanged = vi.fn();
    render(<ChatPanel project={project} onChanged={onChanged} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Start for 5 credits' }));
    expect(client.confirmChatAction).toHaveBeenCalledWith('p1', CONFIRM.confirm);
    expect(await screen.findByText('Started')).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalled();
  });

  it('shows a changed price as an error and keeps the button', async () => {
    client.getChat.mockResolvedValue({ messages: [msg('a1', 'assistant', 'That costs 5 credits.', [CONFIRM])], usage: { used: 1, limit: 150 } });
    client.confirmChatAction.mockRejectedValue(new StoryApiError({ status: 409, code: 'quote_changed', message: 'The price is now 7 credits.' }));
    render(<ChatPanel project={project} onChanged={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Start for 5 credits' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start for 5 credits' })).toBeEnabled();
  });

  it('keeps the text and shows the error when sending fails, and says when the chat is used up', async () => {
    client.sendChat.mockRejectedValue(new StoryApiError({ status: 429, code: 'chat_limit', message: 'This video has used its 150 chat messages.' }));
    render(<ChatPanel project={project} onChanged={vi.fn()} />);
    const input = await screen.findByLabelText('Message to the chat helper');
    fireEvent.change(input, { target: { value: 'One more' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Chat limit reached')).toBeInTheDocument();
    expect(screen.getByLabelText('Message to the chat helper')).toHaveValue('One more');
    cleanup();
    client.getChat.mockResolvedValue({ messages: [], usage: { used: 150, limit: 150 } });
    render(<ChatPanel project={project} onChanged={vi.fn()} />);
    expect(await screen.findByText(/used its chat messages/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Message to the chat helper')).toBeNull();
  });

  it('offers to load again when the history cannot load', async () => {
    client.getChat.mockRejectedValueOnce(new StoryApiError({ status: 500 }));
    render(<ChatPanel project={project} onChanged={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(client.getChat).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/Ask for a change in plain words/)).toBeInTheDocument();
  });

  it('keeps its copy clear of banned wording', async () => {
    client.getChat.mockResolvedValue({ messages: [msg('a1', 'assistant', 'x', [CONFIRM])], usage: { used: 150, limit: 150 } });
    const { container, unmount } = render(<ChatPanel project={project} onChanged={vi.fn()} />);
    await screen.findByText('Start for 5 credits');
    const empty = render(<ChatPanel project={{ id: 'p2' }} onChanged={vi.fn()} />);
    await waitFor(() => expect(client.getChat).toHaveBeenCalledTimes(2));
    const names = new RegExp(`\\b(${FORBIDDEN_NAMES.map((n) => String(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'i');
    for (const c of [container, empty.container]) {
      const text = `${c.textContent} ${[...c.querySelectorAll('[placeholder],[aria-label]')].map((e) => `${e.getAttribute('placeholder')} ${e.getAttribute('aria-label')}`).join(' ')}`;
      expect(text).not.toMatch(/[—–]|\s-\s|\bfree\b|guarantee/i);
      expect(text).not.toMatch(names);
    }
    unmount();
  });
});
