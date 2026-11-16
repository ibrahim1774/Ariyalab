// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as client from '../../lib/story/client';

afterEach(() => vi.unstubAllGlobals());

describe('chat client (round 2 D1)', () => {
  it('presses a confirm card on the short confirm route, sending only the card id', async () => {
    const fn = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ confirmId: 'c1' }) }));
    vi.stubGlobal('fetch', fn);
    await client.confirmChatAction('p1', 'c1');
    const [url, init] = fn.mock.calls[0];
    expect(url).toBe('/api/story/chat/confirm');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ projectId: 'p1', confirmId: 'c1' });
  });
});
