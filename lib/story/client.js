// Browser-safe client for /api/story. Every maker component goes through this
// file, so a route that moves or changes shape is fixed in one place.
// Imports nothing from the server side of the app.
import { AUDIO_LIMITS, VOICE_MESSAGES, audioExtension, sampleLengthMessage } from './voiceRules.js';
import { ASSET_LIMITS, ASSET_MESSAGES, IMAGE_API_KINDS, IMAGE_MIME, VIDEO_MIME, imageExtension, videoExtension } from './assetRules.js';

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
  if (!res.ok) {
    const err = normalizeError(res.status, data);
    // A zero-credit account is refused with plan_required, but credits would pay for the step (topup_ok). Fill in what the
    // screen needs to say so: the step's price (the amount the button showed, which every priced call sends) and 0 available.
    if (err.status === 402 && err.code === 'plan_required' && data?.topup_ok === true) {
      const price = Number(body?.expected_credits ?? body?.confirmTotal);
      if (Number.isFinite(price) && price > 0) err.needed = price;
      err.available = 0;
    }
    throw err;
  }
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
// expectedCredits: the setup fee on the button (0 once it is paid); a different price is 409 quote_changed and nothing is charged.
export const startCast = (id, expectedCredits) => request('POST', `${pid(id)}/cast`, Number.isInteger(expectedCredits) ? { expected_credits: expectedCredits } : {});
// expectedCredits: the price the customer was shown (cast.regen_credits); a different price is 409 quote_changed.
export const regenCast = (id, castId, note, expectedCredits) =>
  request('POST', `${pid(id)}/cast-regen`, { castId, note, ...(Number.isInteger(expectedCredits) ? { expected_credits: expectedCredits } : {}) });
export const pickCast = (id, castId, candidateIndex) => request('POST', `${pid(id)}/cast-pick`, { castId, candidateIndex });
// Uses one of the customer's own pictures (an asset from uploadMedia / getAssets) for a character. -> { cast }
export const setCastImage = (id, castId, assetId) => request('POST', `${pid(id)}/cast-image`, { castId, assetId });
// "Make them look like a picture" (paid): draws ONE new picture of the character from one of the customer's own pictures
// (an asset id from uploadMedia / getAssets), in the project's style, then its sheet. expectedCredits: cast.look_credits, the
// price the customer was shown; a different price is 409 quote_changed and nothing is charged. -> { cast, charged }
export const drawLikePicture = (id, castId, assetId, note, expectedCredits) =>
  request('POST', `${pid(id)}/cast-look`, { castId, assetId, ...(note ? { note } : {}), ...(Number.isInteger(expectedCredits) ? { expected_credits: expectedCredits } : {}) });
// Retrying a picture that FAILED (the provider's fault) must cost the customer nothing. These use the same routes as a
// regenerate or a re-make, with retry: true, so the cast and storyboard routes can make that attempt free.
export const retryCast = (id, castId, expectedCredits) =>
  request('POST', `${pid(id)}/cast-regen`, { castId, retry: true, ...(Number.isInteger(expectedCredits) ? { expected_credits: expectedCredits } : {}) });
export const retryStill = (id, shotId) => request('POST', `${pid(id)}/stills`, { shotIds: [shotId], retry: true });
// confirm: the token from a 409 rebuild_loses_clips; it applies exactly the plan the customer was asked about.
export const buildShots = (id, { confirm = null } = {}) => request('POST', `${pid(id)}/shots`, typeof confirm === 'string' && confirm ? { confirm } : {});
// expectedCredits: the price on the button (still_credits summed); a different price is 409 quote_changed and nothing starts.
export const makeStills = (id, shotIds, expectedCredits) =>
  request('POST', `${pid(id)}/stills`, { ...(shotIds ? { shotIds } : {}), ...(Number.isInteger(expectedCredits) ? { expected_credits: expectedCredits } : {}) });
export const updateShot = (id, shotId, patch) => request('PATCH', `${pid(id)}/shot`, { shotId, patch });
// -> { total, lines:[{ label, credits }], holdNeeded }
export const getQuote = (id, shotIds) => request('POST', `${pid(id)}/quote`, shotIds ? { shotIds } : {});
// The simple maker's "Looks good, design my video" price: -> { total, castFee, stills, lines:[{ key, label, credits, included }] }. Read only. 409 script_missing.
export const getPlanQuote = (id) => request('POST', `${pid(id)}/quote-plan`, {});
// Sets or clears the marker that the customer pressed "Looks good, design my video" (free parts may then start by themselves).
export const setPlanRequested = (id, requested) => request('POST', `${pid(id)}/plan-request`, { requested });
export const startGeneration = (id, shotIds, confirmTotal) => request('POST', `${pid(id)}/generate`, { shotIds, confirmTotal });
export const rerollShot = (id, shotId, expectedCredits) =>
  request('POST', `${pid(id)}/reroll`, Number.isInteger(expectedCredits) ? { shotId, expected_credits: expectedCredits } : { shotId });

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

// ---- own audio and cloned voices (lib/story/voices.js). Clones are private to the signed-in customer.
// GET voices -> { voices:[{ id, name, status:'pending'|'ready'|'failed', error, voiceId, sampleUrl, seconds, consent_at, credits, retry_credits }],
//   presets:[{ id, name, gender, sampleUrl }], price, statement, limits:{ sampleMinSeconds, sampleMaxSeconds, maxBytes } }
export const getVoices = () => request('GET', '/voices');
// consent must be exactly true; the server stores its own statement text. expectedCredits is the price on the button
// (a different price is 409 quote_changed and nothing is charged). -> { voice, charged }
export const cloneVoice = ({ name, consent, sampleAssetId, expectedCredits }) =>
  request('POST', '/voices', { name, consent, sampleAssetId, ...(Number.isInteger(expectedCredits) ? { expected_credits: expectedCredits } : {}) });
// A failed clone, tried again with the consent already on file. -> { voice, charged }
export const retryVoiceClone = (id, expectedCredits) =>
  request('POST', '/voices', { retry: id, ...(Number.isInteger(expectedCredits) ? { expected_credits: expectedCredits } : {}) });
export const deleteVoiceClone = (id) => request('DELETE', `/voices?id=${encodeURIComponent(id)}`);

const AUDIO_TYPES = { mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4' };

/** Seconds of an audio file the browser can read, or null (it cannot be read here, so the server decides). */
export function readAudioSeconds(file) {
  return new Promise((resolve) => {
    if (typeof Audio === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) return resolve(null);
    const url = URL.createObjectURL(file);
    const el = new Audio();
    const done = (value) => { clearTimeout(timer); URL.revokeObjectURL(url); resolve(value); };
    const timer = setTimeout(() => done(null), 4000);
    el.preload = 'metadata';
    el.onloadedmetadata = () => done(Number.isFinite(el.duration) ? el.duration : null);
    el.onerror = () => done(null);
    el.src = url;
  });
}

/**
 * Uploads an mp3, wav or m4a of the customer's own (at most 20 MB) straight to storage, then has the server look at it
 * and keep it. kind: 'voice_sample' (10 to 60 s) | 'voice_track' | 'music'. -> { id, kind, name, url, seconds, bytes }
 * A file that is the wrong type, too big or (for a sample) the wrong length is refused here with the server's words.
 */
export async function uploadAudio(file, kind, { onProgress } = {}) {
  const ext = audioExtension(file?.name);
  const refuse = (message, field = 'url') => new StoryApiError({ status: 422, code: 'validation_failed', message, field });
  if (!ext) throw refuse(VOICE_MESSAGES.wrongType);
  if (file.size > AUDIO_LIMITS.maxBytes) throw refuse(VOICE_MESSAGES.tooBig);
  if (kind === 'voice_sample') {
    const seconds = await readAudioSeconds(file);
    if (seconds !== null && (seconds < AUDIO_LIMITS.sampleMinSeconds || seconds > AUDIO_LIMITS.sampleMaxSeconds)) throw refuse(sampleLengthMessage(seconds));
  }
  const { uploadPrefix } = await request('GET', '/assets');
  const base = String(file.name).replace(/\.[^.]*$/, '').replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 40) || 'audio';
  let url;
  try {
    const { upload } = await import('@vercel/blob/client');
    const blob = await upload(`${uploadPrefix}${base}.${ext}`, file, {
      access: 'public',
      handleUploadUrl: '/api/upload-token',
      clientPayload: JSON.stringify({ surface: 'story-audio' }),
      contentType: AUDIO_TYPES[ext],
      onUploadProgress: ({ percentage }) => onProgress?.(Math.round(percentage)),
    });
    url = blob.url;
  } catch (err) {
    throw new StoryApiError({ status: 0, code: 'upload_failed', message: 'The upload did not finish. Check your connection and try again.', body: { detail: String(err?.message || '') } });
  }
  return (await request('POST', '/assets', { kind, url, name: String(file.name).replace(/\.[^.]*$/, '') })).asset;
}

// ---- own pictures and clips, and the brand kit (lib/story/assets.js)
// An asset: { id, kind: 'logo'|'product'|'mascot'|'recording'|'clip'|'audio'|..., name, url, seconds, bytes, width, height, inBrandKit }
// GET assets?list=1[&kinds=a,b][&brand=1] -> the caller's files, newest first. kinds: an array of kinds to keep; brand: only the brand kit's.
export const getAssets = async ({ kinds, brand } = {}) => {
  const q = ['list=1', ...(kinds?.length ? [`kinds=${encodeURIComponent(kinds.join(','))}`] : []), ...(brand ? ['brand=1'] : [])].join('&');
  return (await request('GET', `/assets?${q}`)).assets || [];
};
// 409 asset_in_use { projects:[{ id, title }], voices:[{ id, name }] } while a video still uses the file; 404 when it is not theirs.
export const deleteAsset = (assetId) => request('DELETE', `/assets?id=${encodeURIComponent(assetId)}`);
// GET brand -> { brand: { offer, audience, tone, avoid:[word], colors:['#rrggbb'], logo: asset | null } }; PUT saves the fields given.
export const getBrand = async () => (await request('GET', '/brand')).brand;
export const saveBrand = async (patch) => (await request('PUT', '/brand', patch)).brand;
// The pictures a video draws on (product pictures are what its stills use): [{ ...asset, role: 'product'|'logo'|'mascot' }].
export const getProjectAssets = async (id) => (await request('GET', `${pid(id)}/assets`)).assets || [];
export const attachProjectAsset = async (id, assetId, role) => (await request('POST', `${pid(id)}/assets`, { assetId, role })).assets;
export const detachProjectAsset = async (id, assetId, role) => (await request('DELETE', `${pid(id)}/assets`, { assetId, ...(role ? { role } : {}) })).assets;

/**
 * Checks a picture or clip before it is uploaded, with the server's own words: -> null when it can go, else the message.
 * kind: logo | product | mascot (a PNG, JPG or WebP up to 5 MB) or recording | clip (an MP4 or MOV up to 200 MB).
 */
export function checkMedia(file, kind) {
  if (IMAGE_API_KINDS.includes(kind)) {
    if (!imageExtension(file?.name)) return ASSET_MESSAGES.wrongImage;
    if (file.size > ASSET_LIMITS.imageMaxBytes) return ASSET_MESSAGES.imageTooBig;
    return null;
  }
  if (!videoExtension(file?.name)) return ASSET_MESSAGES.wrongVideo;
  if (file.size > ASSET_LIMITS.videoMaxBytes) return ASSET_MESSAGES.videoTooBig;
  return null;
}

/**
 * Uploads a picture or clip of the customer's own straight to storage (Vercel Blob, under story-brand/<userId>/), then has
 * the server look at it and keep it. The server checks it again (what it really is, its size and length, and pictures against
 * the content rules); a refusal comes back in words the screen shows as they are. -> the asset
 */
export async function uploadMedia(file, kind, { onProgress, inBrandKit } = {}) {
  const refusal = checkMedia(file, kind);
  if (refusal) throw new StoryApiError({ status: 422, code: 'validation_failed', message: refusal, field: 'url' });
  const { brandPrefix } = await request('GET', '/assets');
  const isImage = IMAGE_API_KINDS.includes(kind);
  const ext = isImage ? imageExtension(file.name) : videoExtension(file.name);
  const base = String(file.name).replace(/\.[^.]*$/, '').replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 40) || 'file';
  let url;
  try {
    const { upload } = await import('@vercel/blob/client');
    const blob = await upload(`${brandPrefix}${base}.${ext}`, file, {
      access: 'public',
      handleUploadUrl: '/api/upload-token',
      clientPayload: JSON.stringify({ surface: 'story-brand' }),
      contentType: isImage ? IMAGE_MIME[ext] : VIDEO_MIME[ext],
      onUploadProgress: ({ percentage }) => onProgress?.(Math.round(percentage)),
    });
    url = blob.url;
  } catch (err) {
    throw new StoryApiError({ status: 0, code: 'upload_failed', message: 'The upload did not finish. Check your connection and try again.', body: { detail: String(err?.message || '') } });
  }
  return (await request('POST', '/assets', { kind, url, name: String(file.name).replace(/\.[^.]*$/, ''), ...(inBrandKit === undefined ? {} : { inBrandKit }) })).asset;
}

// ---- render (lib/story/render.js): the first render of a project is free, later ones are charged (render price). -> story_renders row. 409 render_busy / shots_not_ready.
// expectedCredits: the price on the button; a different price is 409 quote_changed ({ credits }) and nothing is held.
export const startRender = async (id, expectedCredits) => (await request('POST', `${pid(id)}/render`, Number.isInteger(expectedCredits) ? { expected_credits: expectedCredits } : {})).render;

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
// Its own route (/chat/confirm, maxDuration 25), because a confirm may start clips.
export const confirmChatAction = (id, confirmId) => request('POST', '/chat/confirm', { projectId: id, confirmId });

// ---- reference video (lib/story/analyze.js)
// GET analyze -> the view: { id, status: 'pending'|'ready'|'failed', error, source_type, source_url, platform, duration,
//   beats:[{ ord, start, end, visual, said, why, thumb }], hook, structure, mood, mode, shots, rights_confirmed_at } | null
export const getReference = async (id) => (await request('GET', `${pid(id)}/analyze`)).reference || null;
// source: { type: 'upload', url } (from uploadReference) | { type: 'upload', assetId } | { type: 'link', url }. rights must be true.
export const startAnalysis = async (id, { source, rights }) => (await request('POST', `${pid(id)}/analyze`, { source, rights })).reference;

/**
 * Uploads a reference video for a project straight to storage (Vercel Blob), under story-uploads/<projectId>/.
 * The token route allows MP4 and MOV up to 100 MB for the project's owner only. -> the file's URL
 */
export async function uploadReference(projectId, file, { onProgress } = {}) {
  const { upload } = await import('@vercel/blob/client');
  const base = String(file?.name || 'reference').replace(/\.[^.]*$/, '').replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 40) || 'reference';
  const mov = file?.type === 'video/quicktime' || (!file?.type && /\.mov$/i.test(file?.name || ''));
  try {
    const blob = await upload(`story-uploads/${projectId}/${base}.${mov ? 'mov' : 'mp4'}`, file, {
      access: 'public',
      handleUploadUrl: '/api/upload-token',
      clientPayload: JSON.stringify({ surface: 'story-reference', projectId }),
      contentType: mov ? 'video/quicktime' : 'video/mp4',
      onUploadProgress: ({ percentage }) => onProgress?.(Math.round(percentage)),
    });
    return blob.url;
  } catch (err) {
    throw new StoryApiError({ status: 0, code: 'upload_failed', message: 'The upload did not finish. Check your connection and try again.', body: { detail: String(err?.message || '') } });
  }
}
