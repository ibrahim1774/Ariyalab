// uses tests/helpers/storyEnv.js useRegexOnlyModeration() and useTestAccounts()
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { useRegexOnlyModeration, useTestAccounts } from '../helpers/storyEnv.js';
import { makeReq, makeRes } from '../helpers/apiMock.js';
import { setStoryDb, storyDb } from '../../lib/story/db.js';
import { setCreditsDb, grantCredits, getBalance, holdCredits, InsufficientCreditsError } from '../../lib/credits.js';
import { setPricingDb, _resetPricingCache } from '../../lib/pricing.js';
import { ModerationError } from '../../lib/moderation.js';
import { ProviderError } from '../../lib/providers/errors.js';
import { synthesize } from '../../lib/providers/tts.js';
import { generateMusic as providerMusic } from '../../lib/providers/music.js';
import { tick, runWorkerJob, runCron, _handlerCallScope } from '../../lib/story/runner.js';
import { KINDS_REGISTERED_LATER } from '../../lib/story/handlers.js';
import {
  MUSIC_SUFFIX, FREE_RETRIES, STALE_CLAIM_MS, narratorLines, narrationText, sliceNarration, defaultPlan,
  setAudioPlan, getAudio, generateNarration, generateMusic, audioAttemptCost, recoverStalledAudio, _setAudioDeps,
} from '../../lib/story/audio.js';
import { narrationHandler, musicHandler } from '../../lib/story/audioJobs.js';

// The provider calls are spied on (and can be made to fail) but still run their mock fixtures.
vi.mock('../../lib/providers/tts.js', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    synthesize: vi.fn(async (args) => {
      if (globalThis.__audioFail) throw new (await import('../../lib/providers/errors.js')).ProviderError(globalThis.__audioFail);
      return real.synthesize(args);
    }),
  };
});
vi.mock('../../lib/providers/music.js', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    generateMusic: vi.fn(async (args) => {
      if (globalThis.__audioFail) throw new (await import('../../lib/providers/errors.js')).ProviderError(globalThis.__audioFail);
      return real.generateMusic(args);
    }),
  };
});
vi.mock('../../lib/supabaseServer.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getUserFromRequest: vi.fn(async () => globalThis.__audioTestSession ?? null),
}));

useRegexOnlyModeration();
const accounts = useTestAccounts();

let raw;
let fixtureDir;
const FIXTURE = () => path.join(fixtureDir, 'three-lines.wav');

beforeAll(async () => {
  raw = await createTestDb();
  setStoryDb(raw);
  setCreditsDb(raw);
  setPricingDb(raw);
  // Three tones with known silences: tone 0-1.0 s, silence 1.0-1.6, tone 1.6-3.1, silence 3.1-3.7, tone 3.7-4.5.
  fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'audio-fixture-'));
  const tone = (f, d, label) => `sine=f=${f}:d=${d},aformat=sample_rates=44100:channel_layouts=mono[${label}]`;
  const gap = (label) => `anullsrc=r=44100:cl=mono,atrim=0:0.6[${label}]`;
  const r = spawnSync(ffmpegInstaller.path, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-filter_complex', [tone(440, 1.0, 'a'), gap('s1'), tone(550, 1.5, 'b'), gap('s2'), tone(660, 0.8, 'c'), '[a][s1][b][s2][c]concat=n=5:v=0:a=1[out]'].join(';'),
    '-map', '[out]', FIXTURE(),
  ]);
  if (r.status !== 0) throw new Error(`could not make the audio fixture: ${r.stderr}`);
}, 60_000);
afterAll(async () => {
  setStoryDb(null);
  setCreditsDb(null);
  setPricingDb(null);
  _resetPricingCache();
  rmSync(fixtureDir, { recursive: true, force: true });
  await raw?.close();
});
beforeEach(async () => {
  _resetPricingCache();
  // runWorkerJob claims from any project: jobs left over from an earlier test must not run in this one.
  await raw.query(`update story_jobs set status = 'failed', applied_at = now() where kind in ('narration', 'music') and status in ('queued', 'running')`);
  synthesize.mockClear();
  providerMusic.mockClear();
});
afterEach(async () => {
  _setAudioDeps();
  globalThis.__audioFail = null;
  globalThis.__audioTestSession = null;
  await raw.query(`delete from pricing_config where key in ('narrationRegen', 'musicRegen')`).catch(() => {});
});

// ---------------------------------------------------------------- fixtures

const SCENES = [
  {
    id: 's1', title: 'The shop', visual: 'Maya sweeps the small barbershop at night.',
    lines: [{ speaker: 'narrator', text: 'Nobody believed this would work' }, { speaker: 'Maya', text: 'Watch me.' }, { speaker: 'narrator', text: 'Maya kept sweeping anyway.' }],
  },
  {
    id: 's2', title: 'The visit', visual: 'Leo walks in with two coffees.',
    lines: [{ speaker: 'narrator', text: 'Then Leo walked in with coffee!' }, { speaker: 'narrator', text: 'He sat down and stayed.' }],
  },
];

async function newProject({ scenes = SCENES, funds = 1000, mode = 'narrated', style = '3d_family' } = {}) {
  const userId = randomUUID();
  const quality = mode === 'talking' ? 'pro_talking' : 'standard';
  const [project] = await storyDb().insert('story_projects', { user_id: userId, title: 'Audio test', style, step: 'storyboard', seconds: 30, quality, mode });
  if (scenes) await storyDb().insert('story_scripts', { project_id: project.id, version: 1, scenes, source: 'brief' });
  if (funds) await grantCredits({ userId, currency: 'video', amount: funds, bucket: 'topup', reason: 'test', ref: randomUUID() });
  return { userId, project };
}

const reload = async (id) => (await storyDb().select('story_projects', { id }))[0];
const jobs = (projectId, kind) => storyDb().select('story_jobs', { project_id: projectId, kind }, { order: ['created_at', 'id'] });
const balance = (userId) => getBalance(userId);

const T0 = Date.parse('2026-11-14T12:00:00.000Z');
let clock = T0;
/** Runs the project's jobs to the end with the mock providers (a failing first run is retried once by the runner). */
async function finishJobs(projectId) {
  clock += 3_600_000;
  for (let i = 0; i < 6; i += 1) await tick({ projectId, now: new Date(clock + i * 20_000) });
  // Narration and music are worker kinds: tick never runs them, their worker route does.
  for (const kind of ['narration', 'music']) {
    for (let i = 0; i < 8; i += 1) if (!(await runWorkerJob(kind, { now: new Date(clock) })).claimed) break;
  }
}

const audioOf = (ctx) => getAudio({ userId: ctx.userId, projectId: ctx.project.id });
const start = async (ctx, kind, opts = {}) => {
  const fn = kind === 'narration' ? generateNarration : generateMusic;
  return fn({ userId: ctx.userId, projectId: ctx.project.id, ...opts });
};

async function addAsset(userId, { kind = 'voice_track', url = '/api/mock/fixtures/voice.mp3', mime = 'audio/mpeg' } = {}) {
  // mime is what lib/story/voices.js registerAudio stores after checking the file (Task 20 T24b reads it).
  const [asset] = await storyDb().insert('story_assets', { user_id: userId, kind, url, storage_key: `uploads/${randomUUID()}.mp3`, name: 'mine', mime });
  return asset;
}

// ---------------------------------------------------------------- slicer

describe('sliceNarration', () => {
  const lines = (...texts) => texts.map((text, i) => ({ sceneId: 's1', lineIndex: i, text }));

  it('returns one segment per line, cut at the silences, on the fixture with known silences', async () => {
    const out = await sliceNarration({ ext: 'wav', filePath: FIXTURE(), lines: lines('First line here.', 'A second, longer line is here.', 'Third.') });
    expect(out.method).toBe('silence');
    expect(out.segments).toHaveLength(3);
    expect(out.duration).toBeCloseTo(4.5, 1);
    const [a, b, c] = out.segments;
    expect([a.start, a.end]).toEqual([expect.closeTo(0, 1), expect.closeTo(1.0, 1)]);
    expect([b.start, b.end]).toEqual([expect.closeTo(1.6, 1), expect.closeTo(3.1, 1)]);
    expect([c.start, c.end]).toEqual([expect.closeTo(3.7, 1), expect.closeTo(4.5, 1)]);
    expect(a).toMatchObject({ sceneId: 's1', lineIndex: 0, text: 'First line here.' });
  });

  it('splits by character count when the number of silences does not match the lines (the proportional fallback)', async () => {
    const four = lines('x'.repeat(10), 'y'.repeat(30), 'z'.repeat(10), 'w'.repeat(50));
    const out = await sliceNarration({ ext: 'wav', filePath: FIXTURE(), lines: four });
    expect(out.method).toBe('proportional');
    expect(out.segments).toHaveLength(4);
    // The speech runs from 0 to 4.5 s here; 10, 30, 10 and 50 of 100 characters.
    const widths = out.segments.map((s) => s.end - s.start);
    expect(widths[0]).toBeCloseTo(0.45, 1);
    expect(widths[1]).toBeCloseTo(1.35, 1);
    expect(widths[2]).toBeCloseTo(0.45, 1);
    expect(widths[3]).toBeCloseTo(2.25, 1);
    out.segments.slice(1).forEach((s, i) => expect(s.start).toBeCloseTo(out.segments[i].end, 3));
    expect(out.segments[0].start).toBeCloseTo(0, 1);
    expect(out.segments[3].end).toBeCloseTo(4.5, 1);
  });

  it('cuts at the N-1 longest silences when there are more pauses than lines (before the proportional fallback)', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'audio-pauses-'));
    const file = path.join(dir, 'pauses.wav');
    const tone = (f, d, l) => `sine=f=${f}:d=${d},aformat=sample_rates=44100:channel_layouts=mono[${l}]`;
    const gap = (d, l) => `anullsrc=r=44100:cl=mono,atrim=0:${d}[${l}]`;
    // tones 0-0.8, 1.1-1.9 | 2.8-4.0, 4.3-4.8 | 5.8-6.8 ; gaps 0.3, 0.9, 0.3, 1.0
    const graph = [tone(440, 0.8, 'a'), gap(0.3, 'g1'), tone(450, 0.8, 'b'), gap(0.9, 'g2'), tone(550, 1.2, 'c'), gap(0.3, 'g3'), tone(560, 0.5, 'd'), gap(1.0, 'g4'), tone(660, 1.0, 'e'),
      '[a][g1][b][g2][c][g3][d][g4][e]concat=n=9:v=0:a=1[o]'].join(';');
    spawnSync(ffmpegInstaller.path, ['-hide_banner', '-loglevel', 'error', '-y', '-filter_complex', graph, '-map', '[o]', file]);
    const out = await sliceNarration({ ext: 'wav', filePath: file, lines: lines('First line, with a pause in it.', 'Second line, also with one.', 'Third.') });
    rmSync(dir, { recursive: true, force: true });
    expect(out.method).toBe('longest_silences');
    expect(out.segments).toHaveLength(3);
    const [a, b, c] = out.segments;
    expect([a.start, a.end]).toEqual([expect.closeTo(0, 1), expect.closeTo(1.9, 1)]);
    expect([b.start, b.end]).toEqual([expect.closeTo(2.8, 1), expect.closeTo(4.8, 1)]);
    expect([c.start, c.end]).toEqual([expect.closeTo(5.8, 1), expect.closeTo(6.8, 1)]);
  });

  it('uses 0.25 s and -35 dB: a 0.2 s gap is not a cut', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'audio-short-'));
    const file = path.join(dir, 'short.wav');
    const tone = (d, label) => `sine=f=500:d=${d},aformat=sample_rates=44100:channel_layouts=mono[${label}]`;
    spawnSync(ffmpegInstaller.path, ['-hide_banner', '-loglevel', 'error', '-y', '-filter_complex',
      `${tone(1, 'a')};anullsrc=r=44100:cl=mono,atrim=0:0.2[g];${tone(1, 'b')};[a][g][b]concat=n=3:v=0:a=1[o]`, '-map', '[o]', file]);
    const out = await sliceNarration({ ext: 'wav', filePath: file, lines: lines('One line only.') });
    rmSync(dir, { recursive: true, force: true });
    expect(out.method).toBe('silence');
    expect(out.segments).toHaveLength(1);
  });
});

describe('narrator lines', () => {
  it('takes the narrator lines in script order, with the scene and line they came from', () => {
    expect(narratorLines(SCENES)).toEqual([
      { sceneId: 's1', lineIndex: 0, text: 'Nobody believed this would work' },
      { sceneId: 's1', lineIndex: 2, text: 'Maya kept sweeping anyway.' },
      { sceneId: 's2', lineIndex: 0, text: 'Then Leo walked in with coffee!' },
      { sceneId: 's2', lineIndex: 1, text: 'He sat down and stayed.' },
    ]);
  });

  it('joins the lines with sentence breaks, adding the full stop a line is missing', () => {
    const text = narrationText(narratorLines(SCENES));
    expect(text).toContain('Nobody believed this would work.');
    expect(text).toContain('coffee!');
    expect(text.split('\n\n')).toHaveLength(4);
  });
});

// ---------------------------------------------------------------- plan

describe('audio plan', () => {
  it('starts with the documented shape', async () => {
    const { project } = await newProject();
    const plan = defaultPlan(project);
    expect(plan).toEqual({
      mode: 'narrated',
      voiceId: expect.any(String),
      voiceTrackAssetId: null,
      music: { type: 'generated', prompt: '', assetId: null },
      captions: { on: true, style: 'serif_accent' },
    });
  });

  it('merges a partial plan into the stored one and returns the whole thing', async () => {
    const { userId, project } = await newProject();
    await setAudioPlan({ userId, projectId: project.id, plan: { music: { prompt: 'Warm and hopeful piano' } } });
    const { plan } = await setAudioPlan({ userId, projectId: project.id, plan: { captions: { style: 'bold_pop' } } });
    expect(plan.music).toEqual({ type: 'generated', prompt: 'Warm and hopeful piano', assetId: null });
    expect(plan.captions).toEqual({ on: true, style: 'bold_pop' });
    expect((await reload(project.id)).audio_plan).toEqual(plan);
    expect((await reload(project.id)).step).toBe('audio');
  });

  it('refuses what it does not know', async () => {
    const { userId, project } = await newProject();
    const bad = (plan) => setAudioPlan({ userId, projectId: project.id, plan });
    await expect(bad({ captions: { style: 'rainbow' } })).rejects.toMatchObject({ status: 422 });
    await expect(bad({ captions: { on: 'yes' } })).rejects.toMatchObject({ status: 422 });
    await expect(bad({ music: { type: 'radio' } })).rejects.toMatchObject({ status: 422 });
    // Task 24: a voice id that is not the caller's is a 404, so another customer's clone cannot be told from an unknown id.
    await expect(bad({ voiceId: 'not-a-voice' })).rejects.toMatchObject({ status: 404 });
    await expect(bad({ voiceId: 7 })).rejects.toMatchObject({ status: 422, field: 'voiceId' });
    await expect(bad({ mode: 'talking' })).rejects.toMatchObject({ status: 422 });
    await expect(bad({ nope: 1 })).rejects.toMatchObject({ status: 422 });
    await expect(bad({ music: { prompt: 'x'.repeat(400) } })).rejects.toMatchObject({ status: 422 });
    await expect(bad(null)).rejects.toMatchObject({ status: 422 });
  });

  it("an uploaded track must be the signed-in user's own audio", async () => {
    const { userId, project } = await newProject();
    const mine = await addAsset(userId, { kind: 'music' });
    const theirs = await addAsset(randomUUID(), { kind: 'music' });
    const photo = await addAsset(userId, { kind: 'image', url: '/p.png' });
    await expect(setAudioPlan({ userId, projectId: project.id, plan: { music: { type: 'upload' } } })).rejects.toMatchObject({ status: 422 });
    await expect(setAudioPlan({ userId, projectId: project.id, plan: { music: { type: 'upload', assetId: theirs.id } } })).rejects.toMatchObject({ status: 422 });
    await expect(setAudioPlan({ userId, projectId: project.id, plan: { music: { type: 'upload', assetId: photo.id } } })).rejects.toMatchObject({ status: 422 });
    const { plan } = await setAudioPlan({ userId, projectId: project.id, plan: { music: { type: 'upload', assetId: mine.id } } });
    expect(plan.music).toMatchObject({ type: 'upload', assetId: mine.id });
    await expect(setAudioPlan({ userId, projectId: project.id, plan: { voiceTrackAssetId: theirs.id } })).rejects.toMatchObject({ status: 422 });
  });

  it('screens the music description', async () => {
    const { userId, project } = await newProject();
    await expect(setAudioPlan({ userId, projectId: project.id, plan: { music: { prompt: 'They have sex here.' } } })).rejects.toBeInstanceOf(ModerationError);
    expect((await reload(project.id)).audio_plan).toEqual({});
  });

  it("another user's project is a 404", async () => {
    const { project } = await newProject();
    await expect(setAudioPlan({ userId: randomUUID(), projectId: project.id, plan: { captions: { on: false } } })).rejects.toMatchObject({ status: 404 });
    await expect(getAudio({ userId: randomUUID(), projectId: project.id })).rejects.toMatchObject({ status: 404 });
  });
});

// ---------------------------------------------------------------- narration

describe('narration', () => {
  it('is one synthesize call over every narrator line, and the cast lines are left out', async () => {
    const ctx = await newProject();
    await start(ctx, 'narration');
    await finishJobs(ctx.project.id);
    expect(synthesize).toHaveBeenCalledTimes(1);
    const { text, voiceId } = synthesize.mock.calls[0][0];
    expect(text).toBe(narrationText(narratorLines(SCENES)));
    expect(text).not.toContain('Watch me');
    expect(voiceId).toBe(defaultPlan(ctx.project).voiceId);
  });

  it('stores the track and one segment per narrator line (the proportional split on the mock voice)', async () => {
    const ctx = await newProject();
    await start(ctx, 'narration');
    await finishJobs(ctx.project.id);
    const row = await reload(ctx.project.id);
    expect(row.narration_url).toMatch(/narration/);
    expect(row.narration_key).toMatch(new RegExp(`^story/${ctx.project.id}/narration/`));
    expect(row.narration_seconds).toBeGreaterThan(0);
    expect(row.narration_segments).toHaveLength(4);
    expect(row.narration_segments.map((s) => s.text)).toEqual(narratorLines(SCENES).map((l) => l.text));
    row.narration_segments.forEach((s, i) => {
      expect(s.end).toBeGreaterThan(s.start);
      if (i) expect(s.start).toBeGreaterThanOrEqual(row.narration_segments[i - 1].end - 0.001);
    });
    expect(row.narration_segments.at(-1).end).toBeLessThanOrEqual(row.narration_seconds + 0.01);
  });

  it('is free three times, and the fourth costs narrationRegen (5), held then settled', async () => {
    const ctx = await newProject({ funds: 100 });
    for (let i = 0; i < 3; i += 1) {
      const out = await start(ctx, 'narration');
      expect(out.charged).toBe(0);
      await finishJobs(ctx.project.id);
    }
    expect(await balance(ctx.userId)).toMatchObject({ available: 100, held: 0 });
    const fourth = await start(ctx, 'narration');
    expect(fourth.charged).toBe(5);
    expect(await balance(ctx.userId)).toMatchObject({ available: 95, held: 5 });
    const [job] = (await jobs(ctx.project.id, 'narration')).slice(-1);
    expect(job.cost_credits).toBe(5);
    expect(job.hold_id).toBeTruthy();
    await finishJobs(ctx.project.id);
    expect(await balance(ctx.userId)).toMatchObject({ available: 95, held: 0 });
    expect((await reload(ctx.project.id)).narrations_used).toBe(4);
  });

  it('reads the price from pricing_config', async () => {
    await raw.query(`insert into pricing_config (key, value) values ('narrationRegen', '7'::jsonb) on conflict (key) do update set value = '7'::jsonb`);
    _resetPricingCache();
    const ctx = await newProject({ funds: 100 });
    await storyDb().update('story_projects', { id: ctx.project.id }, { narrations_used: 3 });
    const out = await start(ctx, 'narration');
    expect(out.charged).toBe(7);
    expect((await audioOf(ctx)).narration.credits).toBe(7);
  });

  it('expected_credits that no longer matches is 409 quote_changed and changes nothing', async () => {
    const ctx = await newProject({ funds: 50 });
    await storyDb().update('story_projects', { id: ctx.project.id }, { narrations_used: 3 });
    await expect(start(ctx, 'narration', { expectedCredits: 0 })).rejects.toMatchObject({ status: 409, code: 'quote_changed', extra: { credits: 5 } });
    await expect(start(ctx, 'narration', { expectedCredits: -1 })).rejects.toMatchObject({ status: 422 });
    expect(await jobs(ctx.project.id, 'narration')).toHaveLength(0);
    expect((await reload(ctx.project.id)).narrations_used).toBe(3);
    expect(await balance(ctx.userId)).toMatchObject({ available: 50, held: 0 });
    await expect(start(ctx, 'narration', { expectedCredits: 5 })).resolves.toMatchObject({ charged: 5 });
    await storyDb().update('story_projects', { id: ctx.project.id }, { music_used: 3 });
    await expect(start(ctx, 'music', { expectedCredits: 0 })).rejects.toMatchObject({ status: 409, code: 'quote_changed' });
    await expect(start(ctx, 'music', { expectedCredits: 5 })).resolves.toMatchObject({ charged: 5 });
  });

  it('does not start without enough credits, and leaves nothing behind', async () => {
    const ctx = await newProject({ funds: 3 });
    await storyDb().update('story_projects', { id: ctx.project.id }, { narrations_used: 3 });
    await expect(start(ctx, 'narration')).rejects.toBeInstanceOf(InsufficientCreditsError);
    expect(await jobs(ctx.project.id, 'narration')).toHaveLength(0);
    const row = await reload(ctx.project.id);
    expect(row.audio_claims).toEqual({});
    expect(row.narrations_used).toBe(3);
    expect(await balance(ctx.userId)).toMatchObject({ available: 3, held: 0 });
  });

  it('needs a paid plan, narrator lines and a narrated video', async () => {
    const free = await newProject();
    accounts.set({ paid: false });
    await expect(start(free, 'narration')).rejects.toMatchObject({ status: 402, code: 'plan_required' });
    accounts.set({ paid: true });
    const quiet = await newProject({ scenes: [{ id: 's1', title: 'T', visual: 'v', lines: [{ speaker: 'Maya', text: 'Hi.' }] }] });
    await expect(start(quiet, 'narration')).rejects.toMatchObject({ status: 422 });
    const talking = await newProject({ mode: 'talking' });
    await expect(start(talking, 'narration')).rejects.toMatchObject({ status: 422 });
    expect(await jobs(talking.project.id, 'narration')).toHaveLength(0);
  });

  it('refuses a second start while one is running (409), and two at once make one job and one hold', async () => {
    const ctx = await newProject();
    await storyDb().update('story_projects', { id: ctx.project.id }, { narrations_used: 3 });
    const results = await Promise.allSettled([start(ctx, 'narration'), start(ctx, 'narration')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected').reason).toMatchObject({ status: 409 });
    expect(await jobs(ctx.project.id, 'narration')).toHaveLength(1);
    expect(await balance(ctx.userId)).toMatchObject({ held: 5 });
    await expect(start(ctx, 'narration')).rejects.toMatchObject({ status: 409 });
  });

  it('an uploaded voice track bypasses TTS: no provider call, no charge, and it is cut into lines', async () => {
    const ctx = await newProject({ funds: 50 });
    await storyDb().update('story_projects', { id: ctx.project.id }, { narrations_used: 3 });
    const asset = await addAsset(ctx.userId);
    await setAudioPlan({ userId: ctx.userId, projectId: ctx.project.id, plan: { voiceTrackAssetId: asset.id } });
    const out = await start(ctx, 'narration');
    expect(out.charged).toBe(0);
    await finishJobs(ctx.project.id);
    expect(synthesize).not.toHaveBeenCalled();
    const [job] = await jobs(ctx.project.id, 'narration');
    expect(job.hold_id).toBeNull();
    expect(job.payload).toMatchObject({ source: 'upload', assetId: asset.id, credits: 0 });
    const row = await reload(ctx.project.id);
    expect(row.narration_url).toBe(asset.url);
    expect(row.narration_key).toBeNull(); // the file is the customer's own, retention must not delete it
    expect(row.narration_segments).toHaveLength(4);
    expect(row.narrations_used).toBe(3); // their own recording does not use up a generation
    expect(await balance(ctx.userId)).toMatchObject({ available: 50, held: 0 });
    const view = await audioOf(ctx);
    expect(view.narration).toMatchObject({ status: 'ready', source: 'upload', url: asset.url });
  });

  describe('failure and Try again', () => {
    it('a failed free attempt can be retried free, up to three times, then it costs narrationRegen', async () => {
      const ctx = await newProject({ funds: 100 });
      globalThis.__audioFail = 'failed';
      await start(ctx, 'narration');
      await finishJobs(ctx.project.id);
      let view = await audioOf(ctx);
      expect(view.narration).toMatchObject({ status: 'failed', retry_credits: 0 });
      for (let i = 0; i < FREE_RETRIES; i += 1) {
        const out = await start(ctx, 'narration', { retry: true });
        expect(out.charged).toBe(0);
        await finishJobs(ctx.project.id);
      }
      view = await audioOf(ctx);
      expect(view.narration).toMatchObject({ status: 'failed', retry_credits: 5 });
      expect((await reload(ctx.project.id)).narrations_used).toBe(1); // a retry never uses up a generation
      expect(await balance(ctx.userId)).toMatchObject({ available: 100, held: 0 });
    });

    it('a failed paid attempt is refunded, and its retry holds the price again, never twice', async () => {
      const ctx = await newProject({ funds: 100 });
      await storyDb().update('story_projects', { id: ctx.project.id }, { narrations_used: 3 });
      globalThis.__audioFail = 'failed';
      await start(ctx, 'narration');
      await finishJobs(ctx.project.id);
      expect(await balance(ctx.userId)).toMatchObject({ available: 100, held: 0 });
      expect((await audioOf(ctx)).narration).toMatchObject({ status: 'failed', retry_credits: 5 });
      globalThis.__audioFail = null;
      const out = await start(ctx, 'narration', { retry: true });
      expect(out.charged).toBe(5);
      expect(await balance(ctx.userId)).toMatchObject({ available: 95, held: 5 });
      await finishJobs(ctx.project.id);
      expect(await balance(ctx.userId)).toMatchObject({ available: 95, held: 0 });
      expect((await reload(ctx.project.id)).narrations_used).toBe(4);
    });

    it('a retry is allowed only when the last attempt failed', async () => {
      const ctx = await newProject();
      await expect(start(ctx, 'narration', { retry: true })).rejects.toMatchObject({ status: 409, code: 'retry_not_available' });
      await start(ctx, 'narration');
      await finishJobs(ctx.project.id);
      await expect(start(ctx, 'narration', { retry: true })).rejects.toMatchObject({ status: 409, code: 'retry_not_available' });
      expect((await audioOf(ctx)).narration.retry_credits).toBeNull();
    });

    it('a blocked attempt is not retried (the same words would be blocked again)', async () => {
      const ctx = await newProject();
      globalThis.__audioFail = 'blocked';
      await start(ctx, 'narration');
      await finishJobs(ctx.project.id);
      const view = await audioOf(ctx);
      expect(view.narration).toMatchObject({ status: 'blocked', retry_credits: null });
      expect(view.narration.error).toBeTruthy();
      await expect(start(ctx, 'narration', { retry: true })).rejects.toMatchObject({ code: 'retry_not_available' });
    });

    it('a failed regeneration keeps the earlier narration to use', async () => {
      const ctx = await newProject();
      await start(ctx, 'narration');
      await finishJobs(ctx.project.id);
      const before = (await reload(ctx.project.id)).narration_url;
      globalThis.__audioFail = 'failed';
      await start(ctx, 'narration');
      await finishJobs(ctx.project.id);
      const view = await audioOf(ctx);
      expect(view.narration.status).toBe('failed');
      expect(view.narration.url).toBe(before);
    });
  });

  describe('crashes and errors between the claim and the queue', () => {
    it('gives the hold back, un-counts the try and clears the claim when the queue throws', async () => {
      const ctx = await newProject({ funds: 50 });
      await storyDb().update('story_projects', { id: ctx.project.id }, { narrations_used: 3 });
      _setAudioDeps({ enqueue: async () => { throw new Error('queue down'); } });
      await expect(start(ctx, 'narration')).rejects.toThrow('queue down');
      expect(await balance(ctx.userId)).toMatchObject({ available: 50, held: 0 });
      const row = await reload(ctx.project.id);
      expect(row.audio_claims).toEqual({});
      expect(row.narrations_used).toBe(3);
      _setAudioDeps();
      await expect(start(ctx, 'narration')).resolves.toMatchObject({ charged: 5 });
    });

    it('gives the claim back when the hold throws', async () => {
      const ctx = await newProject({ funds: 50 });
      await storyDb().update('story_projects', { id: ctx.project.id }, { narrations_used: 3 });
      _setAudioDeps({ holdCredits: async () => { throw new Error('ledger down'); } });
      await expect(start(ctx, 'narration')).rejects.toThrow('ledger down');
      const row = await reload(ctx.project.id);
      expect(row.audio_claims).toEqual({});
      expect(row.narrations_used).toBe(3);
    });

    it('recovers a claim a dead request left (older than 30 s, no job): releases its hold and un-counts', async () => {
      const ctx = await newProject({ funds: 50 });
      const holdId = randomUUID();
      await holdCredits({ userId: ctx.userId, currency: 'video', amount: 5, projectId: ctx.project.id, holdId });
      const claim = { id: randomUUID(), hold_id: holdId, counted: true, at: new Date(Date.now() - STALE_CLAIM_MS - 5000).toISOString() };
      await storyDb().update('story_projects', { id: ctx.project.id }, { audio_claims: { narration: claim }, narrations_used: 4 });
      // A fresh claim is left alone.
      const fresh = { ...claim, at: new Date().toISOString() };
      await storyDb().update('story_projects', { id: ctx.project.id }, { audio_claims: { narration: fresh } });
      expect(await recoverStalledAudio(ctx.project.id)).toBe(0);
      await storyDb().update('story_projects', { id: ctx.project.id }, { audio_claims: { narration: claim } });
      expect(await recoverStalledAudio(ctx.project.id)).toBe(1);
      const row = await reload(ctx.project.id);
      expect(row.audio_claims).toEqual({});
      expect(row.narrations_used).toBe(3);
      expect(await balance(ctx.userId)).toMatchObject({ available: 50, held: 0 });
    });

    it('a start recovers a dead claim first, so the customer is never stuck', async () => {
      const ctx = await newProject({ funds: 50 });
      const claim = { id: randomUUID(), hold_id: null, counted: false, at: new Date(Date.now() - 120_000).toISOString() };
      await storyDb().update('story_projects', { id: ctx.project.id }, { audio_claims: { narration: claim } });
      await expect(start(ctx, 'narration')).resolves.toMatchObject({ charged: 0 });
    });

    it('a claim whose job was queued is only cleared, nothing is given back', async () => {
      const ctx = await newProject({ funds: 50 });
      await start(ctx, 'narration');
      const [job] = await jobs(ctx.project.id, 'narration');
      // The queue worked but clearing the claim failed: the claim is old and the job carries its id.
      const claim = { id: job.payload.claimId, hold_id: null, counted: true, at: new Date(Date.now() - 120_000).toISOString() };
      await storyDb().update('story_projects', { id: ctx.project.id }, { audio_claims: { narration: claim } });
      expect(await recoverStalledAudio(ctx.project.id)).toBe(1);
      expect((await reload(ctx.project.id)).narrations_used).toBe(1);
    });
  });
});

// ---------------------------------------------------------------- music

describe('music', () => {
  it('always ends the description with "full from the first second, no soft intro"', async () => {
    const ctx = await newProject();
    await setAudioPlan({ userId: ctx.userId, projectId: ctx.project.id, plan: { music: { prompt: 'Warm and hopeful piano.' } } });
    await start(ctx, 'music');
    await finishJobs(ctx.project.id);
    expect(providerMusic).toHaveBeenCalledTimes(1);
    const { prompt, seconds } = providerMusic.mock.calls[0][0];
    expect(MUSIC_SUFFIX).toBe('full from the first second, no soft intro');
    expect(prompt).toBe('Warm and hopeful piano, full from the first second, no soft intro');
    expect(seconds).toBe(34); // the video plus the 4 s the render skips (Task 20 O6)
  });

  it('has a default description when the customer wrote none', async () => {
    const ctx = await newProject();
    await start(ctx, 'music');
    await finishJobs(ctx.project.id);
    expect(providerMusic.mock.calls[0][0].prompt).toMatch(/instrumental/i);
    expect(providerMusic.mock.calls[0][0].prompt.endsWith(MUSIC_SUFFIX)).toBe(true);
  });

  it('stores the track, is free three times, and the fourth costs musicRegen (5)', async () => {
    const ctx = await newProject({ funds: 100 });
    for (let i = 0; i < 3; i += 1) {
      expect((await start(ctx, 'music')).charged).toBe(0);
      await finishJobs(ctx.project.id);
    }
    const row = await reload(ctx.project.id);
    expect(row.music_key).toMatch(new RegExp(`^story/${ctx.project.id}/music/`));
    expect(row.music_url).toBeTruthy();
    expect((await start(ctx, 'music')).charged).toBe(5);
    expect(await balance(ctx.userId)).toMatchObject({ available: 95, held: 5 });
    await finishJobs(ctx.project.id);
    expect(await balance(ctx.userId)).toMatchObject({ available: 95, held: 0 });
    expect((await audioOf(ctx)).music).toMatchObject({ status: 'ready', credits: 5, included: 3, used: 4, free_left: 0 });
  });

  it('keeps its own counter and prices apart from the narration', async () => {
    const ctx = await newProject({ funds: 100 });
    await storyDb().update('story_projects', { id: ctx.project.id }, { narrations_used: 3 });
    const view = await audioOf(ctx);
    expect(view.narration).toMatchObject({ credits: 5, free_left: 0 });
    expect(view.music).toMatchObject({ credits: 0, free_left: 3 });
  });

  it('a failed paid music attempt is refunded and its retry holds the price again', async () => {
    const ctx = await newProject({ funds: 100 });
    await storyDb().update('story_projects', { id: ctx.project.id }, { music_used: 3 });
    globalThis.__audioFail = 'failed';
    await start(ctx, 'music');
    await finishJobs(ctx.project.id);
    expect(await balance(ctx.userId)).toMatchObject({ available: 100, held: 0 });
    expect((await audioOf(ctx)).music).toMatchObject({ status: 'failed', retry_credits: 5 });
    globalThis.__audioFail = null;
    expect((await start(ctx, 'music', { retry: true })).charged).toBe(5);
    await finishJobs(ctx.project.id);
    expect(await balance(ctx.userId)).toMatchObject({ available: 95, held: 0 });
  });

  it('makes nothing when the plan says no music or the customer\'s own track', async () => {
    const ctx = await newProject();
    await setAudioPlan({ userId: ctx.userId, projectId: ctx.project.id, plan: { music: { type: 'none' } } });
    await expect(start(ctx, 'music')).rejects.toMatchObject({ status: 422 });
    const asset = await addAsset(ctx.userId, { kind: 'music' });
    await setAudioPlan({ userId: ctx.userId, projectId: ctx.project.id, plan: { music: { type: 'upload', assetId: asset.id } } });
    await expect(start(ctx, 'music')).rejects.toMatchObject({ status: 422 });
    expect(providerMusic).not.toHaveBeenCalled();
    expect((await audioOf(ctx)).music).toMatchObject({ status: 'ready', source: 'upload', url: asset.url });
  });

  it('needs a paid plan', async () => {
    const ctx = await newProject();
    accounts.set({ paid: false });
    await expect(start(ctx, 'music')).rejects.toMatchObject({ status: 402, code: 'plan_required' });
  });
});

// ---------------------------------------------------------------- round 1

describe('round 1: the audio worker', () => {
  const res = () => makeRes();
  const route = async (headers) => {
    const { default: handler } = await import('../../pages/api/story/worker/audio.js');
    const out = res();
    await handler(makeReq({ method: 'POST', headers }), out);
    return out;
  };

  it('narration and music never run inside the cron; the route runs them, and only with the secret', async () => {
    vi.stubEnv('CRON_SECRET', 'worker-secret');
    const ctx = await newProject({ funds: 20 });
    await start(ctx, 'narration');
    await start(ctx, 'music');
    await runCron({ now: new Date(clock), deadline: Date.now() + 45_000 });
    expect(synthesize).not.toHaveBeenCalled();
    expect(providerMusic).not.toHaveBeenCalled();
    expect((await route({}) ).statusCode).toBe(401);
    expect((await route({ authorization: 'Bearer nope' })).statusCode).toBe(401);
    expect(synthesize).not.toHaveBeenCalled();
    const ok = await route({ authorization: 'Bearer worker-secret' });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, narration: 1, music: 1 });
    expect(synthesize).toHaveBeenCalledTimes(1);
    expect((await audioOf(ctx)).narration.status).toBe('ready');
    expect((await audioOf(ctx)).music.status).toBe('ready');
    vi.unstubAllEnvs();
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('STORY_MOCK', '1');
  });

  it('a provider failure ends the job at once: one provider call, the hold released, no re-queue', async () => {
    const ctx = await newProject({ funds: 100 });
    await storyDb().update('story_projects', { id: ctx.project.id }, { narrations_used: 3 });
    globalThis.__audioFail = 'failed';
    await start(ctx, 'narration');
    await finishJobs(ctx.project.id);
    expect(synthesize).toHaveBeenCalledTimes(1);
    expect((await jobs(ctx.project.id, 'narration'))[0]).toMatchObject({ status: 'failed', attempts: 1 });
    expect(await balance(ctx.userId)).toMatchObject({ available: 100, held: 0 });
  });

  it('the cron kicks the worker route when a job is waiting (and not in mock mode it would stay quiet)', async () => {
    const { kickWorker, AUDIO_WORKER_PATH } = await import('../../lib/story/workers.js');
    const sent = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => { sent.push([url, init.headers.Authorization]); return { ok: true }; }));
    vi.stubEnv('APP_URL', 'https://app.example.test/');
    vi.stubEnv('CRON_SECRET', 's3');
    expect(await kickWorker(AUDIO_WORKER_PATH)).toBe(false); // mock mode
    vi.stubEnv('STORY_MOCK', '');
    const ctx = await newProject({ funds: 20 });
    await start(ctx, 'music');
    await runCron({ now: new Date(clock), deadline: Date.now() + 45_000 });
    expect(sent).toContainEqual(['https://app.example.test/api/story/worker/audio', 'Bearer s3']);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('STORY_MOCK', '1');
  });
});

describe('round 2: the worker route and the kick', () => {
  it('B1: one job per kind per invocation, so a later job is never started inside the window and killed', async () => {
    vi.stubEnv('CRON_SECRET', 'worker-secret');
    const a = await newProject({ funds: 20 });
    const b = await newProject({ funds: 20 });
    await start(a, 'narration');
    await start(b, 'narration');
    const { default: handler } = await import('../../pages/api/story/worker/audio.js');
    const out = makeRes();
    await handler(makeReq({ method: 'POST', headers: { authorization: 'Bearer worker-secret' } }), out);
    expect(out.body).toMatchObject({ ok: true, narration: 1, music: 0 });
    expect(synthesize).toHaveBeenCalledTimes(1);
    expect((await jobs(b.project.id, 'narration'))[0].status).toBe('queued');
    vi.unstubAllEnvs();
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('STORY_MOCK', '1');
  });

  it('B3: one kind throwing does not stop the other from running', async () => {
    vi.stubEnv('CRON_SECRET', 'worker-secret');
    const ctx = await newProject({ funds: 20 });
    await start(ctx, 'music');
    const db = storyDb();
    const realRpc = db.rpc.bind(db);
    const spy = vi.spyOn(db, 'rpc').mockImplementation(async (fn, params) => {
      if (fn === 'story_claim_jobs' && params?.p_kinds?.includes('narration')) throw new Error('boom');
      return realRpc(fn, params);
    });
    const { default: handler } = await import('../../pages/api/story/worker/audio.js');
    const out = makeRes();
    await handler(makeReq({ method: 'POST', headers: { authorization: 'Bearer worker-secret' } }), out);
    spy.mockRestore();
    expect(out.statusCode).toBe(200);
    expect(out.body).toMatchObject({ music: 1, narration: 0 });
    vi.unstubAllEnvs();
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('STORY_MOCK', '1');
  });

  it('B4: runCron kicks the worker before its own work', async () => {
    const order = [];
    vi.stubGlobal('fetch', vi.fn(async () => { order.push('kick'); return { ok: true }; }));
    vi.stubEnv('APP_URL', 'https://app.example.test');
    vi.stubEnv('CRON_SECRET', 's3');
    vi.stubEnv('STORY_MOCK', '');
    const ctx = await newProject({ funds: 20 });
    // start() kicks too; only the cron's own kick is under test.
    await start(ctx, 'music');
    order.length = 0;
    const db = storyDb();
    const realRpc = db.rpc.bind(db);
    const spy = vi.spyOn(db, 'rpc').mockImplementation(async (fn, params) => { order.push(fn); return realRpc(fn, params); });
    await runCron({ now: new Date(clock), deadline: Date.now() + 45_000 });
    spy.mockRestore();
    expect(order[0]).toBe('kick');
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('STORY_MOCK', '1');
  });

  it('B5: starting a generation sends the kick (awaited, capped), not left to be dropped', async () => {
    const sent = [];
    vi.stubGlobal('fetch', vi.fn(async (url) => { sent.push(url); return { ok: true }; }));
    vi.stubEnv('APP_URL', 'https://app.example.test');
    vi.stubEnv('CRON_SECRET', 's3');
    vi.stubEnv('STORY_MOCK', '');
    const ctx = await newProject({ funds: 20 });
    await start(ctx, 'music');
    expect(sent).toEqual(['https://app.example.test/api/story/worker/audio']);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('STORY_MOCK', '1');
  });

  it('B6: in mock mode outside the tests the kick runs the worker in-process, no secret needed', async () => {
    const { kickWorker, AUDIO_WORKER_PATH } = await import('../../lib/story/workers.js');
    const ctx = await newProject({ funds: 20 });
    vi.stubEnv('NODE_ENV', 'development');
    await start(ctx, 'music');
    expect(await kickWorker(AUDIO_WORKER_PATH)).toBe(true);
    vi.stubEnv('NODE_ENV', 'test');
    expect((await audioOf(ctx)).music.status).toBe('ready');
    expect(providerMusic).toHaveBeenCalledTimes(1);
  });
});

describe('round 1: sources, slicing failures, attention, blocked', () => {
  it('A5: a retry after a source switch is a normal priced make, not a retry', async () => {
    const ctx = await newProject({ funds: 100 });
    await storyDb().update('story_projects', { id: ctx.project.id }, { narrations_used: 3 });
    const asset = await addAsset(ctx.userId);
    await setAudioPlan({ userId: ctx.userId, projectId: ctx.project.id, plan: { voiceTrackAssetId: asset.id } });
    await start(ctx, 'narration');
    const [job] = await jobs(ctx.project.id, 'narration');
    await storyDb().update('story_jobs', { id: job.id }, { status: 'failed', error: 'x', applied_at: new Date().toISOString() });
    expect((await audioOf(ctx)).narration.retry_credits).toBe(0);
    await setAudioPlan({ userId: ctx.userId, projectId: ctx.project.id, plan: { voiceTrackAssetId: null } });
    expect((await audioOf(ctx)).narration.retry_credits).toBeNull();
    const out = await start(ctx, 'narration', { retry: true });
    expect(out.charged).toBe(5);
    const last = (await jobs(ctx.project.id, 'narration')).at(-1);
    expect(last.payload).toMatchObject({ kind: 'regen', source: 'generated' });
    expect((await reload(ctx.project.id)).narrations_used).toBe(4);
  });

  it('A6: an own recording that cannot be cut is kept uncut, like a generated one', async () => {
    const ctx = await newProject();
    const asset = await addAsset(ctx.userId, { url: '/api/mock/storage/story/none/missing.mp3' });
    await setAudioPlan({ userId: ctx.userId, projectId: ctx.project.id, plan: { voiceTrackAssetId: asset.id } });
    await start(ctx, 'narration');
    await finishJobs(ctx.project.id);
    const row = await reload(ctx.project.id);
    expect((await jobs(ctx.project.id, 'narration'))[0].status).toBe('done');
    expect(row.narration_url).toBe(asset.url);
    expect(row.narration_segments).toBeNull();
    expect((await audioOf(ctx)).narration.status).toBe('ready');
  });

  it('A8: a job that was charged but could not be applied ("needs attention") shows as failed, never ready', async () => {
    const ctx = await newProject();
    await start(ctx, 'narration');
    await finishJobs(ctx.project.id);
    const [job] = await jobs(ctx.project.id, 'narration');
    await storyDb().update('story_jobs', { id: job.id }, { error: 'Needs attention: the result was charged but could not be applied.' });
    const view = (await audioOf(ctx)).narration;
    expect(view.status).toBe('failed');
    expect(view.error).toMatch(/needs attention/i);
    expect(view.retry_credits).toBeNull();
  });

  it('A4: a blocked attempt stays blocked until the description (or script) changes, then the normal flow is back', async () => {
    const ctx = await newProject();
    await setAudioPlan({ userId: ctx.userId, projectId: ctx.project.id, plan: { music: { prompt: 'Calm piano' } } });
    globalThis.__audioFail = 'blocked';
    await start(ctx, 'music');
    await finishJobs(ctx.project.id);
    expect((await audioOf(ctx)).music).toMatchObject({ status: 'blocked', credits: 0 });
    await setAudioPlan({ userId: ctx.userId, projectId: ctx.project.id, plan: { music: { prompt: 'Calm strings' } } });
    expect((await audioOf(ctx)).music).toMatchObject({ status: 'none', error: null });

    await start(ctx, 'narration');
    await finishJobs(ctx.project.id);
    expect((await audioOf(ctx)).narration.status).toBe('blocked');
    const [row] = await storyDb().select('story_scripts', { project_id: ctx.project.id });
    await storyDb().update('story_scripts', { id: row.id }, { scenes: SCENES.map((sc) => ({ ...sc, lines: sc.lines.map((l) => ({ ...l, text: `${l.text} Again` })) })) });
    expect((await audioOf(ctx)).narration.status).toBe('none');
  });
});

// ---------------------------------------------------------------- view

describe('getAudio', () => {
  it('shows an empty project with the plan, the voices and the prices', async () => {
    const ctx = await newProject();
    const view = await audioOf(ctx);
    expect(view.plan).toEqual(defaultPlan(ctx.project));
    expect(view.voices.length).toBeGreaterThan(1);
    expect(view.voices[0]).toEqual({ id: expect.any(String), name: expect.any(String), gender: expect.any(String), sampleUrl: expect.anything() });
    expect(view.applicable).toEqual({ narration: true, narrationLines: 4 });
    expect(view.narration).toMatchObject({ status: 'none', url: null, segments: null, credits: 0, retry_credits: null, included: 3, used: 0, free_left: 3 });
    expect(view.music).toMatchObject({ status: 'none', url: null, credits: 0, included: 3, free_left: 3 });
  });

  it('says pending while the job is queued, and ready with the segments afterwards', async () => {
    const ctx = await newProject();
    await start(ctx, 'narration');
    expect((await audioOf(ctx)).narration.status).toBe('pending');
    await finishJobs(ctx.project.id);
    const view = await audioOf(ctx);
    expect(view.narration).toMatchObject({ status: 'ready', source: 'generated' });
    expect(view.narration.segments).toHaveLength(4);
    expect(view.narration.url).toBeTruthy();
  });

  it('flags a narration made for other words or another voice as out of date', async () => {
    const ctx = await newProject();
    await start(ctx, 'narration');
    await finishJobs(ctx.project.id);
    expect((await audioOf(ctx)).narration.outdated).toBe(false);
    const other = (await audioOf(ctx)).voices[1].id;
    await setAudioPlan({ userId: ctx.userId, projectId: ctx.project.id, plan: { voiceId: other } });
    expect((await audioOf(ctx)).narration.outdated).toBe(true);
    await setAudioPlan({ userId: ctx.userId, projectId: ctx.project.id, plan: { voiceId: defaultPlan(ctx.project).voiceId } });
    expect((await audioOf(ctx)).narration.outdated).toBe(false);
    const [row] = await storyDb().select('story_scripts', { project_id: ctx.project.id });
    await storyDb().update('story_scripts', { id: row.id }, { scenes: SCENES.map((s) => ({ ...s, lines: s.lines.map((l) => ({ ...l, text: `${l.text} Really.` })) })) });
    expect((await audioOf(ctx)).narration.outdated).toBe(true);
  });

  it('a talking video needs no narration', async () => {
    const ctx = await newProject({ mode: 'talking' });
    expect((await audioOf(ctx)).applicable.narration).toBe(false);
  });
});

// ---------------------------------------------------------------- money rules

describe('audioAttemptCost', () => {
  const pricing = { narrationRegen: 5, musicRegen: 5, included: { narration: 3, music: 3 } };
  const job = (status, extra = {}) => ({ status, payload: { kind: 'first', credits: 0, ...extra } });

  it('is free inside the included tries and the regen price after them', () => {
    expect(audioAttemptCost({ kind: 'narration', used: 2, jobs: [], pricing })).toEqual({ credits: 0, kind: 'first', counted: true });
    expect(audioAttemptCost({ kind: 'narration', used: 3, jobs: [], pricing })).toEqual({ credits: 5, kind: 'regen', counted: true });
    expect(audioAttemptCost({ kind: 'music', used: 3, jobs: [], pricing: { ...pricing, musicRegen: 9 } })).toMatchObject({ credits: 9 });
  });

  it('a retry costs what the failed attempt cost and is never counted', () => {
    expect(audioAttemptCost({ kind: 'music', used: 3, retry: true, jobs: [job('failed', { kind: 'regen', credits: 5 })], pricing })).toEqual({ credits: 5, kind: 'retry', counted: false });
    expect(audioAttemptCost({ kind: 'music', used: 1, retry: true, jobs: [job('failed')], pricing })).toEqual({ credits: 0, kind: 'retry', counted: false });
  });

  it('a retry needs a last attempt that failed', () => {
    for (const status of ['done', 'blocked', 'running', 'queued']) {
      expect(() => audioAttemptCost({ kind: 'music', used: 1, retry: true, jobs: [job(status)], pricing })).toThrow(/nothing to try again/i);
    }
    expect(() => audioAttemptCost({ kind: 'music', used: 1, retry: true, jobs: [], pricing })).toThrow(/nothing to try again/i);
  });

  it('free retries are capped at 3, then the retry costs the regen price', () => {
    const history = [job('failed'), ...Array.from({ length: FREE_RETRIES }, () => job('failed', { kind: 'retry' }))];
    expect(audioAttemptCost({ kind: 'narration', used: 1, retry: true, jobs: history, pricing })).toMatchObject({ credits: 5, kind: 'retry' });
  });
});

// ---------------------------------------------------------------- handlers

describe('narration and music handlers', () => {
  it('are registered (not listed as later kinds)', () => {
    expect(KINDS_REGISTERED_LATER).not.toContain('narration');
    expect(KINDS_REGISTERED_LATER).not.toContain('music');
    expect(narrationHandler.sync).toBe(true);
    expect(musicHandler.sync).toBe(true);
  });

  it('onDone is safe to run twice, settles only through settleJob and writes the track once', async () => {
    const ctx = await newProject({ funds: 50 });
    await storyDb().update('story_projects', { id: ctx.project.id }, { music_used: 3 });
    await start(ctx, 'music');
    const [job] = await jobs(ctx.project.id, 'music');
    const result = { url: '/api/mock/storage/story/x/music/a.mp3', key: 'story/x/music/a.mp3' };
    await musicHandler.onDone(job, result);
    await musicHandler.onDone(job, result);
    expect((await reload(ctx.project.id)).music_key).toBe('story/x/music/a.mp3');
    expect(await balance(ctx.userId)).toMatchObject({ available: 45, held: 0 });
    expect(_handlerCallScope().inHandler).toBe(false);
  });

  it('an old job that lands after a newer attempt writes nothing and gives its hold back', async () => {
    const ctx = await newProject({ funds: 50 });
    await storyDb().update('story_projects', { id: ctx.project.id }, { music_used: 3 });
    await start(ctx, 'music');
    const [old] = await jobs(ctx.project.id, 'music');
    await storyDb().update('story_jobs', { id: old.id }, { status: 'failed', applied_at: new Date().toISOString() });
    await start(ctx, 'music', { retry: true });
    await musicHandler.onDone(old, { url: '/late.mp3', key: 'late' });
    expect((await reload(ctx.project.id)).music_key).toBeNull();
    expect(await balance(ctx.userId)).toMatchObject({ available: 45, held: 5 });
  });
});

// ---------------------------------------------------------------- actions

describe('actions', () => {
  async function call(name, method, { userId, project, body = {} }) {
    const { handleAction } = await import('../../lib/story/actionRoute.js');
    globalThis.__audioTestSession = { user: { id: userId, email: 'test@example.test' } };
    const res = makeRes();
    await handleAction(makeReq({ method, body, query: { id: project.id } }), res, name);
    return res;
  }

  it('registers audio (GET, POST), narration (POST) and music (POST)', async () => {
    const { getActionMethods } = await import('../../lib/story/actions.js');
    await import('../../lib/story/actionRoute.js');
    expect(getActionMethods('audio').sort()).toEqual(['GET', 'POST']);
    expect(getActionMethods('narration')).toEqual(['POST']);
    expect(getActionMethods('music')).toEqual(['POST']);
  });

  it('walks the step through the dispatcher with the shapes the screen uses', async () => {
    const ctx = await newProject({ funds: 20 });
    let res = await call('audio', 'GET', ctx);
    expect(res.statusCode).toBe(200);
    expect(res.body.audio.narration.status).toBe('none');
    res = await call('audio', 'POST', { ...ctx, body: { plan: { captions: { style: 'clean' } } } });
    expect(res.statusCode).toBe(200);
    expect(res.body.audio.plan.captions.style).toBe('clean');
    res = await call('narration', 'POST', ctx);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ charged: 0, audio: { narration: { status: 'pending' } } });
    res = await call('narration', 'POST', ctx);
    expect(res.statusCode).toBe(409);
    res = await call('music', 'POST', ctx);
    expect(res.statusCode).toBe(200);
    res = await call('audio', 'POST', { ...ctx, body: { plan: { captions: { style: 'wild' } } } });
    expect(res.statusCode).toBe(422);
  });

  it('answers 402 with what is needed when a paid attempt cannot be held', async () => {
    const ctx = await newProject({ funds: 2 });
    await storyDb().update('story_projects', { id: ctx.project.id }, { music_used: 3 });
    const res = await call('music', 'POST', ctx);
    expect(res.statusCode).toBe(402);
    expect(res.body).toMatchObject({ error: 'insufficient_credits', needed: 5, available: 2 });
  });

  it('blocks a screened music description with the moderation response', async () => {
    const ctx = await newProject();
    const res = await call('audio', 'POST', { ...ctx, body: { plan: { music: { prompt: 'They have sex here.' } } } });
    expect(res.statusCode).toBe(400);
  });
});
