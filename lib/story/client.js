// Browser-safe client for /api/story. Every maker component goes through this
// file, so a route that moves or changes shape is fixed in one place.
// Imports nothing from the server side of the app.

/**
 * The one error type every function here throws.
 *   status    HTTP status (0 when the request never reached the server)
 *   code      machine code ('insufficient_credits', 'plan_required', 'validation_failed', 'BLOCKED_NSFW', ...)
 *   message   text the server meant for the customer (may be empty)
 *   needed / available   credits, on a 402 insufficient_credits
 *   field     the input a 422 is about, when the server says
 */
export class StoryApiError extends Error {
  constructor({ status = 0, code = '', message = '', needed, available, field, body } = {}) {
    super(message || code || `Request failed (${status})`);
    this.name = 'StoryApiError';
    this.status = status;
    this.code = code;
    this.serverMessage = message;
    this.needed = needed;
    this.available = available;
    this.field = field;
    this.body = body;
  }
}

// Two body shapes exist: story/limit/provider errors are { error: <code>, message, ... };
// moderation is { error: <message>, code: 'BLOCKED_NSFW' | 'MODERATION_UNAVAILABLE' }.
export function normalizeError(status, body) {
  const b = body && typeof body === 'object' ? body : {};
  let code = '';
  let message = '';
  if (typeof b.code === 'string' && b.code) {
    code = b.code;
    message = typeof b.error === 'string' ? b.error : typeof b.message === 'string' ? b.message : '';
  } else {
    code = typeof b.error === 'string' ? b.error : '';
    message = typeof b.message === 'string' ? b.message : '';
    // A bare sentence in `error` (older routes) is a message, not a code.
    if (code && /\s/.test(code)) {
      message = message || code;
      code = '';
    }
  }
  return new StoryApiError({ status, code, message, needed: b.needed, available: b.available, field: b.field, body: b });
}

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(`/api/story${path}`, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new StoryApiError({ status: 0, code: 'network', message: '' });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw normalizeError(res.status, data);
  return data;
}

const pid = (id) => `/projects/${encodeURIComponent(id)}`;

// ---- projects (exist today)
export const listProjects = async () => (await request('GET', '/projects')).projects || [];
export const createProject = async (input) => (await request('POST', '/projects', input || {})).project;
export const getProject = async (id) => (await request('GET', pid(id))).project;
export const updateProject = async (id, patch) => (await request('PATCH', pid(id), patch)).project;
export const deleteProject = (id) => request('DELETE', pid(id));
export const duplicateProject = async (id) => (await request('POST', `${pid(id)}/duplicate`, {})).project;

// ---- script (exist today)
// GET script -> { script: Script | null }; Script = { id, version, scenes, violations:[{ sceneId, rule, message }], ... }
export const getScript = async (id) => (await request('GET', `${pid(id)}/script`)).script || null;
export const writeScript = async (id) => (await request('POST', `${pid(id)}/script`, {})).script;
// -> { script, changedSceneIds }
export const reviseScript = (id, instruction) => request('POST', `${pid(id)}/revise`, { instruction });
// patch: any of { title, visual, lines:[{ speaker, text }], mention }
export const updateScene = (id, sceneId, patch) => request('PATCH', `${pid(id)}/scene`, { sceneId, patch });

// ---- later tasks (written to the contract; may 404 until built)
// GET status -> { project, shots, cast, jobs, balance, render }
export const getStatus = (id) => request('GET', `${pid(id)}/status`);
export const startCast = (id) => request('POST', `${pid(id)}/cast`, {});
// expectedCredits: the price the customer was shown (cast.regen_credits); a different price is 409 quote_changed.
export const regenCast = (id, castId, note, expectedCredits) =>
  request('POST', `${pid(id)}/cast-regen`, { castId, note, ...(Number.isInteger(expectedCredits) ? { expected_credits: expectedCredits } : {}) });
export const pickCast = (id, castId, candidateIndex) => request('POST', `${pid(id)}/cast-pick`, { castId, candidateIndex });
// Retrying a picture that FAILED (the provider's fault) must cost the customer nothing. These use the same routes as a
// regenerate or a re-make, with retry: true, so the cast and storyboard routes can make that attempt free.
export const retryCast = (id, castId, expectedCredits) =>
  request('POST', `${pid(id)}/cast-regen`, { castId, retry: true, ...(Number.isInteger(expectedCredits) ? { expected_credits: expectedCredits } : {}) });
export const retryStill = (id, shotId) => request('POST', `${pid(id)}/stills`, { shotIds: [shotId], retry: true });
// confirm: the token from a 409 rebuild_loses_clips; it applies exactly the plan the customer was asked about.
export const buildShots = (id, { confirm = null } = {}) => request('POST', `${pid(id)}/shots`, typeof confirm === 'string' && confirm ? { confirm } : {});
export const makeStills = (id, shotIds) => request('POST', `${pid(id)}/stills`, shotIds ? { shotIds } : {});
export const updateShot = (id, shotId, patch) => request('PATCH', `${pid(id)}/shot`, { shotId, patch });
// -> { total, lines:[{ label, credits }], holdNeeded }
export const getQuote = (id, shotIds) => request('POST', `${pid(id)}/quote`, shotIds ? { shotIds } : {});
export const startGeneration = (id, shotIds, confirmTotal) => request('POST', `${pid(id)}/generate`, { shotIds, confirmTotal });
export const rerollShot = (id, shotId) => request('POST', `${pid(id)}/reroll`, { shotId });

// ---- voice and sound (lib/story/audio.js)
// GET audio -> the view: { plan, voices, applicable, narration, music } (see getAudio)
export const getAudio = async (id) => (await request('GET', `${pid(id)}/audio`)).audio;
// plan: any part of { voiceId, voiceTrackAssetId, music:{ type, prompt, assetId }, captions:{ on, style } } -> the view
export const saveAudioPlan = async (id, plan) => (await request('POST', `${pid(id)}/audio`, { plan })).audio;
// -> { audio, charged }. retry: true is Try again after the last attempt failed (costs what that attempt cost, never twice).
// expectedCredits: the price on the button; a different price is 409 quote_changed and nothing is charged.
const audioBody = ({ retry = false, expectedCredits } = {}) => ({ ...(retry ? { retry: true } : {}), ...(Number.isInteger(expectedCredits) ? { expected_credits: expectedCredits } : {}) });
export const makeNarration = (id, opts) => request('POST', `${pid(id)}/narration`, audioBody(opts));
export const makeMusic = (id, opts) => request('POST', `${pid(id)}/music`, audioBody(opts));

// ---- account
// -> { v2, balance:{ plan, topup, held, available }, history }
export const getBilling = () => request('GET', '/billing');
export const getPricing = () => request('GET', '/pricing');

// ---- chat helper (lib/story/chat.js)
// -> { messages:[{ id, role, text, confirms, created_at }], usage:{ used, limit } }
export const getChat = (id) => request('GET', `/chat?projectId=${encodeURIComponent(id)}`);
// -> { reply, confirms, tools, changed, usage, messages } (messages = the two new rows)
export const sendChat = (id, message) => request('POST', '/chat', { projectId: id, message });
// Presses a chat confirm card by its id. The server runs the card it stored, once, at the stored price:
// 409 confirm_used after the first press, 409 confirm_outdated when the price moved, and nothing is charged.
export const confirmChatAction = (id, confirmId) => request('POST', '/chat', { projectId: id, confirmId });
