// Task 24: own audio and voice cloning. Mock mode only (STORY_MOCK=1): the provider clone is a spy over the mock.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { useRegexOnlyModeration, useTestAccounts } from '../helpers/storyEnv.js';
import { makeReq, makeRes } from '../helpers/apiMock.js';
import { setStoryDb, storyDb } from '../../lib/story/db.js';
import { setCreditsDb, grantCredits, getBalance, holdCredits } from '../../lib/credits.js';
import { setPricingDb, _resetPricingCache } from '../../lib/pricing.js';
import { cloneVoice, synthesize } from '../../lib/providers/tts.js';
import { downloadToFile } from '../../lib/providers/http.js';
import { mockStoragePath, putObject } from '../../lib/providers/storage.js';
import { ProviderError } from '../../lib/providers/errors.js';
import { setAudioPlan, getAudio, generateNarration, sliceUrl } from '../../lib/story/audio.js';
import {
  CONSENT_STATEMENT, clientIp, createVoice, deleteVoice, listVoicesFor, parseAudioProbe, recoverStalledVoices, registerAudio, retryVoice, uploadKey,
} from '../../lib/story/voices.js';
import { runWorkerJob } from '../../lib/story/runner.js';
import { audioInputArgs } from '../../lib/story/audioProbe.js';

// The provider calls are spied on (and can be made to fail) but still run their mock fixtures.
vi.mock('../../lib/providers/tts.js', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    synthesize: vi.fn(real.synthesize),
    cloneVoice: vi.fn(async (args) => {
      if (globalThis.__cloneFail) throw new (await import('../../lib/providers/errors.js')).ProviderError(globalThis.__cloneFail);
      if (globalThis.__cloneHook) await globalThis.__cloneHook(args);
      return real.cloneVoice(args);
    }),
  };
});
// A release that fails (the database was unreachable for a moment) must leave the hold on the row, to be closed later.
vi.mock('../../lib/credits.js', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    releaseHold: vi.fn(async (args) => { if (globalThis.__releaseFail) throw new Error('database unreachable'); return real.releaseHold(args); }),
    // A test can look at the rows at the moment a hold is taken.
    holdCredits: vi.fn(async (args) => { await globalThis.__onHold?.(args); return real.holdCredits(args); }),
  };
});
vi.mock('../../lib/providers/http.js', async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, downloadToFile: vi.fn(real.downloadToFile) };
});
// The Blob token call is replaced: it answers with the options the route asked for, and calls nobody.
vi.mock('@vercel/blob/client', () => ({
  handleUpload: async ({ body, onBeforeGenerateToken }) => {
    const options = await onBeforeGenerateToken(body.payload.pathname, body.payload.clientPayload);
    return { type: 'blob.generate-client-token', options };
  },
}));
vi.mock('../../lib/supabaseServer.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getUserFromRequest: vi.fn(async () => globalThis.__voiceSession ?? null),
}));

useRegexOnlyModeration();
const accounts = useTestAccounts();

let raw;
let dir;
const wavs = {};

beforeAll(async () => {
  raw = await createTestDb();
  setStoryDb(raw);
  setCreditsDb(raw);
  setPricingDb(raw);
  dir = mkdtempSync(path.join(os.tmpdir(), 'voices-fixture-'));
  const make = (name, seconds, extra = []) => {
    const out = path.join(dir, name);
    const r = spawnSync(ffmpegInstaller.path, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `sine=f=300:d=${seconds}`, '-ar', '22050', '-ac', '1', ...extra, out]);
    if (r.status !== 0) throw new Error(`could not make ${name}: ${r.stderr}`);
    wavs[name] = readFileSync(out);
  };
  make('nine.wav', 9);
  make('twelve.wav', 12);
  make('sixty-one.wav', 61);
  make('twelve.m4a', 12, ['-c:a', 'aac']);
  make('twelve.mp3', 12, ['-c:a', 'libmp3lame']);
}, 120_000);
afterAll(async () => {
  setStoryDb(null);
  setCreditsDb(null);
  setPricingDb(null);
  _resetPricingCache();
  rmSync(dir, { recursive: true, force: true });
  await raw?.close();
});
beforeEach(() => {
  _resetPricingCache();
  cloneVoice.mockClear();
  synthesize.mockClear();
  downloadToFile.mockClear();
});
afterEach(() => {
  globalThis.__cloneFail = null;
  globalThis.__cloneHook = null;
  globalThis.__voiceSession = null;
});

// ---------------------------------------------------------------- helpers

async function newUser({ funds = 200 } = {}) {
  const userId = randomUUID();
  if (funds) await grantCredits({ userId, currency: 'video', amount: funds, bucket: 'topup', reason: 'test', ref: randomUUID() });
  return userId;
}

/** Puts a file where the browser upload would have put it (the mock store), bypassing putObject's own checks. */
function storeRaw(userId, name, bytes) {
  const key = `story-audio/${userId}/${name}`;
  const file = mockStoragePath(key);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  return `/api/mock/storage/${key}`;
}
async function upload(userId, name, fixture) {
  return (await putObject({ key: `story-audio/${userId}/${name}`, body: wavs[fixture || name] })).url;
}
const sampleFor = async (userId, fixture = 'twelve.wav', name = `${randomUUID()}.${fixture.split('.').pop()}`) => (
  registerAudio({ userId, kind: 'voice_sample', url: await upload(userId, name, fixture), name: 'My sample' })
);
const ledger = async (userId, reason = 'story_voice_clone') => (await raw.query(`select op, delta from credit_ledger where user_id = $1 and reason = $2 order by id`, [userId, reason])).rows;
const voiceRows = (userId) => storyDb().select('story_voices', { user_id: userId });
const clone = async (userId, over = {}) => {
  const sample = over.sampleAssetId ? null : await sampleFor(userId);
  return createVoice({ userId, name: 'Maya', consent: true, sampleAssetId: sample?.id, ip: '203.0.113.9', ...over });
};
const HOUR = 3_600_000;

// ---------------------------------------------------------------- brief tests

describe('consent', () => {
  it('missing consent returns 422 and charges nothing, writes nothing, calls nothing', async () => {
    const userId = await newUser();
    const sample = await sampleFor(userId);
    const before = await getBalance(userId);
    for (const consent of [undefined, false, 'true', 1, null]) {
      await expect(createVoice({ userId, name: 'Maya', consent, sampleAssetId: sample.id })).rejects.toMatchObject({ status: 422, field: 'consent' });
    }
    expect(await getBalance(userId)).toEqual(before);
    expect(await voiceRows(userId)).toEqual([]);
    expect(await ledger(userId)).toEqual([]);
    expect(cloneVoice).not.toHaveBeenCalled();
  });

  it('stores the statement shown (the server text), the time and the address, never a statement the browser sent', async () => {
    const userId = await newUser();
    const sample = await sampleFor(userId);
    const before = Date.now();
    await createVoice({ userId, name: 'Maya', consent: true, sampleAssetId: sample.id, ip: '198.51.100.7', consentStatement: 'I agree to anything' });
    const [row] = await voiceRows(userId);
    expect(row.consent_statement).toBe(CONSENT_STATEMENT);
    expect(row.consent_ip).toBe('198.51.100.7');
    expect(Date.parse(row.consent_at)).toBeGreaterThanOrEqual(before - 1000);
    expect(Date.parse(row.consent_at)).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('the address is the first x-forwarded-for value, else the socket address', () => {
    expect(clientIp({ headers: { 'x-forwarded-for': '203.0.113.5, 10.0.0.1' }, socket: { remoteAddress: '10.9.9.9' } })).toBe('203.0.113.5');
    expect(clientIp({ headers: { 'x-forwarded-for': ' 198.51.100.2 ' } })).toBe('198.51.100.2');
    expect(clientIp({ headers: {}, socket: { remoteAddress: '192.0.2.44' } })).toBe('192.0.2.44');
    expect(clientIp({ headers: {} })).toBeNull();
  });
});

describe('the sample', () => {
  it('a 9 second sample is rejected, with the words that say why, and the file is deleted', async () => {
    const userId = await newUser();
    const url = await upload(userId, 'nine.wav');
    await expect(registerAudio({ userId, kind: 'voice_sample', url })).rejects.toMatchObject({
      status: 422, field: 'url', message: 'Your sample is 9 seconds. Record at least 10 seconds of clear speech.',
    });
    expect(await storyDb().select('story_assets', { user_id: userId })).toEqual([]);
    await expect(registerAudio({ userId, kind: 'voice_sample', url })).rejects.toMatchObject({ status: 422, message: 'We could not find that upload. Upload the file again.' });
  });

  it('a sample over 60 seconds is rejected; 12 seconds is accepted and records its length', async () => {
    const userId = await newUser();
    await expect(registerAudio({ userId, kind: 'voice_sample', url: await upload(userId, 'sixty-one.wav') })).rejects.toMatchObject({
      status: 422, message: 'Your sample is 61 seconds. Trim it to 60 seconds or less.',
    });
    const ok = await registerAudio({ userId, kind: 'voice_sample', url: await upload(userId, 'twelve.wav'), name: 'Take one' });
    expect(ok).toMatchObject({ kind: 'voice_sample', name: 'Take one' });
    expect(ok.seconds).toBeCloseTo(12, 0);
  });

  it('a clone refuses a sample whose stored length is outside 10 to 60 seconds, and one that is not a voice sample', async () => {
    const userId = await newUser();
    const [short] = await storyDb().insert('story_assets', { user_id: userId, kind: 'voice_sample', url: '/api/mock/fixtures/voice.mp3', duration_seconds: 9 });
    await expect(createVoice({ userId, name: 'Maya', consent: true, sampleAssetId: short.id })).rejects.toMatchObject({ status: 422, field: 'sampleAssetId' });
    const [track] = await storyDb().insert('story_assets', { user_id: userId, kind: 'voice_track', url: '/api/mock/fixtures/voice.mp3', duration_seconds: 30 });
    await expect(createVoice({ userId, name: 'Maya', consent: true, sampleAssetId: track.id })).rejects.toMatchObject({ status: 422, field: 'sampleAssetId' });
    await expect(createVoice({ userId, name: 'Maya', consent: true, sampleAssetId: 'nope' })).rejects.toMatchObject({ status: 422 });
    expect(await voiceRows(userId)).toEqual([]);
    expect(await ledger(userId)).toEqual([]);
  });

  it("another customer's sample is refused like one that does not exist", async () => {
    const other = await newUser();
    const mine = await newUser();
    const theirs = await sampleFor(other);
    await expect(createVoice({ userId: mine, name: 'Maya', consent: true, sampleAssetId: theirs.id })).rejects.toMatchObject({ status: 422, field: 'sampleAssetId' });
    expect(cloneVoice).not.toHaveBeenCalled();
  });
});

describe('the price', () => {
  it('a clone charges 20 once: held, then settled after the provider made the voice, and nothing is held afterwards', async () => {
    const userId = await newUser({ funds: 100 });
    const sample = await sampleFor(userId);
    let seenDuringCall = null;
    globalThis.__cloneHook = async () => { seenDuringCall = await getBalance(userId); };
    const out = await createVoice({ userId, name: 'Maya', consent: true, sampleAssetId: sample.id, expectedCredits: 20 });
    expect(out.charged).toBe(20);
    expect(seenDuringCall).toMatchObject({ held: 20, available: 80 }); // held before the provider is asked
    expect(await getBalance(userId)).toMatchObject({ held: 0, available: 80 });
    expect(await ledger(userId)).toEqual([{ op: 'settle', delta: -20 }]);
    expect(cloneVoice).toHaveBeenCalledTimes(1);
    expect(out.voice).toMatchObject({ name: 'Maya', status: 'ready', credits: 20, retry_credits: null });
    expect(out.voice.voiceId).toMatch(/^mock-voice-/);
    const [row] = await voiceRows(userId);
    expect(row).toMatchObject({ status: 'ready', provider_voice_id: out.voice.voiceId, hold_id: null });
  });

  it('the price comes from pricing_config, not from the code', async () => {
    const userId = await newUser({ funds: 100 });
    await raw.query(`insert into pricing_config (key, value) values ('voiceClone', '25'::jsonb) on conflict (key) do update set value = '25'::jsonb`);
    _resetPricingCache();
    try {
      expect((await clone(userId)).charged).toBe(25);
      expect((await getBalance(userId)).available).toBe(75);
    } finally {
      await raw.query(`delete from pricing_config where key = 'voiceClone'`);
      _resetPricingCache();
    }
  });

  it('a price that changed under the customer is 409 quote_changed: nothing held, nothing written, nothing asked', async () => {
    const userId = await newUser({ funds: 100 });
    const sample = await sampleFor(userId);
    await expect(createVoice({ userId, name: 'Maya', consent: true, sampleAssetId: sample.id, expectedCredits: 15 })).rejects.toMatchObject({ status: 409, code: 'quote_changed', extra: { credits: 20 } });
    expect(await voiceRows(userId)).toEqual([]);
    expect(await getBalance(userId)).toMatchObject({ available: 100, held: 0 });
    expect(cloneVoice).not.toHaveBeenCalled();
  });

  it('two requests at once make one clone and one charge', async () => {
    const userId = await newUser({ funds: 100 });
    const a = await sampleFor(userId);
    const b = await sampleFor(userId);
    const results = await Promise.allSettled([
      createVoice({ userId, name: 'Maya', consent: true, sampleAssetId: a.id }),
      createVoice({ userId, name: 'Maya', consent: true, sampleAssetId: b.id }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected');
    expect(lost.reason).toMatchObject({ status: 409, code: 'clone_busy' });
    expect(cloneVoice).toHaveBeenCalledTimes(1);
    expect(await getBalance(userId)).toMatchObject({ held: 0, available: 80 });
    expect(await voiceRows(userId)).toHaveLength(1);
  });

  it('not enough credits is a 402 with no row left behind and no call to the provider', async () => {
    const userId = await newUser({ funds: 10 });
    const sample = await sampleFor(userId);
    await expect(createVoice({ userId, name: 'Maya', consent: true, sampleAssetId: sample.id })).rejects.toMatchObject({ name: 'InsufficientCreditsError' });
    expect(await voiceRows(userId)).toEqual([]);
    expect(cloneVoice).not.toHaveBeenCalled();
    expect(await getBalance(userId)).toMatchObject({ available: 10, held: 0 });
  });

  it('a free account gets plan_required and nothing is held', async () => {
    accounts.set({ paid: false });
    const userId = await newUser({ funds: 100 });
    const sample = await sampleFor(userId);
    await expect(createVoice({ userId, name: 'Maya', consent: true, sampleAssetId: sample.id })).rejects.toMatchObject({ status: 402, code: 'plan_required' });
    expect(await voiceRows(userId)).toEqual([]);
    expect(await getBalance(userId)).toMatchObject({ held: 0, available: 100 });
  });

  it('a name the moderation refuses stops before anything is written', async () => {
    const userId = await newUser();
    const sample = await sampleFor(userId);
    await expect(createVoice({ userId, name: '   ', consent: true, sampleAssetId: sample.id })).rejects.toMatchObject({ status: 422, field: 'name' });
    await expect(createVoice({ userId, name: 'x'.repeat(61), consent: true, sampleAssetId: sample.id })).rejects.toMatchObject({ status: 422, field: 'name' });
    expect(await voiceRows(userId)).toEqual([]);
  });
});

describe('a clone that fails', () => {
  it('releases the hold, charges nothing, keeps the row as failed with its words, and a retry holds again and charges 20 once', async () => {
    const userId = await newUser({ funds: 100 });
    const sample = await sampleFor(userId);
    globalThis.__cloneFail = 'failed';
    await expect(createVoice({ userId, name: 'Maya', consent: true, sampleAssetId: sample.id })).rejects.toBeInstanceOf(ProviderError);
    expect(await getBalance(userId)).toMatchObject({ held: 0, available: 100 });
    expect(await ledger(userId)).toEqual([]);
    const [failed] = await voiceRows(userId);
    expect(failed).toMatchObject({ status: 'failed', provider_voice_id: null, hold_id: null, attempts: 1 });
    expect(failed.error).toBeTruthy();

    globalThis.__cloneFail = null;
    let during = null;
    globalThis.__cloneHook = async () => { during = await getBalance(userId); };
    const out = await retryVoice({ userId, id: failed.id, expectedCredits: 20 });
    expect(during).toMatchObject({ held: 20, available: 80 }); // it held again
    expect(out.voice.status).toBe('ready');
    expect(await getBalance(userId)).toMatchObject({ held: 0, available: 80 });
    expect(await ledger(userId)).toHaveLength(1);
    const [row] = await voiceRows(userId);
    expect(row).toMatchObject({ status: 'ready', attempts: 2, error: null });
    expect(row.consent_statement).toBe(CONSENT_STATEMENT); // the consent on file is kept

    await expect(retryVoice({ userId, id: failed.id })).rejects.toMatchObject({ status: 409, code: 'retry_not_available' });
    expect(await getBalance(userId)).toMatchObject({ held: 0, available: 80 });
  });

  it('a release that fails leaves the hold on the row, and the next look closes it', async () => {
    const userId = await newUser({ funds: 100 });
    globalThis.__cloneFail = 'failed';
    globalThis.__releaseFail = true;
    try {
      await clone(userId).catch(() => {});
    } finally {
      globalThis.__releaseFail = false;
    }
    const [row] = await voiceRows(userId);
    expect(row).toMatchObject({ status: 'failed' });
    expect(row.hold_id).toBeTruthy();
    expect(await getBalance(userId)).toMatchObject({ held: 20 });
    await listVoicesFor({ userId }); // every list looks for money left open
    expect((await voiceRows(userId))[0].hold_id).toBeNull();
    expect(await getBalance(userId)).toMatchObject({ held: 0, available: 100 });
  });

  it('a failed clone shows its error and the price of trying again, and its customer can clone again afterwards', async () => {
    const userId = await newUser({ funds: 100 });
    globalThis.__cloneFail = 'rate_limited';
    await expect(clone(userId)).rejects.toMatchObject({ code: 'rate_limited' });
    const view = await listVoicesFor({ userId });
    expect(view.voices).toHaveLength(1);
    expect(view.voices[0]).toMatchObject({ status: 'failed', retry_credits: 20, credits: 20 });
    expect(view.voices[0].error).toMatch(/busy/i);
    globalThis.__cloneFail = null;
    expect((await clone(userId)).voice.status).toBe('ready'); // a failed row does not block a new clone
    expect(await getBalance(userId)).toMatchObject({ held: 0, available: 80 });
  });

  it('a retry whose price changed is 409 quote_changed and the row stays failed', async () => {
    const userId = await newUser({ funds: 100 });
    globalThis.__cloneFail = 'failed';
    await clone(userId).catch(() => {});
    globalThis.__cloneFail = null;
    const [failed] = await voiceRows(userId);
    await expect(retryVoice({ userId, id: failed.id, expectedCredits: 10 })).rejects.toMatchObject({ status: 409, code: 'quote_changed' });
    expect((await voiceRows(userId))[0].status).toBe('failed');
    expect(await getBalance(userId)).toMatchObject({ held: 0, available: 100 });
  });

  it('a retry that cannot hold (not enough credits) puts the row back as failed', async () => {
    const userId = await newUser({ funds: 20 });
    globalThis.__cloneFail = 'failed';
    await clone(userId).catch(() => {});
    globalThis.__cloneFail = null;
    await holdCredits({ userId, currency: 'video', amount: 15, projectId: null });
    const [failed] = await voiceRows(userId);
    await expect(retryVoice({ userId, id: failed.id })).rejects.toMatchObject({ name: 'InsufficientCreditsError' });
    expect((await voiceRows(userId))[0]).toMatchObject({ status: 'failed', attempts: 1 });
  });

  it('final review M2: the hold id is on the voice row before the hold exists, so a request that dies between can be closed', async () => {
    const userId = await newUser({ funds: 100 });
    const seen = [];
    globalThis.__onHold = async ({ holdId }) => { seen.push({ holdId, rows: await voiceRows(userId) }); };
    try {
      await clone(userId);
    } finally {
      globalThis.__onHold = null;
    }
    expect(seen).toHaveLength(1);
    expect(seen[0].rows).toMatchObject([{ status: 'pending', hold_id: seen[0].holdId }]);
    // Had the request died right there, recovery closes the row (the hold that was never made counts as released).
    const [orphan] = await storyDb().insert('story_voices', {
      user_id: userId, name: 'Died', provider: 'fish', status: 'pending', hold_id: randomUUID(), cost_credits: 20,
      consent_at: new Date().toISOString(), consent_statement: CONSENT_STATEMENT,
    });
    await recoverStalledVoices(userId, { now: Date.now() + HOUR });
    expect((await storyDb().select('story_voices', { id: orphan.id }))[0]).toMatchObject({ status: 'failed', hold_id: null });
  });

  it("a stalled request is closed: a pending row past the window fails and its hold is released; a ready row's open hold is settled", async () => {
    const userId = await newUser({ funds: 100 });
    // pending with a hold, started long ago (the request died)
    const holdId = await holdCredits({ userId, currency: 'video', amount: 20, projectId: null });
    const [stalled] = await storyDb().insert('story_voices', {
      user_id: userId, name: 'Old', provider: 'fish', status: 'pending', hold_id: holdId, cost_credits: 20,
      consent_at: new Date().toISOString(), consent_statement: CONSENT_STATEMENT,
    });
    expect(await getBalance(userId)).toMatchObject({ held: 20 });
    expect(await recoverStalledVoices(userId, { now: Date.now() + 60_000 })).toBe(0); // inside the window: left alone
    expect((await voiceRows(userId))[0].status).toBe('pending');
    expect(await recoverStalledVoices(userId, { now: Date.now() + HOUR })).toBe(1);
    expect(await voiceRows(userId)).toMatchObject([{ id: stalled.id, status: 'failed', hold_id: null }]);
    expect(await getBalance(userId)).toMatchObject({ held: 0, available: 100 });

    // ready, but the settle did not happen
    const hold2 = await holdCredits({ userId, currency: 'video', amount: 20, projectId: null });
    const [paid] = await storyDb().insert('story_voices', {
      user_id: userId, name: 'Done', provider: 'fish', provider_voice_id: 'v-1', status: 'ready', hold_id: hold2, cost_credits: 20,
      consent_at: new Date().toISOString(), consent_statement: CONSENT_STATEMENT,
    });
    expect(await recoverStalledVoices(userId)).toBe(1);
    expect(await recoverStalledVoices(userId)).toBe(0); // and only once
    expect((await storyDb().select('story_voices', { id: paid.id }))[0].hold_id).toBeNull();
    expect(await getBalance(userId)).toMatchObject({ held: 0, available: 80 });
    expect(await ledger(userId)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- privacy

describe('clones are private', () => {
  it('lists only the caller\'s voices, and nobody else can retry or delete them', async () => {
    const maya = await newUser();
    const leo = await newUser();
    const mine = (await clone(maya)).voice;
    await clone(leo);
    expect((await listVoicesFor({ userId: maya })).voices.map((v) => v.id)).toEqual([mine.id]);
    await expect(deleteVoice({ userId: leo, id: mine.id })).rejects.toMatchObject({ status: 404 });
    await expect(retryVoice({ userId: leo, id: mine.id })).rejects.toMatchObject({ status: 404 });
    expect(await voiceRows(maya)).toHaveLength(1);
  });

  async function projectFor(userId) {
    const [project] = await storyDb().insert('story_projects', { user_id: userId, title: 'T', style: '3d_family', step: 'audio', seconds: 30, quality: 'standard', mode: 'narrated' });
    await storyDb().insert('story_scripts', { project_id: project.id, version: 1, source: 'brief', scenes: [{ id: 's1', title: 'A', visual: 'v', lines: [{ speaker: 'narrator', text: 'Hello there.' }] }] });
    return project;
  }
  const planRoute = async (userId, projectId, plan) => {
    const { handleAction } = await import('../../lib/story/actionRoute.js');
    globalThis.__voiceSession = { user: { id: userId, email: 'test@example.test' } };
    const res = makeRes();
    await handleAction(makeReq({ method: 'POST', body: { plan }, query: { id: projectId } }), res, 'audio');
    return res;
  };

  it("another customer's voice id in an audio plan returns 404, and the plan is not changed", async () => {
    const maya = await newUser();
    const leo = await newUser();
    const theirs = (await clone(leo)).voice;
    const project = await projectFor(maya);
    const res = await planRoute(maya, project.id, { voiceId: theirs.voiceId });
    expect(res.statusCode).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain(theirs.voiceId);
    expect((await storyDb().select('story_projects', { id: project.id }))[0].audio_plan).toEqual({});
    // Their voice's row id is no different, and neither is any other id nobody owns.
    expect((await planRoute(maya, project.id, { voiceId: theirs.id })).statusCode).toBe(404);
    expect((await planRoute(maya, project.id, { voiceId: 'not-a-voice' })).statusCode).toBe(404);
    // The service answers the same way.
    await expect(setAudioPlan({ userId: maya, projectId: project.id, plan: { voiceId: theirs.voiceId } })).rejects.toMatchObject({ status: 404 });
  });

  it('their own clone is a voice they can pick, and the narration uses it', async () => {
    const maya = await newUser();
    const mine = (await clone(maya)).voice;
    const project = await projectFor(maya);
    const res = await planRoute(maya, project.id, { voiceId: mine.voiceId });
    expect(res.statusCode).toBe(200);
    expect(res.body.audio.plan.voiceId).toBe(mine.voiceId);
    const own = res.body.audio.voices.find((v) => v.id === mine.voiceId);
    expect(own).toMatchObject({ own: true, name: 'Maya' });
    expect(own.sampleUrl).toMatch(/^\/api\/mock\/storage\/story-audio\//); // their own recording plays back as the preview
    await generateNarration({ userId: maya, projectId: project.id });
    for (let i = 0; i < 3; i += 1) if ((await runWorkerJob('narration', {})).claimed) break;
    expect(synthesize).toHaveBeenCalledWith(expect.objectContaining({ voiceId: mine.voiceId }));
  });

  it('a clone that is not ready yet is a 422 (it is theirs, but not usable), not a 404', async () => {
    const maya = await newUser();
    globalThis.__cloneFail = 'failed';
    await clone(maya).catch(() => {});
    const [failed] = await voiceRows(maya);
    const project = await projectFor(maya);
    await expect(setAudioPlan({ userId: maya, projectId: project.id, plan: { voiceId: failed.id } })).rejects.toMatchObject({ status: 422, field: 'voiceId' });
  });

  it('deleting a voice removes it, its sample and its place in the voice list, and refuses one still being cloned', async () => {
    const maya = await newUser();
    const { voice } = await clone(maya);
    const [asset] = await storyDb().select('story_assets', { user_id: maya, kind: 'voice_sample' });
    expect(await deleteVoice({ userId: maya, id: voice.id })).toEqual({ deleted: true });
    expect(await voiceRows(maya)).toEqual([]);
    expect(await storyDb().select('story_assets', { id: asset.id })).toEqual([]);
    expect(() => readFileSync(mockStoragePath(asset.storage_key))).toThrow();
    const project = await projectFor(maya);
    await expect(setAudioPlan({ userId: maya, projectId: project.id, plan: { voiceId: voice.voiceId } })).rejects.toMatchObject({ status: 404 });
    const hold = await holdCredits({ userId: maya, currency: 'video', amount: 5, projectId: null });
    const [pending] = await storyDb().insert('story_voices', { user_id: maya, name: 'Busy', provider: 'fish', status: 'pending', hold_id: hold, cost_credits: 5, consent_at: new Date().toISOString(), consent_statement: CONSENT_STATEMENT });
    await expect(deleteVoice({ userId: maya, id: pending.id })).rejects.toMatchObject({ status: 409, code: 'clone_busy' });
  });
});

// ---------------------------------------------------------------- uploads

describe('audio uploads', () => {
  it('takes mp3, wav and m4a and records their length and codec', async () => {
    const userId = await newUser();
    for (const [name, codec] of [['twelve.wav', /^pcm_/], ['twelve.m4a', /^aac$/], ['twelve.mp3', /^mp3$/]]) {
      const asset = await registerAudio({ userId, kind: 'music', url: await upload(userId, `${randomUUID()}-${name}`, name) });
      expect(asset.seconds).toBeGreaterThan(11);
      const [row] = await storyDb().select('story_assets', { id: asset.id });
      expect(row.metadata.codec).toMatch(codec);
      expect(row).toMatchObject({ kind: 'music', user_id: userId });
      expect(row.bytes).toBeGreaterThan(1000);
    }
  });

  it('a voice track and music have no length limit beyond the size', async () => {
    const userId = await newUser();
    const asset = await registerAudio({ userId, kind: 'voice_track', url: await upload(userId, 'nine.wav') });
    expect(asset.seconds).toBeCloseTo(9, 0);
  });

  it('refuses a file over 20 MB, with its own message, and deletes it', async () => {
    const userId = await newUser();
    const url = storeRaw(userId, 'big.wav', Buffer.alloc(21 * 1024 * 1024));
    await expect(registerAudio({ userId, kind: 'music', url })).rejects.toMatchObject({ status: 422, message: 'This file is larger than 20 MB. Trim or compress it and try again.' });
    expect(() => readFileSync(mockStoragePath(`story-audio/${userId}/big.wav`))).toThrow();
  });

  it('refuses a file that is not what its name says: text named .mp3, a video named .m4a, a wav named .mp3', async () => {
    const userId = await newUser();
    const text = storeRaw(userId, 'notes.mp3', Buffer.from('this is not audio at all, just words'));
    await expect(registerAudio({ userId, kind: 'music', url: text })).rejects.toMatchObject({ status: 422, message: 'We could not read that file as audio. Upload an MP3, WAV or M4A file.' });
    const video = storeRaw(userId, 'movie.m4a', readFileSync(path.join(process.cwd(), 'tests/fixtures/clip.mp4')));
    await expect(registerAudio({ userId, kind: 'music', url: video })).rejects.toMatchObject({ status: 422, field: 'url' });
    const mislabelled = storeRaw(userId, 'wrong.mp3', wavs['twelve.wav']);
    await expect(registerAudio({ userId, kind: 'music', url: mislabelled })).rejects.toMatchObject({ status: 422 });
    expect(await storyDb().select('story_assets', { user_id: userId })).toEqual([]);
  });

  it("refuses another customer's upload, a file outside the audio folder, another type and an unknown kind", async () => {
    const maya = await newUser();
    const leo = await newUser();
    const theirs = await upload(leo, 'twelve.wav');
    await expect(registerAudio({ userId: maya, kind: 'music', url: theirs })).rejects.toMatchObject({ status: 422, message: 'We could not find that upload. Upload the file again.' });
    expect(() => readFileSync(mockStoragePath(`story-audio/${leo}/twelve.wav`))).not.toThrow(); // theirs is untouched
    const elsewhere = (await putObject({ key: `story/${maya}/twelve.wav`, body: wavs['twelve.wav'] })).url;
    await expect(registerAudio({ userId: maya, kind: 'music', url: elsewhere })).rejects.toMatchObject({ status: 422 });
    const ogg = storeRaw(maya, 'a.ogg', Buffer.from('OggS'));
    await expect(registerAudio({ userId: maya, kind: 'music', url: ogg })).rejects.toMatchObject({ status: 422 });
    await expect(registerAudio({ userId: maya, kind: 'logo', url: await upload(maya, 'twelve.wav') })).rejects.toMatchObject({ status: 422, field: 'kind' });
    await expect(registerAudio({ userId: maya, kind: 'music', url: 'https://evil.example/x.mp3' })).rejects.toMatchObject({ status: 422 });
  });

  it('an uploaded recording and track are usable in the audio plan, and show their name', async () => {
    const userId = await newUser();
    const [project] = await storyDb().insert('story_projects', { user_id: userId, title: 'T', style: '3d_family', step: 'audio', seconds: 30, quality: 'standard', mode: 'narrated' });
    const track = await registerAudio({ userId, kind: 'voice_track', url: await upload(userId, 'twelve.wav'), name: 'My narration' });
    const music = await registerAudio({ userId, kind: 'music', url: await upload(userId, 'twelve.mp3'), name: 'My song' });
    await setAudioPlan({ userId, projectId: project.id, plan: { voiceTrackAssetId: track.id, music: { type: 'upload', assetId: music.id } } });
    const audio = await getAudio({ userId, projectId: project.id });
    expect(audio.uploads).toMatchObject({ voiceTrack: { id: track.id, name: 'My narration' }, music: { id: music.id, name: 'My song' } });
    expect(audio.music.url).toBe(music.url);
  });
});

describe('parseAudioProbe', () => {
  it('reads the length and codec, and does not count cover art as a video', () => {
    const mp3 = `Input #0, mp3, from 'a.mp3':\n  Duration: 00:00:12.04, start: 0.025057, bitrate: 128 kb/s\n  Stream #0:0: Audio: mp3, 44100 Hz, stereo, fltp, 128 kb/s\n  Stream #0:1: Video: mjpeg (Baseline), yuvj420p, 500x500 [SAR 1:1 DAR 1:1], 90k tbr (attached pic)`;
    expect(parseAudioProbe(mp3)).toEqual({ duration: 12.04, codec: 'mp3', hasVideo: false });
    const mp4 = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'a.mp4':\n  Duration: 00:00:05.00, start: 0.0\n  Stream #0:0[0x1](und): Video: h264 (High), yuv420p, 1280x720\n  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo`;
    expect(parseAudioProbe(mp4)).toEqual({ duration: 5, codec: 'aac', hasVideo: true });
    expect(parseAudioProbe('garbage')).toEqual({ duration: null, codec: null, hasVideo: false });
  });
});

describe('the upload token route', () => {
  const token = async (session, pathname, surface = 'story-audio') => {
    const { default: route } = await import('../../pages/api/upload-token.js');
    globalThis.__voiceSession = session;
    const res = makeRes();
    await route(makeReq({ method: 'POST', body: { type: 'blob.generate-client-token', payload: { pathname, clientPayload: JSON.stringify({ surface }) } } }), res);
    return res;
  };

  it('gives audio uploads mp3, wav and m4a only, 20 MB, in the caller\'s own folder', async () => {
    const userId = randomUUID();
    const ok = await token({ user: { id: userId } }, `story-audio/${userId}/take one.m4a`);
    expect(ok.statusCode).toBe(200);
    expect(ok.body.options.maximumSizeInBytes).toBe(20 * 1024 * 1024);
    expect(ok.body.options.allowedContentTypes).toEqual(expect.arrayContaining(['audio/mpeg', 'audio/wav', 'audio/mp4']));
    expect(ok.body.options.allowedContentTypes.some((t) => /video|image|html/.test(t))).toBe(false);
    for (const bad of [`story-audio/${randomUUID()}/a.wav`, `story-audio/${userId}/a.ogg`, `story-audio/${userId}/sub/a.wav`, `story-audio/${userId}/../x.wav`, `elsewhere/${userId}/a.wav`]) {
      expect((await token({ user: { id: userId } }, bad)).statusCode).toBe(400);
    }
    expect((await token(null, `story-audio/${userId}/a.wav`)).statusCode).toBe(401);
  });

  it('the plain signed-in upload surface cannot write into story-audio/', async () => {
    const userId = randomUUID();
    expect((await token({ user: { id: userId } }, `story-audio/${userId}/a.wav`, 'plain')).statusCode).toBe(400);
    expect((await token({ user: { id: userId } }, 'uploads/a.mp4', 'plain')).statusCode).toBe(200);
  });
});

describe('which stored files count as an upload', () => {
  it('real mode: only our own Blob store, only the customer\'s own folder, only audio names', () => {
    vi.stubEnv('BLOB_READ_WRITE_TOKEN', 'vercel_blob_rw_AbC123xyz_secretpart');
    const u = randomUUID();
    const ours = (p) => `https://abc123xyz.public.blob.vercel-storage.com/${p}`;
    expect(uploadKey(u, ours(`story-audio/${u}/a-1.mp3`), { mock: false })).toBe(`story-audio/${u}/a-1.mp3`);
    expect(uploadKey(u, `https://someoneelse.public.blob.vercel-storage.com/story-audio/${u}/a-1.mp3`, { mock: false })).toBeNull();
    expect(uploadKey(u, ours(`story-audio/${randomUUID()}/a-1.mp3`), { mock: false })).toBeNull();
    expect(uploadKey(u, ours(`story-audio/${u}/a-1.png`), { mock: false })).toBeNull();
    expect(uploadKey(u, ours(`story-audio/${u}/x/a-1.mp3`), { mock: false })).toBeNull();
    expect(uploadKey(u, `http://abc123xyz.public.blob.vercel-storage.com/story-audio/${u}/a-1.mp3`, { mock: false })).toBeNull();
    vi.stubEnv('BLOB_READ_WRITE_TOKEN', '');
    expect(uploadKey(u, ours(`story-audio/${u}/a-1.mp3`), { mock: false })).toBeNull();
    vi.unstubAllEnvs();
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('STORY_MOCK', '1');
  });
});

// ---------------------------------------------------------------- the carry from Task 19

describe('downloads fit inside the worker window', () => {
  it("the customer's own recording is downloaded for at most 120 s and 20 MB, and a download that fails says why", async () => {
    downloadToFile.mockRejectedValueOnce(new ProviderError('failed', 'That download took too long.'));
    await expect(sliceUrl({ url: 'https://abc.public.blob.vercel-storage.com/story-audio/u/a.mp3', ext: 'mp3', lines: [{ sceneId: 's1', lineIndex: 0, text: 'Hi.' }] })).rejects.toMatchObject({ code: 'failed' });
    const opts = downloadToFile.mock.calls[0][1];
    expect(opts.timeoutMs).toBeGreaterThan(0);
    expect(opts.timeoutMs).toBeLessThanOrEqual(120_000);
    expect(opts.maxBytes).toBe(20 * 1024 * 1024);
  });

  it('the sample download for a clone is capped too, so the download and the provider call fit inside 300 s', async () => {
    vi.stubEnv('STORY_MOCK', '');
    vi.stubEnv('FISH_API_KEY', 'test-key');
    try {
      const real = await vi.importActual('../../lib/providers/tts.js');
      downloadToFile.mockRejectedValueOnce(new ProviderError('failed', 'That download took too long.'));
      await expect(real.cloneVoice({ sampleUrl: 'https://abc.public.blob.vercel-storage.com/story-audio/u/a.mp3', name: 'Maya' })).rejects.toMatchObject({ code: 'failed' });
      const opts = downloadToFile.mock.calls[0][1];
      expect(opts.timeoutMs).toBeGreaterThan(0);
      expect(opts.timeoutMs).toBeLessThanOrEqual(120_000);
    } finally {
      vi.unstubAllEnvs();
      vi.stubEnv('ANTHROPIC_API_KEY', '');
      vi.stubEnv('STORY_MOCK', '1');
    }
  });
});

// ---------------------------------------------------------------- HTTP

describe('/api/story/voices and /api/story/assets', () => {
  const call = async (handler, { method = 'GET', body = {}, query = {}, headers = {}, userId } = {}) => {
    globalThis.__voiceSession = userId ? { user: { id: userId, email: 'test@example.test' } } : null;
    const res = makeRes();
    await handler(makeReq({ method, body, query, headers }), res);
    return res;
  };

  it('401 without a session, 405 for other methods', async () => {
    const { default: voices } = await import('../../pages/api/story/voices.js');
    const { default: assets } = await import('../../pages/api/story/assets.js');
    expect((await call(voices)).statusCode).toBe(401);
    expect((await call(assets, { method: 'POST' })).statusCode).toBe(401);
    const userId = await newUser();
    expect((await call(voices, { method: 'PUT', userId })).statusCode).toBe(405);
    expect((await call(assets, { method: 'PUT', userId })).statusCode).toBe(405); // DELETE is the asset delete (Task 23)
  });

  it('GET lists the clones with the consent statement, the price and the limits; POST clones and returns 201', async () => {
    const { default: voices } = await import('../../pages/api/story/voices.js');
    const { default: assets } = await import('../../pages/api/story/assets.js');
    const userId = await newUser({ funds: 100 });
    const empty = await call(voices, { userId });
    expect(empty.statusCode).toBe(200);
    expect(empty.body).toMatchObject({ voices: [], price: 20, statement: CONSENT_STATEMENT, limits: { sampleMinSeconds: 10, sampleMaxSeconds: 60 } });
    expect(empty.body.presets.length).toBeGreaterThan(0);

    const reg = await call(assets, { method: 'POST', userId, body: { kind: 'voice_sample', url: await upload(userId, 'route.wav', 'twelve.wav'), name: 'Take' } });
    expect(reg.statusCode).toBe(201);
    expect(reg.body.asset).toMatchObject({ kind: 'voice_sample', name: 'Take' });

    const noConsent = await call(voices, { method: 'POST', userId, body: { name: 'Maya', sampleAssetId: reg.body.asset.id } });
    expect(noConsent.statusCode).toBe(422);
    expect(noConsent.body).toMatchObject({ error: 'validation_failed', field: 'consent' });
    const ok = await call(voices, {
      method: 'POST', userId,
      headers: { 'x-forwarded-for': '203.0.113.77, 10.0.0.2' },
      body: { name: 'Maya', consent: true, sampleAssetId: reg.body.asset.id, expected_credits: 20, consent_statement: 'ignored' },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.body).toMatchObject({ charged: 20, voice: { status: 'ready', name: 'Maya' } });
    expect((await voiceRows(userId))[0]).toMatchObject({ consent_ip: '203.0.113.77', consent_statement: CONSENT_STATEMENT });
    expect((await call(voices, { userId })).body.voices).toHaveLength(1);
  });

  it('POST with retry, and DELETE, work on the caller\'s own voices only', async () => {
    const { default: voices } = await import('../../pages/api/story/voices.js');
    const maya = await newUser({ funds: 100 });
    const leo = await newUser({ funds: 100 });
    globalThis.__cloneFail = 'failed';
    await clone(maya).catch(() => {});
    globalThis.__cloneFail = null;
    const [failed] = await voiceRows(maya);
    expect((await call(voices, { method: 'POST', userId: leo, body: { retry: failed.id } })).statusCode).toBe(404);
    const retried = await call(voices, { method: 'POST', userId: maya, body: { retry: failed.id, expected_credits: 20 } });
    expect(retried.statusCode).toBe(201);
    expect(retried.body.voice.status).toBe('ready');
    expect((await call(voices, { method: 'DELETE', userId: leo, query: { id: failed.id } })).statusCode).toBe(404);
    const gone = await call(voices, { method: 'DELETE', userId: maya, query: { id: failed.id } });
    expect(gone.statusCode).toBe(200);
    expect(await voiceRows(maya)).toEqual([]);
  });

  it('a provider failure answers with its own safe message and the row can then be retried', async () => {
    const { default: voices } = await import('../../pages/api/story/voices.js');
    const userId = await newUser({ funds: 100 });
    const sample = await sampleFor(userId);
    globalThis.__cloneFail = 'failed';
    const res = await call(voices, { method: 'POST', userId, body: { name: 'Maya', consent: true, sampleAssetId: sample.id } });
    expect(res.statusCode).toBe(502);
    expect(res.body.error).toBe('provider_failed');
    expect((await voiceRows(userId))[0].status).toBe('failed');
  });
});

// ---------------------------------------------------------------- round 1

describe('round 1', () => {
  it('I1: an ID3 header in front of an HLS playlist is refused, and the demuxer is forced from the extension', async () => {
    const userId = await newUser();
    // The segment is a real 12 s mp3, so without the forced demuxer ffmpeg reports codec mp3 and 12 s, and the file would pass.
    const wavFile = path.join(dir, 'segment.mp3');
    writeFileSync(wavFile, wavs['twelve.mp3']);
    const playlist = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:30\n#EXTINF:30,\nfile://${wavFile}\n#EXT-X-ENDLIST\n`;
    const crafted = Buffer.concat([Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00'), Buffer.from(playlist)]);
    const url = storeRaw(userId, 'sneaky.mp3', crafted);
    await expect(registerAudio({ userId, kind: 'voice_sample', url })).rejects.toMatchObject({
      status: 422, message: 'We could not read that file as audio. Upload an MP3, WAV or M4A file.',
    });
    expect(await storyDb().select('story_assets', { user_id: userId })).toEqual([]);
    expect(audioInputArgs('mp3')).toEqual(['-protocol_whitelist', 'file', '-f', 'mp3']);
    expect(audioInputArgs('wav')).toEqual(['-protocol_whitelist', 'file', '-f', 'wav']);
    expect(audioInputArgs('m4a')).toEqual(['-protocol_whitelist', 'file', '-f', 'mov']);
    expect(() => audioInputArgs('mp4')).toThrow();
  });

  it('M1: a retry whose last release never happened is refused, and no second hold is placed', async () => {
    const userId = await newUser({ funds: 100 });
    globalThis.__cloneFail = 'failed';
    globalThis.__releaseFail = true;
    try {
      await clone(userId).catch(() => {});
      await listVoicesFor({ userId }); // the second release fails too
      const [row] = await voiceRows(userId);
      expect(row.hold_id).toBeTruthy();
      globalThis.__cloneFail = null;
      await expect(retryVoice({ userId, id: row.id })).rejects.toMatchObject({ status: 409, code: 'clone_busy' });
      expect((await voiceRows(userId))[0]).toMatchObject({ status: 'failed', hold_id: row.hold_id });
      expect(await getBalance(userId)).toMatchObject({ held: 20 });
    } finally {
      globalThis.__releaseFail = false;
    }
    expect(cloneVoice).toHaveBeenCalledTimes(1);
  });

  it('M2: a timed-out provider call is logged for an operator, and the customer sees the same failure', async () => {
    const userId = await newUser({ funds: 100 });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    globalThis.__cloneHook = async () => { throw new ProviderError('failed', undefined, { cause: Object.assign(new Error('timed out'), { name: 'TimeoutError' }) }); };
    try {
      await expect(clone(userId)).rejects.toBeInstanceOf(ProviderError);
      expect(spy.mock.calls.some((c) => c.join(' ').includes('OPERATOR clone_ambiguous'))).toBe(true);
    } finally {
      spy.mockRestore();
    }
    expect(await getBalance(userId)).toMatchObject({ held: 0, available: 100 });
    expect((await voiceRows(userId))[0].status).toBe('failed');
  });

  it('M3: voices.js and the assets route do not import analyze.js', () => {
    for (const f of ['lib/story/voices.js', 'pages/api/story/assets.js', 'pages/api/story/voices.js']) {
      expect(readFileSync(path.join(process.cwd(), f), 'utf8')).not.toMatch(/analyze\.js/);
    }
  });

  it('M5: deleting one voice keeps a sample another voice still uses', async () => {
    const userId = await newUser({ funds: 100 });
    const { voice } = await clone(userId);
    const [first] = await voiceRows(userId);
    const [twin] = await storyDb().insert('story_voices', {
      user_id: userId, name: 'Twin', provider: 'fish', provider_voice_id: 'twin-1', status: 'ready', sample_asset_id: first.sample_asset_id,
      consent_at: new Date().toISOString(), consent_statement: CONSENT_STATEMENT,
    });
    const [asset] = await storyDb().select('story_assets', { id: first.sample_asset_id });
    await deleteVoice({ userId, id: voice.id });
    expect(await storyDb().select('story_assets', { id: asset.id })).toHaveLength(1);
    expect(() => readFileSync(mockStoragePath(asset.storage_key))).not.toThrow();
    await deleteVoice({ userId, id: twin.id });
    expect(await storyDb().select('story_assets', { id: asset.id })).toEqual([]);
    expect(() => readFileSync(mockStoragePath(asset.storage_key))).toThrow();
  });

  it('M7: a clone price that is not a positive whole number is a 503 before anything is written', async () => {
    const userId = await newUser({ funds: 100 });
    const sample = await sampleFor(userId);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const bad of ['0', '12.5']) {
        await raw.query(`insert into pricing_config (key, value) values ('voiceClone', '${bad}'::jsonb) on conflict (key) do update set value = '${bad}'::jsonb`);
        _resetPricingCache();
        await expect(createVoice({ userId, name: 'Maya', consent: true, sampleAssetId: sample.id })).rejects.toMatchObject({ status: 503, code: 'pricing_unavailable' });
      }
      expect(spy.mock.calls.some((c) => c.join(' ').includes('OPERATOR'))).toBe(true);
    } finally {
      spy.mockRestore();
      await raw.query(`delete from pricing_config where key = 'voiceClone'`);
      _resetPricingCache();
    }
    expect(await voiceRows(userId)).toEqual([]);
    expect(await getBalance(userId)).toMatchObject({ available: 100, held: 0 });
    expect(cloneVoice).not.toHaveBeenCalled();
  });
});
