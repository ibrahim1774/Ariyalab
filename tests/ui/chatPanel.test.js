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
  id: '6f0f6c1e-2b7a-4f5e-9a51-0c2d1f9e8a11',
  state: 'open',
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
    expect(client.confirmChatAction).toHaveBeenCalledWith('p1', CONFIRM.id);
    expect(await screen.findByText('Started')).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalled();
  });

  it('I2: a set_mode card shows the message the server sent and reports the script as changed', async () => {
    const card = { ...CONFIRM, id: 'c-mode', tool: 'set_mode', quote: { label: 'The characters speak: This rewrites your script so the characters speak.', credits: 0, clips: 0, remake_credits: 0 }, confirm: { action: 'mode', method: 'POST', body: { mode: 'talking', clips: 0, remake_credits: 0 } } };
    client.getChat.mockResolvedValue({ messages: [msg('a1', 'assistant', 'Shall I?', [card])], usage: { used: 1, limit: 150 } });
    client.confirmChatAction.mockResolvedValue({ queued: true, drafting: { task: 'mode', status: 'queued' }, message: 'Your script is being rewritten. This takes a minute.' });
    const onChanged = vi.fn();
    render(<ChatPanel project={project} onChanged={onChanged} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Change it' }));
    expect(await screen.findByText('Your script is being rewritten. This takes a minute.')).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalledWith(['script']);
  });

  it('R4-5: a card for a mode the project already has shows the server\'s message, not "Out of date"', async () => {
    const card = { ...CONFIRM, id: 'c-mode2', tool: 'set_mode', quote: { label: 'The characters speak: This rewrites your script so the characters speak.', credits: 0 }, confirm: { action: 'mode', method: 'POST', body: { mode: 'talking' } } };
    client.getChat.mockResolvedValue({ messages: [msg('a1', 'assistant', 'Shall I?', [card])], usage: { used: 1, limit: 150 } });
    client.confirmChatAction.mockResolvedValue({ queued: false, message: 'It was already set that way.' });
    render(<ChatPanel project={project} onChanged={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Change it' }));
    expect(await screen.findByText('It was already set that way.')).toBeInTheDocument();
    expect(screen.queryByText('Out of date')).toBeNull();
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

  it('round 1 C4: shows the note the card will use', async () => {
    client.getChat.mockResolvedValue({ messages: [msg('a1', 'assistant', 'That costs 5 credits.', [CONFIRM])], usage: { used: 1, limit: 150 } });
    render(<ChatPanel project={project} onChanged={vi.fn()} />);
    expect(await screen.findByText('a red cap')).toBeInTheDocument();
  });

  it('round 1 C3: a used card shows Started and an out of date card cannot be pressed', async () => {
    client.getChat.mockResolvedValue({
      messages: [
        msg('a1', 'assistant', 'x', [{ ...CONFIRM, id: 'c-used', state: 'used' }]),
        msg('a2', 'assistant', 'y', [{ ...CONFIRM, id: 'c-old', state: 'outdated' }]),
      ],
      usage: { used: 2, limit: 150 },
    });
    render(<ChatPanel project={project} onChanged={vi.fn()} />);
    expect(await screen.findByText('Started')).toBeInTheDocument();
    expect(screen.getByText('Out of date')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Start for/ })).toBeNull();
  });

  it('round 1 C3: a refused press (already used, out of date) marks the card so it cannot be pressed again', async () => {
    client.getChat.mockResolvedValue({ messages: [msg('a1', 'assistant', 'x', [CONFIRM])], usage: { used: 1, limit: 150 } });
    client.confirmChatAction.mockRejectedValue(new StoryApiError({ status: 409, code: 'confirm_used', message: 'This was already started.' }));
    render(<ChatPanel project={project} onChanged={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Start for 5 credits' }));
    expect(await screen.findByText('Started')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Start for/ })).toBeNull();
  });
});

describe('MakerPage chat wiring (round 1 C6)', () => {
  it('a plain refresh from the chat does not reload the script step', async () => {
    const { default: MakerPage } = await import('../../components/maker/MakerPage');
    const p = { id: 'p1', title: 'Fox', purpose: 'app', offer: 'x', audience: 'y', style: '3d_family', seconds: 30, aspect: '9:16', quality: 'standard', mode: 'narrated', step: 'script', fee_charged: false, files_expire_at: null, reference_id: null };
    client.getStatus.mockResolvedValue({ project: p, shots: [], cast: [], jobs: [] });
    client.getScript.mockResolvedValue({ id: 'x', version: 1, scenes: [{ id: 's1', title: 'T', visual: 'V', lines: [{ speaker: 'narrator', text: 'Hi' }] }], violations: [] });
    client.getPricing.mockResolvedValue({ pricing: {} });
    client.getQuote.mockResolvedValue({ total: 0, lines: [] });
    client.getBilling.mockResolvedValue({ v2: true, balance: { available: 0 }, history: [] });
    client.sendChat.mockRejectedValue(new StoryApiError({ status: 409, code: 'conflict', message: 'Busy.' }));
    render(<MakerPage id="p1" returnTo="/app/p/p1" />);
    const input = await screen.findByLabelText('Message to the chat helper');
    await waitFor(() => expect(client.getScript).toHaveBeenCalledTimes(1));
    fireEvent.change(input, { target: { value: 'Hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    const refresh = await screen.findByRole('button', { name: /Refresh/ });
    fireEvent.click(refresh);
    await waitFor(() => expect(client.getStatus.mock.calls.length).toBeGreaterThan(1));
    expect(client.getScript).toHaveBeenCalledTimes(1);
  });
});

describe('round 2 D4: cards follow the server state', () => {
  it('a press that loses to another tab reloads the chat and shows what the winner left', async () => {
    client.getChat
      .mockResolvedValueOnce({ messages: [msg('a1', 'assistant', 'x', [CONFIRM])], usage: { used: 1, limit: 150 } })
      .mockResolvedValue({ messages: [msg('a1', 'assistant', 'x', [{ ...CONFIRM, state: 'used' }])], usage: { used: 1, limit: 150 } });
    client.confirmChatAction.mockRejectedValue(new StoryApiError({ status: 409, code: 'confirm_outdated', message: 'Out of date.' }));
    const onChanged = vi.fn();
    render(<ChatPanel project={project} onChanged={onChanged} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Start for 5 credits' }));
    await waitFor(() => expect(client.getChat).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Started')).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalled();
  });

  it('cards read their state again when the panel reloads (the tab comes back into view)', async () => {
    client.getChat
      .mockResolvedValueOnce({ messages: [msg('a1', 'assistant', 'x', [CONFIRM])], usage: { used: 1, limit: 150 } })
      .mockResolvedValue({ messages: [msg('a1', 'assistant', 'x', [{ ...CONFIRM, state: 'outdated' }])], usage: { used: 1, limit: 150 } });
    render(<ChatPanel project={project} onChanged={vi.fn()} />);
    await screen.findByRole('button', { name: 'Start for 5 credits' });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(await screen.findByText('Out of date')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Start for/ })).toBeNull();
  });
});

describe('round 3 E1: included cards', () => {
  it('a card at 0 credits reads Start (included) and presses through the confirm route', async () => {
    const included = { ...CONFIRM, id: 'c-free', quote: { label: 'New pictures of Maya', credits: 0 }, confirm: { ...CONFIRM.confirm, body: { castId: 'c1', note: '', expected_credits: 0 } } };
    client.getChat.mockResolvedValue({ messages: [msg('a1', 'assistant', 'x', [included])], usage: { used: 1, limit: 150 } });
    client.confirmChatAction.mockResolvedValue({ charged: 0 });
    render(<ChatPanel project={project} onChanged={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Start (included)' }));
    expect(client.confirmChatAction).toHaveBeenCalledWith('p1', 'c-free');
    expect(await screen.findByText('Started')).toBeInTheDocument();
  });
});
