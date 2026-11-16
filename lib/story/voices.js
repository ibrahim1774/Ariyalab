import { randomUUID } from 'node:crypto';
import { mkdtemp, open, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { holdCredits, releaseHold, settleHold } from '../credits.js';
import { screenText } from '../moderation.js';
import { getPricing } from '../pricing.js';
import { ProviderError } from '../providers/errors.js';
import { downloadToFile } from '../providers/http.js';
import { isMock } from '../providers/mock.js';
import { MOCK_STORAGE_PREFIX, deleteObject, localPathFor, matchesMagic } from '../providers/storage.js';
import { cloneVoice, listVoices } from '../providers/tts.js';
import { getClientIp } from '../meta.js';
import { audioInputArgs } from './audioProbe.js';
import { ownBlobHost } from './blobHost.js';
import { runFfmpeg, parseDuration } from './checks.js';
import { storyDb } from './db.js';
import { ConflictError, NotFoundError, StoryError, ValidationError } from './errors.js';
import { assertAllowed } from './limits.js';
import { AUDIO_LIMITS, CONSENT_STATEMENT, VOICE_MESSAGES, audioExtension, sampleLengthMessage } from './voiceRules.js';

export { AUDIO_LIMITS, CONSENT_STATEMENT, VOICE_MESSAGES };

/*
 * Own audio and cloned voices (spec 7.6).
 *
 * Uploads. The browser sends an mp3, wav or m4a straight to Vercel Blob (the token route allows 20 MB of audio under
 * story-audio/<userId>/), then calls registerAudio. The server looks at the stored file itself: size, the extension, the
 * first bytes, and what ffmpeg says it is (duration and audio codec; the repo bundles ffmpeg and no ffprobe, so the
 * probe reads ffmpeg's own report). A file that fails any of it is deleted and answered with a specific 422. A voice
 * sample must also be 10 to 60 seconds.
 *
 * Cloning. createVoice checks everything before it writes anything (consent, name, price, sample), then:
 *   claim   insert a 'pending' story_voices row with the consent record (the one-pending-per-customer index is the lock)
 *   hold    hold the price (voiceClone) with no project
 *   call    ask the provider (one paid call; it runs inside the request, whose route has maxDuration 300)
 *   settle  the clone worked: mark the row ready, then settle the hold. A failure releases the hold and marks the row
 *           failed. Any error before the call undoes the claim.
 * Retry of a failed clone claims the same row again (failed -> pending, one atomic update) and holds again, so a
 * retry never charges twice. recoverStalledVoices closes the money of a request that died in the middle.
 *
 * Privacy: every lookup filters by user_id. A clone is never shown to, or usable by, anyone else.
 */

const STALE_PENDING_MS = 6 * 60 * 1000; // the route's window is 300 s
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UPLOAD_KINDS = ['voice_sample', 'voice_track', 'music', 'audio'];
const MIME = { mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4' };
const CODECS = { mp3: (c) => c === 'mp3', wav: (c) => /^(pcm_|adpcm_)/.test(c), m4a: (c) => c === 'aac' || c === 'alac' };
const DOWNLOAD_MS = 60_000;
const FAILED_TEXT = 'The voice could not be cloned. Nothing was charged for this try.';
const STALE_TEXT = 'That took too long and was stopped. Nothing was charged for this try.';
const log = (...args) => console.error('[story-voices]', ...args);

// ---------------------------------------------------------------- uploads

/** The folder a customer's audio uploads go to. The token route allows only this prefix for that customer. */
export const uploadPrefix = (userId) => `story-audio/${userId}/`;

/** -> { ext, kind } facts of an ffmpeg `-i` report. Cover art (an attached picture) is not a video stream. */
export function parseAudioProbe(stderr) {
  const text = String(stderr);
  const seconds = parseDuration(text);
  const audio = /Stream #\d+:\d+[^\n]*?: Audio: ([a-z0-9_]+)/i.exec(text);
  const hasVideo = text.split('\n').some((l) => /Stream #\d+:\d+.*?: Video:/.test(l) && !/\(attached pic\)/.test(l));
  return { duration: Number.isFinite(seconds) ? seconds : null, codec: audio ? audio[1].toLowerCase() : null, hasVideo };
}

// The demuxer is forced from the extension and only the plain file protocol is allowed (see audioInputArgs).
async function probeAudio(file, ext) {
  const { stderr } = await runFfmpeg([...audioInputArgs(ext), '-i', file], { check: false, timeoutMs: 20_000 });
  return parseAudioProbe(stderr);
}

export async function readHead(file) {
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(16);
    const { bytesRead } = await fh.read(buf, 0, 16, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** The storage key of an upload of this customer's, from its URL; null for anything else. */
export function uploadKey(userId, url, { mock = isMock() } = {}) {
  if (typeof url !== 'string') return null;
  let key = null;
  if (mock) {
    if (url.startsWith(MOCK_STORAGE_PREFIX)) key = url.slice(MOCK_STORAGE_PREFIX.length);
  } else {
    try {
      const u = new URL(url);
      // Only our own Blob store counts: any other store's file is someone else's.
      const host = ownBlobHost();
      if (host && u.protocol === 'https:' && u.hostname.toLowerCase() === host && !u.port) key = decodeURIComponent(u.pathname.replace(/^\/+/, ''));
    } catch {
      key = null;
    }
  }
  if (!key || key.includes('..') || !key.startsWith(uploadPrefix(userId))) return null;
  const rest = key.slice(uploadPrefix(userId).length);
  if (!rest || rest.includes('/') || !audioExtension(rest)) return null;
  return key;
}

/** The size of the stored upload, from our own store (Blob head in real mode, the mock file on disk). Null when it is not there. */
export async function storedSize(url) {
  if (isMock()) {
    const local = localPathFor(url);
    const found = local ? await stat(local).catch(() => null) : null;
    return found?.isFile() ? found.size : null;
  }
  const { head } = await import('@vercel/blob');
  const info = await head(url).catch(() => null);
  return info?.size ?? null;
}

/** A local copy to read; mock files are read in place. -> { file, cleanup } */
export async function localCopy(url, { maxBytes = AUDIO_LIMITS.maxBytes, tooBig = VOICE_MESSAGES.tooBig, timeoutMs = DOWNLOAD_MS } = {}) {
  const local = localPathFor(url);
  if (local) return { file: local, cleanup: async () => {} };
  if (isMock()) throw new ValidationError(VOICE_MESSAGES.upload, { field: 'url' });
  const dir = await mkdtemp(path.join(os.tmpdir(), 'story-asset-'));
  const dest = path.join(dir, 'upload');
  try {
    await downloadToFile(url, { dest, maxBytes, provider: 'storage', timeoutMs });
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    if (/larger than/i.test(err?.message || '')) throw new ValidationError(tooBig, { field: 'url' });
    throw err;
  }
  return { file: dest, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function isOwnBlobUrl(url) {
  try {
    return new URL(url).hostname.toLowerCase() === ownBlobHost();
  } catch {
    return false;
  }
}

export async function deleteUpload({ url, key }) {
  if (!isMock() && isOwnBlobUrl(url)) {
    const { del } = await import('@vercel/blob');
    await del(url);
  } else if (key) {
    await deleteObject({ key });
  }
}

/** Throws a specific 422 unless the file is the audio its extension says. -> { duration, codec } */
async function checkAudio(file, { ext, bytes, kind }) {
  if (bytes > AUDIO_LIMITS.maxBytes) throw new ValidationError(VOICE_MESSAGES.tooBig, { field: 'url' });
  const type = MIME[ext];
  if (!matchesMagic(type, await readHead(file))) throw new ValidationError(VOICE_MESSAGES.notAudio, { field: 'url' });
  const info = await probeAudio(file, ext).catch(() => null);
  if (!info || !info.duration || info.duration <= 0 || !info.codec || info.hasVideo || !CODECS[ext](info.codec)) {
    throw new ValidationError(VOICE_MESSAGES.notAudio, { field: 'url' });
  }
  if (kind === 'voice_sample' && (info.duration < AUDIO_LIMITS.sampleMinSeconds || info.duration > AUDIO_LIMITS.sampleMaxSeconds)) {
    throw new ValidationError(sampleLengthMessage(info.duration), { field: 'url' });
  }
  return info;
}

const assetView = (a) => ({ id: a.id, kind: a.kind, name: a.name, url: a.url, seconds: a.duration_seconds, bytes: a.bytes });

/**
 * Registers an audio file the customer just uploaded (under story-audio/<userId>/) as an asset of the given kind.
 * kind: 'voice_sample' (a clone's sample, 10 to 60 s), 'voice_track' (their own narration), 'music' (their own track) or 'audio' (either).
 * A refused file is deleted. -> the asset: { id, kind, name, url, seconds, bytes }
 */
export async function registerAudio({ userId, kind, url, name }) {
  if (!UPLOAD_KINDS.includes(kind)) throw new ValidationError('Say what the file is for: a voice sample, a voice track or music.', { field: 'kind' });
  const key = uploadKey(userId, url);
  if (!key) throw new ValidationError(VOICE_MESSAGES.upload, { field: 'url' });
  const ext = audioExtension(key);
  const bytes = await storedSize(url).catch(() => null);
  if (bytes === null) throw new ValidationError(VOICE_MESSAGES.upload, { field: 'url' });
  let info;
  try {
    if (bytes > AUDIO_LIMITS.maxBytes) throw new ValidationError(VOICE_MESSAGES.tooBig, { field: 'url' });
    const copy = await localCopy(url);
    try {
      info = await checkAudio(copy.file, { ext, bytes, kind });
    } finally {
      await copy.cleanup();
    }
  } catch (err) {
    // A refused upload is this customer's own file and is never used: remove it now (a missing one is no error).
    if (err instanceof ValidationError) await deleteUpload({ url, key }).catch((e) => log('could not delete a refused upload', key, e?.message));
    throw err;
  }
  const label = String(name || path.basename(key, `.${ext}`)).replace(/\s+/g, ' ').trim().slice(0, 120) || 'My audio';
  const [asset] = await storyDb().insert('story_assets', {
    user_id: userId, kind, name: label, url, storage_key: key, mime: MIME[ext], bytes,
    duration_seconds: info.duration, metadata: { codec: info.codec },
  });
  return assetView(asset);
}

// ---------------------------------------------------------------- the request

/** The caller's address: the first x-forwarded-for value, else the socket's (the helper lib/meta.js already has). */
export function clientIp(req) {
  return String(getClientIp(req ?? null) || '').slice(0, 64) || null;
}

// ---------------------------------------------------------------- views

function voiceView(row, sample, price) {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    error: row.status === 'failed' ? row.error || FAILED_TEXT : null,
    voiceId: row.status === 'ready' ? row.provider_voice_id : null, // what the audio plan stores
    sampleUrl: sample?.url ?? null, // the customer's own recording: free to play back
    seconds: sample?.duration_seconds ?? null,
    consent_at: row.consent_at,
    created_at: row.created_at,
    credits: price,
    retry_credits: row.status === 'failed' && sample ? price : null,
  };
}

/** -> { voices, presets, price, statement, limits }: the customer's clones (newest first) and what a new one costs. */
export async function listVoicesFor({ userId }) {
  await recoverStalledVoices(userId);
  const [rows, pricing] = await Promise.all([
    storyDb().select('story_voices', { user_id: userId }, { order: ['-created_at', '-id'] }),
    getPricing(),
  ]);
  const ids = rows.map((r) => r.sample_asset_id).filter(Boolean);
  const samples = ids.length ? await storyDb().select('story_assets', { user_id: userId, id: ids }) : [];
  const byId = new Map(samples.map((a) => [a.id, a]));
  return {
    voices: rows.map((r) => voiceView(r, byId.get(r.sample_asset_id), pricing.voiceClone)),
    presets: listVoices().map(({ id, name, gender, sampleUrl }) => ({ id, name, gender, sampleUrl })),
    price: pricing.voiceClone,
    statement: CONSENT_STATEMENT,
    limits: { sampleMinSeconds: AUDIO_LIMITS.sampleMinSeconds, sampleMaxSeconds: AUDIO_LIMITS.sampleMaxSeconds, maxBytes: AUDIO_LIMITS.maxBytes },
  };
}

// ---------------------------------------------------------------- money

/** Releases a hold; a hold already gone is fine. -> true when the hold is closed. */
async function releaseQuietly(holdId) {
  try {
    await releaseHold({ holdId });
    return true;
  } catch (err) {
    if (/hold_not_found/.test(err?.message || '')) return true;
    log('could not release a hold', holdId, err?.message);
    return false;
  }
}

const settleRef = (row) => `voice:${row.id}:${row.hold_id}:settle`;

/** Settles the hold of a ready clone (idempotent on its ref), then clears it from the row. */
async function settleOpenHold(row) {
  await settleHold({ holdId: row.hold_id, amount: row.cost_credits, reason: 'story_voice_clone', ref: settleRef(row) });
  await storyDb().update('story_voices', { id: row.id, hold_id: row.hold_id }, { hold_id: null });
}

/**
 * Closes the money of clones whose request died, and of failures that could not release at once:
 *   ready, hold open     -> settle (the customer has the voice, so it is paid for)
 *   failed, hold open    -> release
 *   pending for too long -> failed and released (the route's window is over)
 * Never throws: it runs before every list and every start.
 */
export async function recoverStalledVoices(userId, { now = Date.now() } = {}) {
  let rows;
  try {
    rows = await storyDb().select('story_voices', { user_id: userId });
  } catch (err) {
    log('could not look for stalled voices', err?.message);
    return 0;
  }
  let closed = 0;
  for (const row of rows) {
    try {
      const stale = row.status === 'pending' && now - Date.parse(row.updated_at) > STALE_PENDING_MS;
      if (stale) {
        const [failed] = await storyDb().update('story_voices', { id: row.id, user_id: userId, status: 'pending' }, { status: 'failed', error: STALE_TEXT });
        if (!failed) continue;
        row.status = 'failed';
      }
      if (!row.hold_id) continue;
      if (row.status === 'ready') {
        await settleOpenHold(row);
        closed += 1;
      } else if (row.status === 'failed' && (await releaseQuietly(row.hold_id))) {
        await storyDb().update('story_voices', { id: row.id, hold_id: row.hold_id }, { hold_id: null });
        closed += 1;
      }
    } catch (err) {
      log('could not close a stalled voice', row.id, err?.message);
    }
  }
  return closed;
}

// ---------------------------------------------------------------- cloning

function validExpected(expectedCredits) {
  if (expectedCredits !== undefined && expectedCredits !== null && (!Number.isInteger(expectedCredits) || expectedCredits < 0)) {
    throw new ValidationError('The price must be a whole number of credits.', { field: 'expected_credits' });
  }
}

/** The price the customer was shown must be the price now; a different price is 409 quote_changed and nothing is charged. */
function checkExpected(expectedCredits, credits) {
  if (expectedCredits === undefined || expectedCredits === null) return;
  if (expectedCredits !== credits) throw new ConflictError('The price changed. Check the new price and try again.', { code: 'quote_changed', credits });
}

async function ownedSample(userId, assetId) {
  const [asset] = typeof assetId === 'string' && UUID.test(assetId) ? await storyDb().select('story_assets', { id: assetId, user_id: userId }) : [];
  if (!asset || asset.kind !== 'voice_sample') throw new ValidationError(VOICE_MESSAGES.sample, { field: 'sampleAssetId' });
  const seconds = Number(asset.duration_seconds);
  if (!(seconds > 0)) throw new ValidationError(VOICE_MESSAGES.notAudio, { field: 'sampleAssetId' });
  if (seconds < AUDIO_LIMITS.sampleMinSeconds || seconds > AUDIO_LIMITS.sampleMaxSeconds) {
    throw new ValidationError(sampleLengthMessage(seconds), { field: 'sampleAssetId' });
  }
  return asset;
}

/** The clone price, or a 503 before anything is written when the configured price is not a positive whole number. */
async function clonePrice() {
  const price = (await getPricing()).voiceClone;
  if (!Number.isInteger(price) || price <= 0) {
    log('OPERATOR: pricing voiceClone is not a positive integer, cloning is refused until it is fixed', price);
    throw new StoryError('Voice cloning is not available right now. Please try again later.', { status: 503, code: 'pricing_unavailable' });
  }
  return price;
}

const isUniqueViolation = (err) => err?.code === '23505' || /duplicate key|unique constraint/i.test(err?.message || '');

function cloneFailure(err) {
  if (err instanceof ProviderError) {
    return { error: err, text: err.code === 'config' ? 'Voice cloning is not available right now. Please try again later.' : err.message || FAILED_TEXT };
  }
  console.error('[story-voices] clone failed', err?.message);
  return { error: new ProviderError('failed', undefined, { cause: err }), text: FAILED_TEXT };
}

/**
 * Holds, calls the provider, settles or releases. `row` is the claimed 'pending' row.
 * `undo` puts the row back as it was when the hold fails (a fresh row is removed, a retried one is failed again).
 */
async function runClone({ row, sample, price, undo }) {
  const holdId = randomUUID();
  try {
    await holdCredits({ userId: row.user_id, currency: 'video', amount: price, projectId: null, holdId });
    await storyDb().update('story_voices', { id: row.id, user_id: row.user_id, status: 'pending' }, { hold_id: holdId, cost_credits: price });
  } catch (err) {
    await releaseQuietly(holdId);
    await undo();
    throw err;
  }
  let result;
  try {
    result = await cloneVoice({ sampleUrl: sample.url, name: row.name });
    if (!result?.voiceId) throw new ProviderError('failed', undefined, { cause: new Error('No voice id from the provider') });
  } catch (err) {
    // A timeout or abort may mean the provider made the voice anyway: nothing is charged, but an operator should know.
    if (err?.ambiguous) log('OPERATOR clone_ambiguous: the provider call may have made a voice', row.id, err?.cause?.message || err?.message);
    const failure = cloneFailure(err);
    const released = await releaseQuietly(holdId);
    await storyDb().update('story_voices', { id: row.id, user_id: row.user_id }, { status: 'failed', error: failure.text, ...(released ? { hold_id: null } : {}) });
    throw failure.error;
  }
  // The voice exists and is paid for from here on: keep it, then settle. A settle that fails is repaired by recovery.
  const [ready] = await storyDb().update('story_voices', { id: row.id, user_id: row.user_id, status: 'pending' }, { status: 'ready', provider_voice_id: result.voiceId, error: null });
  if (!ready) {
    // The row was ended as stalled while the provider worked: the hold is released, so nothing is charged.
    log('OPERATOR: a voice was cloned after its row was ended as stalled', row.id, result.voiceId);
    throw new ConflictError('That took too long and was stopped. Try again.', { code: 'clone_stalled' });
  }
  try {
    await settleOpenHold({ ...ready, hold_id: holdId, cost_credits: price });
  } catch (err) {
    log('OPERATOR: a voice was cloned but its hold could not be settled yet', row.id, holdId, err?.message);
  }
  return ready;
}

const cleanName = (name) => String(name ?? '').replace(/\s+/g, ' ').trim();

/**
 * Clones the customer's voice from a sample they uploaded (an asset of kind voice_sample).
 * Needs consent: true. Charges voiceClone once, after the provider made the voice.
 * -> { voice, charged }. Errors: 422 (consent, name, sample), 402 plan_required / insufficient_credits,
 * 409 quote_changed / clone_busy, a provider failure (nothing charged, the row is kept as failed so it can be retried).
 */
export async function createVoice({ userId, user, name, consent, sampleAssetId, expectedCredits, ip }) {
  if (consent !== true) throw new ValidationError(VOICE_MESSAGES.consent, { field: 'consent' });
  const label = cleanName(name);
  if (label.length < 1 || label.length > 60) throw new ValidationError(VOICE_MESSAGES.name, { field: 'name' });
  validExpected(expectedCredits);
  const sample = await ownedSample(userId, sampleAssetId);
  await screenText([label]);
  await assertAllowed({ userId, action: 'voice_clone', user });
  await recoverStalledVoices(userId);
  const price = await clonePrice();
  checkExpected(expectedCredits, price);

  let row;
  try {
    // The statement stored is the server's own text, whatever the browser sent.
    [row] = await storyDb().insert('story_voices', {
      user_id: userId, name: label, provider: 'fish', sample_asset_id: sample.id, status: 'pending',
      consent_at: new Date().toISOString(), consent_ip: ip ?? null, consent_statement: CONSENT_STATEMENT,
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError(VOICE_MESSAGES.busy, { code: 'clone_busy' });
    throw err;
  }
  const done = await runClone({
    row, sample, price,
    undo: () => storyDb().remove('story_voices', { id: row.id, user_id: userId }).catch((e) => log('could not remove an unpaid voice row', row.id, e?.message)),
  });
  return { voice: voiceView(done, sample, price), charged: price };
}

/** Tries a failed clone again with the consent already on file. Holds again, never charges twice. -> { voice, charged } */
export async function retryVoice({ userId, user, id, expectedCredits }) {
  validExpected(expectedCredits);
  const [row] = UUID.test(String(id)) ? await storyDb().select('story_voices', { id, user_id: userId }) : [];
  if (!row) throw new NotFoundError('That voice could not be found.');
  await assertAllowed({ userId, action: 'voice_clone', user });
  await recoverStalledVoices(userId);
  const [fresh] = await storyDb().select('story_voices', { id, user_id: userId });
  if (!fresh || fresh.status !== 'failed') throw new ConflictError(VOICE_MESSAGES.retryNotAvailable, { code: 'retry_not_available' });
  // A hold that could not be released is still open: claiming now would overwrite its id and lose it.
  if (fresh.hold_id) throw new ConflictError('The last try is still being closed. Try again in a moment.', { code: 'clone_busy' });
  const [asset] = fresh.sample_asset_id ? await storyDb().select('story_assets', { id: fresh.sample_asset_id, user_id: userId }) : [];
  if (!asset) throw new ValidationError(VOICE_MESSAGES.sampleGone, { field: 'sampleAssetId' });
  const sample = await ownedSample(userId, asset.id);
  const price = await clonePrice();
  checkExpected(expectedCredits, price);

  let claimed;
  try {
    [claimed] = await storyDb().update('story_voices', { id, user_id: userId, status: 'failed' }, { status: 'pending', error: null, attempts: fresh.attempts + 1 });
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError(VOICE_MESSAGES.busy, { code: 'clone_busy' });
    throw err;
  }
  if (!claimed) throw new ConflictError(VOICE_MESSAGES.retryNotAvailable, { code: 'retry_not_available' });
  const done = await runClone({
    row: claimed, sample, price,
    undo: () => storyDb().update('story_voices', { id, user_id: userId }, { status: 'failed', error: fresh.error, attempts: fresh.attempts }).catch((e) => log('could not put a voice back as failed', id, e?.message)),
  });
  return { voice: voiceView(done, sample, price), charged: price };
}

/** Removes a voice from the account, with its sample recording. A voice still being cloned is not removed. */
export async function deleteVoice({ userId, id }) {
  const [row] = UUID.test(String(id)) ? await storyDb().select('story_voices', { id, user_id: userId }) : [];
  if (!row) throw new NotFoundError('That voice could not be found.');
  if (row.status === 'pending') throw new ConflictError(VOICE_MESSAGES.pendingDelete, { code: 'clone_busy' });
  if (row.hold_id) {
    // Its money is still open: close it first, so a hold is never left without a row to find it by.
    await recoverStalledVoices(userId);
    const [again] = await storyDb().select('story_voices', { id, user_id: userId });
    if (again?.hold_id) throw new ConflictError('This voice is still being settled. Try again in a moment.', { code: 'clone_busy' });
  }
  await storyDb().remove('story_voices', { id, user_id: userId, status: row.status });
  // A sample another voice still uses stays (two voices can share one recording).
  const shared = row.sample_asset_id ? await storyDb().select('story_voices', { sample_asset_id: row.sample_asset_id }, { columns: ['id'], limit: 1 }) : [];
  if (row.sample_asset_id && !shared.length) {
    const [asset] = await storyDb().select('story_assets', { id: row.sample_asset_id, user_id: userId });
    if (asset) {
      await storyDb().remove('story_assets', { id: asset.id, user_id: userId });
      await deleteUpload({ url: asset.url, key: asset.storage_key }).catch((e) => log('could not delete a voice sample', asset.id, e?.message));
    }
  }
  return { deleted: true };
}
