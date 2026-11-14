/*
 * Claude calls for the story pipeline.
 *
 *   completeJSON({ tier, name, system, messages, schema, maxTokens }) -> parsed object
 *     tier 'fast' (latest Haiku) | 'smart' (latest Sonnet). `schema` is a JSON
 *     schema sent as structured output. `name` names the schema; in mock mode
 *     the result is mockResponder(name, { tier, system, messages, schema }).
 *   chatWithTools({ system, messages, tools, onToolCall, maxTurns }) -> { messages }
 *     Runs the tool loop on the smart tier. tools = [{ name, description,
 *     input_schema }]. onToolCall({ name, input, id }) returns the tool result
 *     (string or JSON-serialisable); a throw is reported back as an error result.
 *     The returned messages are the input messages plus every new turn. In mock
 *     mode a registered 'chatWithTools' mock gets { system, messages, tools,
 *     onToolCall } (so it can run tools); otherwise a fixed reply.
 */

import Anthropic from '@anthropic-ai/sdk';

import { MODEL_IDS, PROVIDER_CONFIG } from './config.js';
import { ProviderError, requireEnv } from './errors.js';
import { hasMock, isMock, mockResponder } from './mock.js';

const PROVIDER = 'anthropic';

function client() {
  return new Anthropic({ apiKey: requireEnv(PROVIDER_CONFIG.anthropic.env, PROVIDER) });
}

function modelFor(tier) {
  const model = MODEL_IDS.llm[tier];
  if (!model) throw new ProviderError('failed', undefined, { cause: new Error(`Unknown LLM tier ${tier}`) });
  return model;
}

function mapSdkError(err) {
  if (err instanceof ProviderError) return err;
  if (err instanceof Anthropic.RateLimitError || err?.status === 429) {
    return new ProviderError('rate_limited', undefined, { cause: err, provider: PROVIDER });
  }
  return new ProviderError('failed', undefined, { cause: err, provider: PROVIDER });
}

/** Sends one Messages request for a tier, with the smart tier's refusal fallback. */
async function send(tier, params) {
  const cfg = PROVIDER_CONFIG.anthropic;
  const api = client();
  const request = {
    ...params,
    model: modelFor(tier),
    max_tokens: params.max_tokens || cfg.defaultMaxTokens,
    output_config: { effort: cfg.effort[tier], ...(params.output_config || {}) },
  };
  if (!request.system) delete request.system;
  const fallback = cfg.fallback[tier];
  try {
    if (fallback) return await api.beta.messages.create({ ...request, ...fallback });
    return await api.messages.create(request);
  } catch (err) {
    throw mapSdkError(err);
  }
}

function checkStop(response) {
  if (response?.stop_reason === 'refusal') {
    throw new ProviderError('blocked', undefined, { cause: response.stop_details || response, provider: PROVIDER });
  }
  if (response?.stop_reason === 'max_tokens') {
    throw new ProviderError('failed', undefined, { cause: new Error('Response hit max_tokens'), provider: PROVIDER });
  }
}

export async function completeJSON({ tier = 'fast', name, system, messages = [], schema, maxTokens }) {
  modelFor(tier);
  if (isMock()) return mockResponder(name, { tier, system, messages, schema });
  if (!schema || typeof schema !== 'object') {
    throw new ProviderError('failed', undefined, { cause: new Error('completeJSON needs a JSON schema') });
  }
  const response = await send(tier, {
    max_tokens: maxTokens,
    system,
    messages,
    output_config: { format: { type: 'json_schema', schema } },
  });
  checkStop(response);
  const text = (response.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new ProviderError('failed', undefined, { cause: new Error(`Unparseable JSON from ${name}: ${text.slice(0, 300)}`), provider: PROVIDER });
  }
}

function toolResultContent(value) {
  if (typeof value === 'string') return value;
  return JSON.stringify(value ?? null);
}

export async function chatWithTools({ system, messages = [], tools = [], onToolCall, maxTurns }) {
  if (isMock()) {
    if (hasMock('chatWithTools')) return mockResponder('chatWithTools', { system, messages, tools, onToolCall });
    return {
      messages: [...messages, { role: 'assistant', content: [{ type: 'text', text: 'Mock reply: no changes made.' }] }],
    };
  }
  const limit = maxTurns || PROVIDER_CONFIG.anthropic.maxToolTurns;
  const history = [...messages];
  const toolDefs = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
  for (let turn = 0; turn < limit; turn += 1) {
    const response = await send('smart', {
      system,
      messages: history,
      ...(toolDefs.length ? { tools: toolDefs, tool_choice: { type: 'auto' } } : {}),
    });
    checkStop(response);
    history.push({ role: 'assistant', content: response.content });
    if (response.stop_reason !== 'tool_use') return { messages: history };

    const uses = response.content.filter((b) => b.type === 'tool_use');
    const results = await Promise.all(uses.map(async (use) => {
      try {
        const out = await onToolCall({ name: use.name, input: use.input, id: use.id });
        return { type: 'tool_result', tool_use_id: use.id, content: toolResultContent(out) };
      } catch (err) {
        return { type: 'tool_result', tool_use_id: use.id, is_error: true, content: String(err?.message || err) };
      }
    }));
    history.push({ role: 'user', content: results });
  }
  throw new ProviderError('failed', undefined, { cause: new Error(`Tool loop exceeded ${limit} turns`), provider: PROVIDER });
}
