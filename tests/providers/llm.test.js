import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({ requests: [], responses: [], constructed: [] }));

vi.mock('@anthropic-ai/sdk', () => {
  class APIError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
  class RateLimitError extends APIError {}
  function create(req) {
    sdk.requests.push(req);
    const next = sdk.responses.shift();
    if (next instanceof Error) throw next;
    return Promise.resolve(next);
  }
  class Anthropic {
    constructor(opts) {
      sdk.constructed.push(opts);
      this.messages = { create };
      this.beta = { messages: { create } };
    }
  }
  Anthropic.APIError = APIError;
  Anthropic.RateLimitError = RateLimitError;
  return { default: Anthropic, APIError, RateLimitError };
});

import Anthropic from '@anthropic-ai/sdk';
import { chatWithTools, completeJSON } from '../../lib/providers/llm.js';
import { MODEL_IDS } from '../../lib/providers/config.js';
import { _resetMocks, registerMock, unregisterMock } from '../../lib/providers/mock.js';

const schema = {
  type: 'object',
  properties: { title: { type: 'string' } },
  required: ['title'],
  additionalProperties: false,
};

function text(t, stop = 'end_turn') {
  return { content: [{ type: 'text', text: t }], stop_reason: stop };
}

beforeEach(() => {
  sdk.requests.length = 0;
  sdk.responses.length = 0;
  sdk.constructed.length = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
  _resetMocks();
});

describe('model ids', () => {
  it('maps fast to the latest Haiku and smart to the latest Sonnet', () => {
    expect(MODEL_IDS.llm).toEqual({ fast: 'claude-haiku-5-5', smart: 'claude-sonnet-5-5' });
  });
});

describe('completeJSON (mock mode)', () => {
  it('returns the registered mock and never builds a client', async () => {
    registerMock('story_title', (input) => ({ title: `Mock for ${input.messages[0].content}` }));
    const out = await completeJSON({
      tier: 'fast', name: 'story_title', system: 's', schema,
      messages: [{ role: 'user', content: 'bakery' }],
    });
    expect(out).toEqual({ title: 'Mock for bakery' });
    expect(sdk.constructed).toHaveLength(0);
  });

  it('validates name and schema in mock mode exactly like the real path', async () => {
    registerMock('story_title', () => ({ title: 'x' }));
    await expect(completeJSON({ tier: 'fast', name: 'story_title', messages: [] })).rejects.toMatchObject({ code: 'failed' });
    await expect(completeJSON({ tier: 'fast', name: 'story_title', schema: { type: 'string' }, messages: [] })).rejects.toMatchObject({ code: 'failed' });
    await expect(completeJSON({ tier: 'fast', schema, messages: [] })).rejects.toMatchObject({ code: 'failed' });
  });

  it('throws blocked for [[mock:blocked]] in completeJSON and chatWithTools', async () => {
    registerMock('story_title', () => ({ title: 'x' }));
    await expect(completeJSON({
      tier: 'fast', name: 'story_title', schema, messages: [{ role: 'user', content: 'x [[mock:blocked]]' }],
    })).rejects.toMatchObject({ code: 'blocked' });
    await expect(chatWithTools({
      tools: [], onToolCall: vi.fn(), messages: [{ role: 'user', content: [{ type: 'text', text: '[[mock:blocked]]' }] }],
    })).rejects.toMatchObject({ code: 'blocked' });
  });

  it('throws a clear error naming a missing mock', async () => {
    await expect(completeJSON({ tier: 'fast', name: 'nope_schema', schema, messages: [] }))
      .rejects.toThrow(/nope_schema/);
  });
});

describe('completeJSON (real mode)', () => {
  beforeEach(() => {
    vi.stubEnv('STORY_MOCK', '0');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
  });

  it('sends structured output for the fast tier and parses the reply', async () => {
    sdk.responses.push(text('{"title":"The Little Oven"}'));
    const out = await completeJSON({
      tier: 'fast', name: 'story_title', system: 'Be brief.', schema, maxTokens: 500,
      messages: [{ role: 'user', content: 'bakery' }],
    });
    expect(out).toEqual({ title: 'The Little Oven' });
    const req = sdk.requests[0];
    expect(req.model).toBe('claude-haiku-5-5');
    expect(req.max_tokens).toBe(500);
    expect(req.system).toBe('Be brief.');
    expect(req.output_config.format).toEqual({ type: 'json_schema', schema });
    expect(req).not.toHaveProperty('temperature');
    expect(req).not.toHaveProperty('tool_choice');
  });

  it('uses the latest Sonnet with server-side fallbacks for the smart tier', async () => {
    sdk.responses.push(text('{"title":"x"}'));
    await completeJSON({ tier: 'smart', name: 'story_title', schema, messages: [{ role: 'user', content: 'x' }] });
    expect(sdk.requests[0].model).toBe('claude-sonnet-5-5');
    expect(sdk.requests[0].max_tokens).toBe(16000);
    expect(sdk.requests[0].fallbacks).toBe('default');
    expect(sdk.requests[0].betas).toEqual(['server-side-fallback-2026-07-01']);
  });

  it('maps a refusal to blocked and max_tokens to failed', async () => {
    sdk.responses.push(text('', 'refusal'));
    await expect(completeJSON({ tier: 'fast', name: 'n', schema, messages: [] })).rejects.toMatchObject({ code: 'blocked' });
    sdk.responses.push(text('{"tit', 'max_tokens'));
    await expect(completeJSON({ tier: 'fast', name: 'n', schema, messages: [] })).rejects.toMatchObject({ code: 'failed' });
  });

  it('maps SDK rate limits to rate_limited', async () => {
    sdk.responses.push(new Anthropic.RateLimitError(429, 'rate limited'));
    await expect(completeJSON({ tier: 'fast', name: 'n', schema, messages: [] })).rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('throws config naming ANTHROPIC_API_KEY when missing', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    await expect(completeJSON({ tier: 'fast', name: 'n', schema, messages: [] }))
      .rejects.toMatchObject({ code: 'config', message: expect.stringContaining('ANTHROPIC_API_KEY') });
  });

  it('rejects an unknown tier', async () => {
    await expect(completeJSON({ tier: 'huge', name: 'n', schema, messages: [] })).rejects.toMatchObject({ code: 'failed' });
  });
});

describe('chatWithTools', () => {
  const tools = [{
    name: 'update_scene',
    description: 'Change one scene',
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  }];

  it('runs the tool loop until the model stops', async () => {
    vi.stubEnv('STORY_MOCK', '0');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    sdk.responses.push({
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: 'Updating.' },
        { type: 'tool_use', id: 'tu_1', name: 'update_scene', input: { id: 's1' } },
      ],
    });
    sdk.responses.push(text('Done.'));
    const onToolCall = vi.fn(async ({ name, input }) => ({ ok: true, name, id: input.id }));
    const { messages } = await chatWithTools({
      system: 'You edit stories.', tools, onToolCall,
      messages: [{ role: 'user', content: 'Make scene 1 shorter' }],
    });
    expect(onToolCall).toHaveBeenCalledWith({ name: 'update_scene', input: { id: 's1' }, id: 'tu_1' });
    expect(sdk.requests[0].model).toBe('claude-sonnet-5-5');
    expect(sdk.requests[0].tool_choice).toEqual({ type: 'auto' });
    expect(messages).toHaveLength(4);
    expect(messages[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '{"ok":true,"name":"update_scene","id":"s1"}' }],
    });
    expect(messages[3].content[0].text).toBe('Done.');
  });

  it('runs several tool calls one at a time, in order', async () => {
    vi.stubEnv('STORY_MOCK', '0');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    sdk.responses.push({
      stop_reason: 'tool_use',
      content: [
        { type: 'tool_use', id: 'a', name: 'update_scene', input: { id: 's1' } },
        { type: 'tool_use', id: 'b', name: 'update_scene', input: { id: 's2' } },
      ],
    });
    sdk.responses.push(text('Done.'));
    const log = [];
    const onToolCall = async ({ id }) => {
      log.push(`start ${id}`);
      await new Promise((r) => setTimeout(r, id === 'a' ? 20 : 0));
      log.push(`end ${id}`);
      return 'ok';
    };
    const { messages } = await chatWithTools({ tools, onToolCall, messages: [{ role: 'user', content: 'x' }] });
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b']);
    expect(messages[2].content.map((r) => r.tool_use_id)).toEqual(['a', 'b']);
  });

  it('reports a failing tool back to the model as an error result', async () => {
    vi.stubEnv('STORY_MOCK', '0');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    sdk.responses.push({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_9', name: 'update_scene', input: {} }] });
    sdk.responses.push(text('Sorry.'));
    const { messages } = await chatWithTools({
      tools, messages: [{ role: 'user', content: 'x' }],
      onToolCall: async () => { throw new Error('scene not found'); },
    });
    expect(messages[2].content[0]).toMatchObject({ tool_use_id: 'tu_9', is_error: true, content: 'scene not found' });
  });

  it('passes onToolCall to a registered chatWithTools mock', async () => {
    registerMock('chatWithTools', async ({ messages, onToolCall }) => {
      const result = await onToolCall({ name: 'update_scene', input: { id: 's2' }, id: 'mock_tu_1' });
      return { messages: [...messages, { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(result) }] }] };
    });
    const onToolCall = vi.fn(async () => ({ ok: true }));
    const { messages } = await chatWithTools({ tools, messages: [{ role: 'user', content: 'edit' }], onToolCall });
    expect(onToolCall).toHaveBeenCalledWith({ name: 'update_scene', input: { id: 's2' }, id: 'mock_tu_1' });
    expect(messages[1].content[0].text).toBe('{"ok":true}');
    unregisterMock('chatWithTools');
  });

  it('returns a deterministic reply in mock mode', async () => {
    const { messages } = await chatWithTools({ tools, messages: [{ role: 'user', content: 'hi' }], onToolCall: vi.fn() });
    expect(messages).toHaveLength(2);
    expect(messages[1].role).toBe('assistant');
    expect(sdk.constructed).toHaveLength(0);
  });
});
