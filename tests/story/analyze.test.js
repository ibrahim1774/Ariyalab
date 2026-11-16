// Task 22: reference ingestion and analysis (uses tests/helpers/storyEnv.js useRegexOnlyModeration() and useTestAccounts())
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, truncateSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { useRegexOnlyModeration, useTestAccounts } from '../helpers/storyEnv.js';
import { makeReq, makeRes } from '../helpers/apiMock.js';
import { setStoryDb, storyDb } from '../../lib/story/db.js';
import { setCreditsDb } from '../../lib/credits.js';
import { setPricingDb, _resetPricingCache } from '../../lib/pricing.js';
import { ProviderError } from '../../lib/providers/errors.js';
import { MOCK_STORAGE_PREFIX, mockStoragePath, putObject } from '../../lib/providers/storage.js';
import { registerMock } from '../../lib/providers/mock.js';
import { fetchReference, resolveReferenceUrl } from '../../lib/providers/fetchVideo.js';
import { PROVIDER_CONFIG } from '../../lib/providers/config.js';
import { transcribe } from '../../lib/providers/stt.js';
import { completeJSON } from '../../lib/providers/llm.js';
import { tick, runWorkerJob, runCron, WORKER_KINDS, ONE_SHOT_KINDS } from '../../lib/story/runner.js';
import { KINDS_REGISTERED_LATER } from '../../lib/story/handlers.js';
import { storyScriptMock } from '../../lib/story/mocks.js';
import { checkScriptRules, reviseScript, updateScene, writeScript } from '../../lib/story/script.js';
import {
  ANALYSIS, mergeCuts, shotsFromCuts, framePlan, normaliseBeats, saidBetween, parseSceneTimes,
  startAnalysis, getReference, uploadKey,
} from '../../lib/story/analyze.js';
import { REFERENCE_MESSAGES, RIGHTS_STATEMENT, SHARE_HOSTS, isAllowedReferenceLink } from '../../lib/story/referenceRules.js';
import { buildRetryMessage, buildScriptSystem, REFERENCE_GUIDANCE } from '../../lib/story/prompts/script.js';

// Provider spies: each still runs its mock fixture unless a test asks it to fail.
const failAt = (step) => globalThis.__analyzeFail?.at === step;
async function maybeFail(step) {
  if (failAt(step)) {
    const { ProviderError: PE } = await import('../../lib/providers/errors.js');
    throw new PE(globalThis.__analyzeFail.code, globalThis.__analyzeFail.message);
  }
}
vi.mock('../../lib/providers/fetchVideo.js', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    fetchReference: vi.fn(async (...args) => { await maybeFail('fetch'); const out = await real.fetchReference(...args); globalThis.__lastFetch = out; return out; }),
    resolveReferenceUrl: vi.fn((...args) => real.resolveReferenceUrl(...args)),
  };
});
vi.mock('../../lib/providers/stt.js', async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, transcribe: vi.fn(async (...args) => { await maybeFail('stt'); return real.transcribe(...args); }) };
});
vi.mock('../../lib/providers/llm.js', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    completeJSON: vi.fn(async (args) => {
      if (args?.name === 'story_analysis') await maybeFail('llm');
      return real.completeJSON(args);
    }),
  };
});
vi.mock('../../lib/supabaseServer.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getUserFromRequest: vi.fn(async () => globalThis.__analyzeSession ?? null),
}));
vi.mock('../../lib/providers/storage.js', async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, putObject: vi.fn((...args) => real.putObject(...args)) };
});
// Every ffmpeg the analysis spawns is recorded (and still run), to check how it opens its inputs.
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    spawn: vi.fn((bin, args, opts) => { (globalThis.__spawned ||= []).push(args); return real.spawn(bin, args, opts); }),
  };
});
vi.mock('@vercel/blob/client', () => ({
  handleUpload: vi.fn(async ({ body, onBeforeGenerateToken }) => {
    const options = await onBeforeGenerateToken(body.payload.pathname, body.payload.clientPayload, false);
    return { type: 'blob.generate-client-token', options };
  }),
}));

useRegexOnlyModeration();
const accounts = useTestAccounts();

let raw;
let fixtureDir;
const FX = {};

function ffmpeg(args) {
  const r = spawnSync(ffmpegInstaller.path, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  if (r.status !== 0) throw new Error(`could not make a fixture: ${r.stderr}`);
}

beforeAll(async () => {
  raw = await createTestDb();
  setStoryDb(raw);
  setCreditsDb(raw);
  setPricingDb(raw);
  fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'analyze-fixture-'));
  const out = (name) => path.join(fixtureDir, name);
  const v = (src, d) => `${src}=s=160x288:r=24${src === 'mandelbrot' ? '' : `:d=${d}`}`;
  // multi.mp4, 6 s: hard cuts at 2.0 and 4.0, and a 0.2 s white flash (cut at 4.2) that must merge into the 4.0 cut.
  // A tone plays the whole time (the mock transcript has words from 0.05 to 3.95 s).
  FX.multi = out('multi.mp4');
  ffmpeg([
    '-f', 'lavfi', '-i', v('testsrc2', 2), '-f', 'lavfi', '-i', 'color=c=0x2040c0:s=160x288:r=24:d=2',
    '-f', 'lavfi', '-i', 'color=c=white:s=160x288:r=24:d=0.2', '-f', 'lavfi', '-i', 'mandelbrot=s=160x288:r=24,trim=duration=1.8',
    '-f', 'lavfi', '-i', 'sine=f=300:d=6',
    '-filter_complex', '[0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0,format=yuv420p[v]', '-map', '[v]', '-map', '4:a',
    '-c:v', 'libx264', '-c:a', 'aac', '-shortest', FX.multi,
  ]);
  // silent.mp4, 6 s: two shots (cut at 3.0) and a silent audio track.
  FX.silent = out('silent.mp4');
  ffmpeg([
    '-f', 'lavfi', '-i', v('testsrc2', 3), '-f', 'lavfi', '-i', 'color=c=0x2040c0:s=160x288:r=24:d=3',
    '-f', 'lavfi', '-i', 'anullsrc=r=22050:cl=mono', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0,format=yuv420p[v]',
    '-map', '[v]', '-map', '2:a', '-t', '6', '-c:v', 'libx264', '-c:a', 'aac', FX.silent,
  ]);
  // single.mp4, 5 s: one moving shot, no cuts, with sound.
  FX.single = out('single.mp4');
  ffmpeg(['-f', 'lavfi', '-i', v('testsrc2', 5), '-f', 'lavfi', '-i', 'sine=f=300:d=5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', FX.single]);
  // long.mp4: 181 s, tiny and low rate.
  FX.long = out('long.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=gray:s=64x64:r=1:d=181', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', FX.long]);
  // phone.mov: a QuickTime file (ftyp qt) of the single-shot video.
  FX.mov = out('phone.mov');
  ffmpeg(['-i', FX.single, '-c', 'copy', '-f', 'mov', FX.mov]);
  // big.mp4: a real mp4 head, padded (sparse) to 101 MB.
  FX.big = out('big.mp4');
  copyFileSync(FX.single, FX.big);
  truncateSync(FX.big, 101 * 1024 * 1024);
  // notvideo.mp4: text with an mp4 name.
  FX.text = out('notvideo.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'anullsrc', '-t', '0.1', '-f', 'wav', out('tmp.wav')]);
  copyFileSync(out('tmp.wav'), FX.text);
}, 120_000);

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
  // runWorkerJob claims from any project: a job left by an earlier test must not run in this one.
  await raw.query(`update story_jobs set status = 'failed', applied_at = now() where kind = 'analyze' and status in ('queued', 'running')`);
  fetchReference.mockClear();
  transcribe.mockClear();
  completeJSON.mockClear();
  globalThis.__lastFetch = null;
});
afterEach(() => {
  globalThis.__analyzeFail = null;
  globalThis.__analyzeSession = null;
  registerMock('story_script', storyScriptMock);
});

// ---------------------------------------------------------------- helpers

async function newProject(over = {}) {
  const userId = randomUUID();
  const [project] = await storyDb().insert('story_projects', {
    user_id: userId, title: 'Reference test', purpose: 'service', offer: 'A barber shop that takes bookings online.', style: '3d_family', seconds: 30, ...over,
  });
  return { userId, project };
}

/** Puts a local file where mock storage keeps uploads; -> its relative mock URL. */
function upload(ctx, file, name = 'ref.mp4') {
  const key = `story-uploads/${ctx.project.id}/${randomUUID()}-${name}`;
  const dest = mockStoragePath(key);
  mkdirSync(path.dirname(dest), { recursive: true });
  copyFileSync(file, dest);
  if (file === FX.big) truncateSync(dest, 101 * 1024 * 1024);
  return { url: `${MOCK_STORAGE_PREFIX}${key}`, key, dest };
}

const start = (ctx, source, extra = {}) => startAnalysis({ userId: ctx.userId, projectId: ctx.project.id, source, rights: true, ...extra });
const jobsOf = (projectId) => storyDb().select('story_jobs', { project_id: projectId, kind: 'analyze' });
const refsOf = (projectId) => storyDb().select('story_references', { project_id: projectId });
const reload = async (id) => (await storyDb().select('story_projects', { id }))[0];
const usage = async (userId) => {
  const { rows } = await raw.query(`select coalesce(sum(count), 0)::int as n from story_usage where user_id = $1 and action = 'reference_analysis'`, [userId]);
  return rows[0].n;
};
const T0 = Date.parse('2026-11-14T12:00:00.000Z');
/** Runs one analyze job through its worker. */
const work = () => runWorkerJob('analyze', { now: new Date(T0) });

async function analysed(file) {
  const ctx = await newProject();
  const up = upload(ctx, file);
  await start(ctx, { type: 'upload', url: up.url });
  const out = await work();
  expect(out.claimed).toBe(true);
  const ref = (await refsOf(ctx.project.id))[0];
  return { ctx, up, ref };
}

async function expect422(promise, message) {
  const err = await promise.then(() => null, (e) => e);
  expect(err, 'expected a 422').toBeTruthy();
  expect(err.status).toBe(422);
  expect(err.message).toMatch(message);
  return err;
}

// ---------------------------------------------------------------- pure parts

describe('cut list helpers', () => {
  it('merges cuts closer than 0.3 s and keeps the first of them', () => {
    expect(ANALYSIS.mergeCutsSeconds).toBe(0.3);
    expect(ANALYSIS.sceneThreshold).toBe(0.22);
    expect(mergeCuts([2, 4, 4.208, 5.9])).toEqual([2, 4, 5.9]);
    expect(mergeCuts([0.1, 2])).toEqual([2]); // a cut in the first 0.3 s is not a shot
    expect(mergeCuts([1, 1.29, 1.58, 3])).toEqual([1, 1.58, 3]);
  });

  it('turns cuts into shots that cover the whole video', () => {
    expect(shotsFromCuts([2, 4], 6)).toEqual([{ start: 0, end: 2 }, { start: 2, end: 4 }, { start: 4, end: 6 }]);
    expect(shotsFromCuts([], 5)).toEqual([{ start: 0, end: 5 }]);
    expect(shotsFromCuts([5.9], 6)).toEqual([{ start: 0, end: 6 }]); // a cut in the last 0.3 s is dropped
  });

  it('reads the cut times from ffmpeg showinfo output', () => {
    const stderr = '[Parsed_showinfo_2 @ 0x1] n:   0 pts:  24576 pts_time:2       duration: 512\n[Parsed_showinfo_2 @ 0x1] n:   1 pts:  49152 pts_time:4.20833 duration: 512';
    expect(parseSceneTimes(stderr)).toEqual([2, 4.20833]);
  });

  it('plans 2 frames per shot, at most 80 frames, 448 wide', () => {
    expect(ANALYSIS.frameWidth).toBe(448);
    expect(ANALYSIS.maxFrames).toBe(80);
    const few = framePlan([{ start: 0, end: 3 }, { start: 3, end: 6 }]);
    expect(few).toHaveLength(4);
    expect(few.every((f) => f.t > 0 && f.t < 6)).toBe(true);
    const many = framePlan(Array.from({ length: 100 }, (_, i) => ({ start: i, end: i + 1 })));
    expect(many.length).toBeLessThanOrEqual(80);
    expect(new Set(many.map((f) => f.shot)).size).toBe(many.length); // one frame a shot once 2 would pass the cap
  });

  it('fills what is said from the transcript words inside each beat', () => {
    const words = [{ w: 'Once', start: 0.1, end: 0.4 }, { w: 'upon', start: 0.5, end: 0.8 }, { w: 'a', start: 2.1, end: 2.2 }, { w: 'time.', start: 2.3, end: 2.9 }];
    expect(saidBetween(words, 0, 2)).toBe('Once upon');
    expect(saidBetween(words, 2, 4)).toBe('a time.');
    expect(saidBetween([], 0, 4)).toBe('');
  });

  it('normalises the model beats: times from the cut list, ascending, said from the transcript', () => {
    const shots = [{ start: 0, end: 2 }, { start: 2, end: 4 }, { start: 4, end: 6 }];
    const words = [{ w: 'Hello', start: 0.2, end: 0.6 }, { w: 'there.', start: 4.5, end: 5 }];
    const beats = normaliseBeats([
      { start: 4.1, end: 6.4, visual: 'C', said: 'made up words', why: 'ends' },
      { start: -1, end: 1.9, visual: 'A', said: 'invented', why: 'opens' },
      { start: 2.05, end: 3.8, visual: 'B', said: '', why: 'middle' },
    ], { shots, duration: 6, words });
    expect(beats.map((b) => b.ord)).toEqual([1, 2, 3]);
    expect(beats.map((b) => [b.start, b.end])).toEqual([[0, 2], [2, 4], [4, 6]]);
    expect(beats.map((b) => b.said)).toEqual(['Hello', '', 'there.']);
    expect(beats.map((b) => b.visual)).toEqual(['A', 'B', 'C']);
  });

  it('falls back to one beat per shot when the model gives nothing usable', () => {
    const beats = normaliseBeats([{ start: 9, end: 3, visual: '', why: '' }], { shots: [{ start: 0, end: 5 }], duration: 5, words: [] });
    expect(beats).toHaveLength(1);
    expect(beats[0]).toMatchObject({ ord: 1, start: 0, end: 5, said: '' });
    expect(beats[0].visual).toBeTruthy();
  });
});

describe('link allowlist', () => {
  it('allows only instagram.com, tiktok.com, facebook.com and fb.watch, with www and m', () => {
    for (const ok of [
      'https://www.instagram.com/reel/abc/', 'https://instagram.com/p/abc', 'https://m.facebook.com/watch/?v=1',
      'https://www.facebook.com/ads/library/?id=123', 'https://fb.watch/xyz/', 'https://www.tiktok.com/@a/video/1', 'HTTPS://TIKTOK.COM/@a/video/1',
      'https://instagram.com./reel/abc', 'https://vm.tiktok.com/ZM123/', 'https://vt.tiktok.com/ZS9/',
    ]) expect(isAllowedReferenceLink(ok), ok).toBe(true);
    for (const bad of [
      'https://www.youtube.com/watch?v=1', 'https://youtu.be/1', 'https://www.vm.tiktok.com/abc', 'https://m.vt.tiktok.com/abc', 'https://instagram.com.evil.com/x',
      'https://instagram.com@evil.com/x', 'https://evil.com/?u=instagram.com', 'ftp://instagram.com/x', 'javascript:alert(1)',
      'instagram.com/reel/abc', 'https://web.facebook.com/x', '', null,
    ]) expect(isAllowedReferenceLink(bad), String(bad)).toBe(false);
  });
});

// ---------------------------------------------------------------- the brief's tests

describe('analysis of a fixture reference', () => {
  it('yields a cut list and beats with ascending times', async () => {
    const { ref } = await analysed(FX.multi);
    expect(ref.status).toBe('ready');
    expect(ref.duration_seconds).toBeCloseTo(6, 1);
    expect(ref.cut_list).toHaveLength(3);
    const bounds = ref.cut_list.flatMap((c) => [c.start, c.end]);
    [0, 2, 2, 4, 4, 6].forEach((t, i) => expect(bounds[i]).toBeCloseTo(t, 1));
    const beats = ref.beat_sheet;
    expect(beats).toHaveLength(3);
    beats.forEach((b, i) => {
      expect(b.ord).toBe(i + 1);
      expect(b.end).toBeGreaterThan(b.start);
      if (i) expect(b.start).toBeGreaterThanOrEqual(beats[i - 1].end - 1e-9);
      expect(Object.keys(b).sort()).toEqual(['end', 'ord', 'said', 'start', 'visual', 'why']);
    });
    expect(beats[0].said).toMatch(/Once upon a time/);
    expect(ref.transcript.words.length).toBeGreaterThan(0);
    expect(ref.hook).toBeTruthy();
    expect(ref.structure).toBeTruthy();
    expect(ref.mood).toBeTruthy();
    expect(['narrated', 'talking']).toContain(ref.suggested_mode);
    expect(transcribe).toHaveBeenCalledTimes(1);
  });

  it('sends the frames (2 per shot, 448 wide) and the transcript to the fast model once', async () => {
    await analysed(FX.multi);
    const calls = completeJSON.mock.calls.filter(([a]) => a.name === 'story_analysis');
    expect(calls).toHaveLength(1);
    const [args] = calls[0];
    expect(args.tier).toBe('fast');
    const blocks = args.messages[0].content;
    const images = blocks.filter((b) => b.type === 'image');
    expect(images).toHaveLength(6);
    expect(images[0].source.media_type).toBe('image/jpeg');
    expect(JSON.stringify(blocks.filter((b) => b.type === 'text'))).toMatch(/Once upon a time/);
    const jpeg = Buffer.from(images[0].source.data, 'base64');
    const probe = spawnSync(ffmpegInstaller.path, ['-hide_banner', '-i', 'pipe:0', '-f', 'null', '-'], { input: jpeg });
    expect(String(probe.stderr)).toMatch(/448x\d+/);
  });

  it('keeps one stored thumbnail per beat and nothing else', async () => {
    const { ctx, ref } = await analysed(FX.multi);
    expect(ref.frames).toHaveLength(3);
    ref.frames.forEach((f, i) => {
      expect(f.ord).toBe(i + 1);
      expect(f.url).toMatch(/^\/api\/mock\/storage\/story\//);
      expect(existsSync(mockStoragePath(f.key))).toBe(true);
    });
    const dir = mockStoragePath(`story/${ctx.project.id}/reference/${ref.id}`);
    expect(readdirSync(dir).sort()).toEqual(ref.frames.map((f) => path.basename(f.key)).sort());
  });

  it('a no-speech video still yields beats, with empty said, and pays for no transcription', async () => {
    const { ref } = await analysed(FX.silent);
    expect(ref.status).toBe('ready');
    expect(ref.beat_sheet).toHaveLength(2);
    expect(ref.beat_sheet.every((b) => b.said === '')).toBe(true);
    expect(transcribe).not.toHaveBeenCalled();
    expect(ref.transcript).toEqual({ text: '', words: [] });
  });

  it('a single-shot video yields one beat', async () => {
    const { ref } = await analysed(FX.single);
    expect(ref.status).toBe('ready');
    expect(ref.cut_list).toHaveLength(1);
    expect(ref.beat_sheet).toHaveLength(1);
    expect(ref.beat_sheet[0].start).toBe(0);
    expect(ref.beat_sheet[0].end).toBeCloseTo(5, 1);
  });

  it('deletes the uploaded source file after analysis', async () => {
    const { ctx, up, ref } = await analysed(FX.multi);
    expect(existsSync(up.dest)).toBe(false);
    expect(ref.file_url).toBeNull();
    expect(ref.storage_key).toBeNull();
    // The upload's asset row goes with it.
    expect(await storyDb().select('story_assets', { user_id: ctx.userId })).toHaveLength(0);
  });

  it('deletes the downloaded file of a link and its temp folder', async () => {
    const ctx = await newProject();
    await start(ctx, { type: 'link', url: 'https://www.instagram.com/reel/abc123/' });
    await work();
    const ref = (await refsOf(ctx.project.id))[0];
    expect(ref.status).toBe('ready');
    expect(ref.platform).toBe('instagram');
    expect(ref.source_url).toBe('https://www.instagram.com/reel/abc123/');
    expect(fetchReference).toHaveBeenCalledTimes(1);
    const fetched = globalThis.__lastFetch;
    expect(fetched.filePath).toBeTruthy();
    expect(existsSync(fetched.filePath)).toBe(false);
    expect(existsSync(path.dirname(fetched.filePath))).toBe(false);
  });

  it('uses the separate sound track a link can come with', async () => {
    const ctx = await newProject();
    await start(ctx, { type: 'link', url: 'https://www.instagram.com/reel/x/?[[mock:silent-reel]]' });
    await work();
    const ref = (await refsOf(ctx.project.id))[0];
    expect(ref.status).toBe('ready');
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(ref.beat_sheet.length).toBe(3); // reference-silent.mp4: three 4 s scenes
  });

  it('final review I3: every ffmpeg input is opened with the file protocol only and a forced demuxer', async () => {
    const check = () => {
      const runs = globalThis.__spawned || [];
      expect(runs.length).toBeGreaterThan(3);
      for (const args of runs) {
        const inputs = args.flatMap((a, i) => (a === '-i' ? [i] : []));
        expect(inputs.length, args.join(' ')).toBeGreaterThan(0);
        for (const i of inputs) {
          const before = args.slice(0, i);
          const at = before.lastIndexOf('-protocol_whitelist');
          expect(at, args.join(' ')).toBeGreaterThanOrEqual(0);
          expect(before[at + 1]).toBe('file');
          const f = before.lastIndexOf('-f');
          expect(f, args.join(' ')).toBeGreaterThan(at);
          expect(['mov', 'mp3']).toContain(before[f + 1]);
        }
      }
    };
    globalThis.__spawned = [];
    await analysed(FX.multi);
    check();
    // A link with a separate sound track (an mp3 in mock mode) is read with its own demuxer.
    globalThis.__spawned = [];
    const ctx = await newProject();
    await start(ctx, { type: 'link', url: 'https://www.instagram.com/reel/x/?[[mock:silent-reel]]' });
    await work();
    expect((await refsOf(ctx.project.id))[0].status).toBe('ready');
    check();
    globalThis.__spawned = null;
  });

  it('a brand kit clip used as the reference is not deleted', async () => {
    const ctx = await newProject();
    const up = upload(ctx, FX.single);
    const [asset] = await storyDb().insert('story_assets', { user_id: ctx.userId, kind: 'video_clip', in_brand_kit: true, url: up.url, storage_key: up.key, mime: 'video/mp4', bytes: 1000 });
    await start(ctx, { type: 'upload', assetId: asset.id });
    await work();
    expect((await refsOf(ctx.project.id))[0].status).toBe('ready');
    expect(existsSync(up.dest)).toBe(true);
    expect(await storyDb().select('story_assets', { id: asset.id })).toHaveLength(1);
  });
});

describe('what is refused before any job exists', () => {
  async function refused(ctx, promise, message) {
    accounts.set({ paid: false });
    await expect422(promise, message);
    expect(await jobsOf(ctx.project.id)).toHaveLength(0);
    expect(await refsOf(ctx.project.id)).toHaveLength(0);
    expect((await reload(ctx.project.id)).reference_id).toBeNull();
    expect(await usage(ctx.userId)).toBe(0);
  }

  it('a 181 s file returns its own 422', async () => {
    const ctx = await newProject();
    accounts.set({ paid: false });
    const up = upload(ctx, FX.long);
    await refused(ctx, start(ctx, { type: 'upload', url: up.url }), REFERENCE_MESSAGES.tooLong);
    expect(REFERENCE_MESSAGES.tooLong).toMatch(/3 minutes/);
    expect(existsSync(up.dest)).toBe(false); // a refused upload is removed
    expect(await storyDb().select('story_assets', { user_id: ctx.userId })).toHaveLength(0);
  });

  it('a 101 MB file returns its own 422', async () => {
    const ctx = await newProject();
    accounts.set({ paid: false });
    await refused(ctx, start(ctx, { type: 'upload', url: upload(ctx, FX.big).url }), REFERENCE_MESSAGES.tooBig);
    expect(REFERENCE_MESSAGES.tooBig).toMatch(/100 MB/);
  });

  it('a youtube link returns its own 422', async () => {
    const ctx = await newProject();
    accounts.set({ paid: false });
    await refused(ctx, start(ctx, { type: 'link', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }), /Upload the file instead/);
    await refused(ctx, start(ctx, { type: 'link', url: 'https://www.vm.tiktok.com/ZM123/' }), /Upload the file instead/);
    expect(fetchReference).not.toHaveBeenCalled();
  });

  it('a file that is not a video, the rights box unticked, or someone else\'s upload is refused', async () => {
    const ctx = await newProject();
    await refused(ctx, start(ctx, { type: 'upload', url: upload(ctx, FX.text).url }), REFERENCE_MESSAGES.notVideo);
    await refused(ctx, start(ctx, { type: 'upload', url: upload(ctx, FX.single).url }, { rights: false }), REFERENCE_MESSAGES.rights);
    await refused(ctx, start(ctx, { type: 'link', url: 'https://www.tiktok.com/@a/video/1' }, { rights: 'yes' }), REFERENCE_MESSAGES.rights);
    const other = await newProject();
    const theirs = upload(other, FX.single);
    await refused(ctx, start(ctx, { type: 'upload', url: theirs.url }), /upload/i);
    expect(existsSync(theirs.dest)).toBe(true); // never touched
    const [asset] = await storyDb().insert('story_assets', { user_id: other.userId, kind: 'reference_video', url: upload(other, FX.single).url, mime: 'video/mp4' });
    const err = await start(ctx, { type: 'upload', assetId: asset.id }).then(() => null, (e) => e);
    expect(err?.status).toBe(404);
    await refused(ctx, start(ctx, { type: 'telepathy' }), /upload a video or paste a link/i);
  });
});

describe('starting an analysis', () => {
  it('stores the reference, the rights statement and its time, and queues one analyze job', async () => {
    const ctx = await newProject();
    const view = await start(ctx, { type: 'link', url: 'https://www.tiktok.com/@shop/video/123' });
    expect(view.status).toBe('pending');
    const [ref] = await refsOf(ctx.project.id);
    expect(ref).toMatchObject({ source_type: 'link', status: 'pending', rights_confirmed: true, rights_statement: RIGHTS_STATEMENT });
    expect(Date.parse(ref.rights_confirmed_at)).toBeGreaterThan(Date.now() - 60_000);
    expect((await reload(ctx.project.id)).reference_id).toBe(ref.id);
    const jobs = await jobsOf(ctx.project.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ status: 'queued', hold_id: null, cost_credits: null });
    expect(ref.job_id).toBe(jobs[0].id);
  });

  it('refuses a second analysis while one is running (409)', async () => {
    const ctx = await newProject();
    await start(ctx, { type: 'link', url: 'https://www.tiktok.com/@shop/video/1' });
    const err = await start(ctx, { type: 'link', url: 'https://www.tiktok.com/@shop/video/2' }).then(() => null, (e) => e);
    expect(err?.status).toBe(409);
    expect(await jobsOf(ctx.project.id)).toHaveLength(1);
  });

  it('two starts at the same moment make one reference and one job', async () => {
    const ctx = await newProject();
    const results = await Promise.allSettled([
      start(ctx, { type: 'link', url: 'https://www.tiktok.com/@shop/video/1' }),
      start(ctx, { type: 'link', url: 'https://www.tiktok.com/@shop/video/2' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await jobsOf(ctx.project.id)).toHaveLength(1);
    expect(await refsOf(ctx.project.id)).toHaveLength(1);
  });

  it('a new analysis replaces a finished one, and the old frames are removed', async () => {
    const { ctx, ref: first } = await analysed(FX.single);
    await start(ctx, { type: 'link', url: 'https://www.tiktok.com/@shop/video/9' });
    expect(await storyDb().select('story_references', { id: first.id })).toHaveLength(0);
    first.frames.forEach((f) => expect(existsSync(mockStoragePath(f.key))).toBe(false));
  });

  it('a duplicated project keeps its thumbnails when the original replaces its reference', async () => {
    const { duplicateProject } = await import('../../lib/story/projects.js');
    const { ctx, ref: first } = await analysed(FX.single);
    const copy = await duplicateProject({ userId: ctx.userId, id: ctx.project.id });
    await start(ctx, { type: 'link', url: 'https://www.tiktok.com/@shop/video/9' });
    first.frames.forEach((f) => expect(existsSync(mockStoragePath(f.key))).toBe(true));
    const [copied] = await refsOf(copy.id);
    expect(copied.frames.map((f) => f.key)).toEqual(first.frames.map((f) => f.key));
  });

  it('an upload refused by the daily limit is removed with its asset row', async () => {
    const ctx = await newProject();
    accounts.set({ paid: false });
    await start(ctx, { type: 'link', url: 'https://www.tiktok.com/@shop/video/1' });
    await work();
    const up = upload(ctx, FX.single);
    const err = await start(ctx, { type: 'upload', url: up.url }).then(() => null, (e) => e);
    expect(err?.code).toBe('daily_limit');
    expect(existsSync(up.dest)).toBe(false);
    expect(await storyDb().select('story_assets', { user_id: ctx.userId })).toHaveLength(0);
  });

  it('a free account gets one analysis a day', async () => {
    const ctx = await newProject();
    accounts.set({ paid: false });
    await start(ctx, { type: 'link', url: 'https://www.tiktok.com/@shop/video/1' });
    await work();
    const err = await start(ctx, { type: 'link', url: 'https://www.tiktok.com/@shop/video/2' }).then(() => null, (e) => e);
    expect(err?.status).toBe(429);
    expect(err?.code).toBe('daily_limit');
  });
});

describe('failures and the daily count', () => {
  it('gives the count back when the analysis failed before any paid call', async () => {
    const ctx = await newProject();
    accounts.set({ paid: false });
    const up = upload(ctx, FX.multi);
    await start(ctx, { type: 'upload', url: up.url });
    expect(await usage(ctx.userId)).toBe(1);
    rmSync(up.dest); // the file is gone before the worker reads it
    await work();
    const [ref] = await refsOf(ctx.project.id);
    expect(ref.status).toBe('failed');
    expect(ref.provider_started_at).toBeNull();
    expect(ref.error).toBeTruthy();
    expect(await usage(ctx.userId)).toBe(0);
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('keeps the count when a paid call was made, and never calls a provider twice', async () => {
    const ctx = await newProject();
    accounts.set({ paid: false });
    await start(ctx, { type: 'link', url: 'https://www.instagram.com/reel/abc/' });
    globalThis.__analyzeFail = { at: 'llm', code: 'failed' };
    await work();
    const [ref] = await refsOf(ctx.project.id);
    expect(ref.status).toBe('failed');
    expect(ref.provider_started_at).toBeTruthy();
    expect(await usage(ctx.userId)).toBe(1);
    const [job] = await jobsOf(ctx.project.id);
    expect(job.status).toBe('failed');
    await work();
    expect(fetchReference).toHaveBeenCalledTimes(1);
  });

  it('a rate limit after a paid call ends the job instead of queueing a second download', async () => {
    const ctx = await newProject();
    await start(ctx, { type: 'link', url: 'https://www.instagram.com/reel/abc/' });
    globalThis.__analyzeFail = { at: 'stt', code: 'rate_limited' };
    await work();
    const [job] = await jobsOf(ctx.project.id);
    expect(job.status).toBe('failed');
    globalThis.__analyzeFail = null;
    for (let i = 0; i < 3; i += 1) await runWorkerJob('analyze', { now: new Date(T0 + (i + 1) * 60_000) });
    expect(fetchReference).toHaveBeenCalledTimes(1);
    expect((await refsOf(ctx.project.id))[0].status).toBe('failed');
  });

  it('a link that turns out longer than 3 minutes fails with that message', async () => {
    const ctx = await newProject();
    await start(ctx, { type: 'link', url: 'https://www.instagram.com/reel/abc/' });
    fetchReference.mockImplementationOnce(async () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'story-ref-'));
      const filePath = path.join(dir, 'reference.mp4');
      copyFileSync(FX.long, filePath);
      const out = { filePath, platform: 'instagram', cleanup: () => rmSync(dir, { recursive: true, force: true }) };
      globalThis.__lastFetch = out;
      return out;
    });
    await work();
    const [ref] = await refsOf(ctx.project.id);
    expect(ref.status).toBe('failed');
    expect(ref.error).toBe(REFERENCE_MESSAGES.tooLong);
    expect(existsSync(globalThis.__lastFetch.filePath)).toBe(false);
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('content the model refuses is marked failed with a plain message', async () => {
    const ctx = await newProject();
    await start(ctx, { type: 'link', url: 'https://www.instagram.com/reel/abc/' });
    globalThis.__analyzeFail = { at: 'llm', code: 'blocked' };
    await work();
    const [ref] = await refsOf(ctx.project.id);
    expect(ref.status).toBe('failed');
    expect(ref.error).toMatch(/content rules/i);
  });

  it('gives every provider a timeout that fits inside the 300 s worker window', async () => {
    const ctx = await newProject();
    await start(ctx, { type: 'link', url: 'https://www.instagram.com/reel/abc/' });
    await work();
    const fetchMs = fetchReference.mock.calls[0][1]?.timeoutMs;
    const sttMs = transcribe.mock.calls[0][0]?.timeoutMs;
    const llmMs = completeJSON.mock.calls.find(([a]) => a.name === 'story_analysis')[0].timeoutMs;
    for (const ms of [fetchMs, sttMs, llmMs]) {
      expect(Number.isFinite(ms)).toBe(true);
      expect(ms).toBeGreaterThan(10_000);
    }
    expect(fetchMs + sttMs + llmMs).toBeLessThanOrEqual(ANALYSIS.windowMs);
    expect(ANALYSIS.windowMs).toBeLessThan(300_000);
  });
});

describe('the analyze worker', () => {
  it('is a one-shot worker kind with a handler', () => {
    expect(WORKER_KINDS).toContain('analyze');
    expect(ONE_SHOT_KINDS).toContain('analyze');
    expect(KINDS_REGISTERED_LATER).not.toContain('analyze');
  });

  it('never runs inside tick or the cron', async () => {
    const ctx = await newProject();
    await start(ctx, { type: 'link', url: 'https://www.instagram.com/reel/abc/' });
    await tick({ projectId: ctx.project.id, now: new Date(T0) });
    await runCron({ now: new Date(T0), deadline: Date.now() + 20_000, sweepMs: 5_000 });
    expect((await jobsOf(ctx.project.id))[0].status).toBe('queued');
    expect(fetchReference).not.toHaveBeenCalled();
  });

  it('the route needs the cron secret and runs at most one job per call', async () => {
    const { default: route, config } = await import('../../pages/api/story/worker/analyze.js');
    expect(config.maxDuration).toBe(300);
    const a = await newProject();
    const b = await newProject();
    await start(a, { type: 'link', url: 'https://www.instagram.com/reel/a/' });
    await start(b, { type: 'link', url: 'https://www.instagram.com/reel/b/' });
    const denied = makeRes();
    await route(makeReq({ method: 'POST', headers: {} }), denied);
    expect(denied.statusCode).toBe(401);
    const res = makeRes();
    await route(makeReq({ method: 'POST', headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, analyze: 1 });
    expect(fetchReference).toHaveBeenCalledTimes(1);
    const statuses = [...(await jobsOf(a.project.id)), ...(await jobsOf(b.project.id))].map((j) => j.status).sort();
    expect(statuses).toEqual(['done', 'queued']);
  });
});

describe('the HTTP action and the view', () => {
  it('POST analyze starts it and GET analyze returns the beats with their thumbnails', async () => {
    const { handleAction } = await import('../../lib/story/actionRoute.js');
    const ctx = await newProject();
    globalThis.__analyzeSession = { user: { id: ctx.userId, email: 't@example.test' } };
    const up = upload(ctx, FX.multi);
    const res = makeRes();
    await handleAction(makeReq({ method: 'POST', query: { id: ctx.project.id }, body: { source: { type: 'upload', url: up.url }, rights: true } }), res, 'analyze');
    expect(res.statusCode).toBe(200);
    expect(res.body.reference.status).toBe('pending');
    await work();
    const got = makeRes();
    await handleAction(makeReq({ method: 'GET', query: { id: ctx.project.id } }), got, 'analyze');
    expect(got.statusCode).toBe(200);
    const view = got.body.reference;
    expect(view.status).toBe('ready');
    expect(view.beats).toHaveLength(3);
    view.beats.forEach((b) => expect(b.thumb).toMatch(/^\/api\/mock\/storage\//));
    expect(view).not.toHaveProperty('transcript');
    expect(view.rights_confirmed_at).toBeTruthy();
    const bad = makeRes();
    await handleAction(makeReq({ method: 'POST', query: { id: ctx.project.id }, body: { source: { type: 'link', url: 'https://youtu.be/x' }, rights: true } }), bad, 'analyze');
    expect(bad.statusCode).toBe(422);
    expect(bad.body.message).toMatch(/Upload the file instead/);
  });

  it('GET analyze is { reference: null } for a project without one, and 404 for someone else', async () => {
    const ctx = await newProject();
    expect(await getReference({ userId: ctx.userId, projectId: ctx.project.id })).toBeNull();
    const err = await getReference({ userId: randomUUID(), projectId: ctx.project.id }).then(() => null, (e) => e);
    expect(err?.status).toBe(404);
  });

  it('the analyze route has its own maxDuration for the upload checks', async () => {
    const { config } = await import('../../pages/api/story/projects/[id]/analyze.js');
    expect(config.maxDuration).toBeGreaterThanOrEqual(60);
  });
});

describe('uploads', () => {
  it('give an authenticated story upload a video only, 100 MB token bound to the caller\'s project', async () => {
    const { default: route } = await import('../../pages/api/upload-token.js');
    const ctx = await newProject();
    globalThis.__analyzeSession = { user: { id: ctx.userId } };
    const body = (pathname) => ({ type: 'blob.generate-client-token', payload: { pathname, clientPayload: JSON.stringify({ surface: 'story-reference', projectId: ctx.project.id }) } });
    const res = makeRes();
    await route(makeReq({ method: 'POST', body: body(`story-uploads/${ctx.project.id}/clip.mp4`) }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.options.allowedContentTypes).toEqual(['video/mp4', 'video/quicktime']);
    expect(res.body.options.maximumSizeInBytes).toBe(100 * 1024 * 1024);
    const wrongPath = makeRes();
    await route(makeReq({ method: 'POST', body: body(`story-uploads/${randomUUID()}/clip.mp4`) }), wrongPath);
    expect(wrongPath.statusCode).toBe(400);
    globalThis.__analyzeSession = { user: { id: randomUUID() } };
    const notOwner = makeRes();
    await route(makeReq({ method: 'POST', body: body(`story-uploads/${ctx.project.id}/clip.mp4`) }), notOwner);
    expect(notOwner.statusCode).toBe(400);
    globalThis.__analyzeSession = null;
    const signedOut = makeRes();
    await route(makeReq({ method: 'POST', body: body(`story-uploads/${ctx.project.id}/clip.mp4`) }), signedOut);
    expect(signedOut.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------- the adapted script

describe('the adapted script', () => {
  const TRANSCRIPT = 'Once upon a time, a baker dreamed big.';

  it('the rule checker flags a line that repeats a reference sentence (normalised match)', () => {
    const scenes = [{ id: 's1', title: 'A', visual: 'A shop.', lines: [{ speaker: 'narrator', text: 'once upon a time A BAKER dreamed big!' }] }];
    const found = checkScriptRules(scenes, { reference: TRANSCRIPT });
    expect(found.map((v) => v.rule)).toContain('reference_copy');
    const fresh = [{ id: 's1', title: 'A', visual: 'A shop.', lines: [{ speaker: 'narrator', text: 'Nobody believed this would work.' }] }];
    expect(checkScriptRules(fresh, { reference: TRANSCRIPT }).map((v) => v.rule)).not.toContain('reference_copy');
    // Short common sentences are not treated as copies.
    expect(checkScriptRules([{ id: 's1', title: 'A', visual: 'A.', lines: [{ speaker: 'narrator', text: 'Thank you.' }] }], { reference: 'Thank you. Once upon a time, a baker dreamed big.' })
      .map((v) => v.rule)).not.toContain('reference_copy');
  });

  it('the writer passes the beats and asks for new lines, characters and setting, and none of its sentences', () => {
    const system = buildScriptSystem({ purpose: 'service', offer: 'x', mode: 'narrated', seconds: 30, beats: [{ ord: 1, start: 0, end: 2, visual: 'v', said: 's', why: 'w' }] });
    expect(system).toContain(REFERENCE_GUIDANCE);
    expect(REFERENCE_GUIDANCE).toMatch(/beat/i);
    expect(REFERENCE_GUIDANCE).toMatch(/order/i);
    expect(REFERENCE_GUIDANCE).toMatch(/pacing/i);
    expect(REFERENCE_GUIDANCE).toMatch(/new lines, new characters and a new setting/i);
    expect(REFERENCE_GUIDANCE).toMatch(/sentence/i);
  });

  it('an adapted script contains no sentence from the transcript (one retry fixes a copy)', async () => {
    const { ctx, ref } = await analysed(FX.multi);
    expect(ref.transcript.text).toBe(TRANSCRIPT);
    // First attempt copies a reference sentence into a line; the retry is the normal mock.
    let calls = 0;
    registerMock('story_script', (input) => {
      calls += 1;
      const out = storyScriptMock(input);
      if (input.messages.length === 1) out.scenes[1].lines[0].text = 'Once upon a time, a baker dreamed big.';
      return out;
    });
    const script = await writeScript({ userId: ctx.userId, projectId: ctx.project.id });
    expect(calls).toBe(2);
    expect(script.source).toBe('reference');
    const brief = completeJSON.mock.calls.filter(([a]) => a.name === 'story_script')[0][0].messages[0].content;
    expect(brief).toContain('"beats"');
    const norm = (s) => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const lines = script.scenes.flatMap((s) => s.lines).map((l) => norm(l.text));
    expect(lines.some((l) => l.includes(norm(TRANSCRIPT)))).toBe(false);
    expect(script.violations.map((v) => v.rule)).not.toContain('reference_copy');
  });
});

// ---------------------------------------------------------------- round 1

describe('round 1', () => {
  const TRANSCRIPT = 'Once upon a time, a baker dreamed big.';
  const copyLine = (out) => { out.scenes[1].lines[0].text = TRANSCRIPT; return out; };
  const dashTwo = (out) => {
    const lines = out.scenes.flatMap((sc) => sc.lines);
    lines[2].text = `${lines[2].text.replace(/[.]$/, '')} — really.`;
    lines[3].text = `${lines[3].text.replace(/[.]$/, '')} — truly.`;
    return out;
  };

  it('R1: a copy-free retry is kept even with more other warnings', async () => {
    const { ctx } = await analysed(FX.multi);
    registerMock('story_script', (input) => (input.messages.length === 1 ? copyLine(storyScriptMock(input)) : dashTwo(storyScriptMock(input))));
    const script = await writeScript({ userId: ctx.userId, projectId: ctx.project.id });
    const rules = script.violations.map((v) => v.rule);
    expect(rules).not.toContain('reference_copy');
    expect(rules.filter((r) => r === 'dash').length).toBeGreaterThanOrEqual(2);
  });

  it('R1: a model script that still copies after the retry is not saved (422) and the count comes back', async () => {
    const { ctx } = await analysed(FX.multi);
    accounts.set({ paid: false });
    registerMock('story_script', (input) => copyLine(storyScriptMock(input)));
    const err = await writeScript({ userId: ctx.userId, projectId: ctx.project.id }).then(() => null, (e) => e);
    expect(err?.status).toBe(422);
    expect(err?.code).toBe('script_blocked');
    expect(await storyDb().select('story_scripts', { project_id: ctx.project.id })).toHaveLength(0);
    const { rows } = await raw.query(`select coalesce(sum(count), 0)::int as n from story_usage where user_id = $1 and action like 'script_write%'`, [ctx.userId]);
    expect(rows[0].n).toBe(0);
  });

  it('R1 (round 2 rule): 6-word runs match an unpunctuated transcript, but runs of common words do not', () => {
    const reference = 'once upon a time a baker dreamed big and the town loved his bread i want to be there';
    const flag = (text) => checkScriptRules([{ id: 's1', title: 'A', visual: 'A shop.', lines: [{ speaker: 'narrator', text }] }], { reference }).map((v) => v.rule);
    expect(flag('And the town loved his bread every day.')).toContain('reference_copy');
    expect(flag('Every morning the town loved his warm rolls.')).not.toContain('reference_copy');
    expect(flag('I want to be there for my sister.')).not.toContain('reference_copy');
    expect(flag('Nobody believed this would work.')).not.toContain('reference_copy');
  });

  it('R2: a TikTok share link (vm./vt.) is accepted and analysed', async () => {
    const ctx = await newProject();
    await start(ctx, { type: 'link', url: 'https://vm.tiktok.com/ZM123/' });
    await work();
    const [ref] = await refsOf(ctx.project.id);
    expect(ref.status).toBe('ready');
    expect(ref.platform).toBe('tiktok');
  });

  it('R3: thumbnails are stored with a deadline signal, and the model leaves room for storage', async () => {
    putObject.mockClear();
    await analysed(FX.multi);
    const calls = putObject.mock.calls.filter(([a]) => /\/reference\//.test(a.key));
    expect(calls).toHaveLength(3);
    calls.forEach(([a]) => expect(a.signal).toBeInstanceOf(AbortSignal));
    expect(ANALYSIS.reserve.llm).toBeGreaterThanOrEqual(ANALYSIS.storageMs * 2);
    expect(ANALYSIS.storageMs).toBeGreaterThan(0);
  });

  it('R4: a QuickTime (.mov) upload is accepted', async () => {
    const ctx = await newProject();
    const up = upload(ctx, FX.mov, 'phone.mov');
    await start(ctx, { type: 'upload', url: up.url });
    await work();
    expect((await refsOf(ctx.project.id))[0].status).toBe('ready');
    const { default: route } = await import('../../pages/api/upload-token.js');
    globalThis.__analyzeSession = { user: { id: ctx.userId } };
    const res = makeRes();
    await route(makeReq({ method: 'POST', body: { type: 'blob.generate-client-token', payload: { pathname: `story-uploads/${ctx.project.id}/phone.mov`, clientPayload: JSON.stringify({ surface: 'story-reference', projectId: ctx.project.id }) } } }), res);
    expect(res.statusCode).toBe(200);
  });

  it('R5: only our own Blob store counts as an upload', () => {
    vi.stubEnv('BLOB_READ_WRITE_TOKEN', 'vercel_blob_rw_AbC123xyz_secretpart');
    const pid = randomUUID();
    expect(uploadKey(pid, `https://abc123xyz.public.blob.vercel-storage.com/story-uploads/${pid}/a-1.mp4`, { mock: false })).toBe(`story-uploads/${pid}/a-1.mp4`);
    expect(uploadKey(pid, `https://someoneelse.public.blob.vercel-storage.com/story-uploads/${pid}/a-1.mp4`, { mock: false })).toBeNull();
    vi.stubEnv('BLOB_READ_WRITE_TOKEN', '');
    expect(uploadKey(pid, `https://abc123xyz.public.blob.vercel-storage.com/story-uploads/${pid}/a-1.mp4`, { mock: false })).toBeNull();
    vi.stubEnv('BLOB_READ_WRITE_TOKEN', '');
  });

  it('R6: the plain signed-in upload surface refuses the story-uploads/ prefix', async () => {
    const { default: route } = await import('../../pages/api/upload-token.js');
    globalThis.__analyzeSession = { user: { id: randomUUID() } };
    const bad = makeRes();
    await route(makeReq({ method: 'POST', body: { type: 'blob.generate-client-token', payload: { pathname: `story-uploads/${randomUUID()}/x.mp4`, clientPayload: '' } } }), bad);
    expect(bad.statusCode).toBe(400);
    const ok = makeRes();
    await route(makeReq({ method: 'POST', body: { type: 'blob.generate-client-token', payload: { pathname: 'uploads/x.mp4', clientPayload: '' } } }), ok);
    expect(ok.statusCode).toBe(200);
  });

  it('R8: a run whose reference already has the paid marker refuses without calling anything', async () => {
    const ctx = await newProject();
    accounts.set({ paid: false });
    await start(ctx, { type: 'link', url: 'https://www.instagram.com/reel/abc/' });
    const [ref] = await refsOf(ctx.project.id);
    await storyDb().update('story_references', { id: ref.id }, { provider_started_at: new Date().toISOString() });
    await work();
    expect(fetchReference).not.toHaveBeenCalled();
    expect(completeJSON).not.toHaveBeenCalled();
    expect((await refsOf(ctx.project.id))[0].status).toBe('failed');
    expect((await jobsOf(ctx.project.id))[0].status).toBe('failed');
    expect(await usage(ctx.userId)).toBe(1);
  });
});

// ---------------------------------------------------------------- round 2

describe('round 2', () => {
  const TRANSCRIPT = 'Once upon a time, a baker dreamed big.';
  const lineRules = (text, reference) => checkScriptRules([{ id: 's1', title: 'A', visual: 'A shop.', lines: [{ speaker: 'narrator', text }] }], { reference }).filter((v) => v.rule === 'reference_copy');
  const ORDINARY = ['We met at the end of a long summer.', 'For the first time the shop felt alive.', 'A lot of people stopped to look.', 'Let me tell you what happened next.', 'The link in my bio has the menu.'];

  it('N1: ordinary phrases pass against a reference that contains them, punctuated or not', () => {
    const punctuated = 'At the end of the day we closed. For the first time a lot of people came. Let me tell you about it. Check the link in my bio for more.';
    const bare = punctuated.replace(/[.]/g, '').toLowerCase();
    for (const line of ORDINARY) {
      expect(lineRules(line, punctuated), `${line} vs punctuated`).toHaveLength(0);
      expect(lineRules(line, bare), `${line} vs unpunctuated`).toHaveLength(0);
    }
  });

  it('N1: a real copied run of 6 or more words from an unpunctuated transcript is flagged, with the matched words', () => {
    const bare = 'so the old baker kneaded dough every single morning before sunrise and sang to the bread';
    const found = lineRules('Each day the old baker kneaded dough every single morning.', bare);
    expect(found).toHaveLength(1);
    expect(found[0].matched).toMatch(/the old baker kneaded dough every/);
    // Round 3: punctuated transcripts get run matching too, with the stricter 8 words / 3 uncommon threshold (below).
  });

  it('N1: a copied run from an unpunctuated transcript is still refused after the retry', async () => {
    const { ctx, ref } = await analysed(FX.multi);
    const bare = 'so the old baker kneaded dough every single morning before sunrise and sang to the bread';
    await storyDb().update('story_references', { id: ref.id }, { transcript: { text: bare, words: [] } });
    registerMock('story_script', (input) => {
      const out = storyScriptMock(input);
      out.scenes[1].lines[0].text = 'The old baker kneaded dough every single morning.';
      return out;
    });
    const err = await writeScript({ userId: ctx.userId, projectId: ctx.project.id }).then(() => null, (e) => e);
    expect(err?.status).toBe(422);
  });

  it('N1: the retry prompt names the matched words', async () => {
    expect(buildRetryMessage([{ sceneId: null, rule: 'reference_copy', message: 'm', matched: 'once upon a time a baker dreamed big' }], [])).toContain('once upon a time a baker dreamed big');
    const { ctx } = await analysed(FX.multi);
    registerMock('story_script', (input) => {
      const out = storyScriptMock(input);
      if (input.messages.length === 1) out.scenes[1].lines[0].text = TRANSCRIPT;
      return out;
    });
    await writeScript({ userId: ctx.userId, projectId: ctx.project.id });
    const calls = completeJSON.mock.calls.filter(([a]) => a.name === 'story_script');
    expect(calls).toHaveLength(2);
    const retry = calls[1][0].messages.at(-1).content;
    expect(retry).toContain('once upon a time a baker dreamed big');
  });

  it('N2: a line the customer saved through updateScene survives a revise without a 422', async () => {
    const { ctx } = await analysed(FX.multi);
    const script = await writeScript({ userId: ctx.userId, projectId: ctx.project.id });
    const sceneId = script.scenes[0].id;
    const saved = await updateScene({ userId: ctx.userId, projectId: ctx.project.id, sceneId, patch: { lines: [{ speaker: 'narrator', text: TRANSCRIPT }] } });
    expect(saved.script.violations.map((v) => v.rule)).toContain('reference_copy'); // a warning only
    const other = script.scenes[1].id;
    const out = await reviseScript({ userId: ctx.userId, projectId: ctx.project.id, instruction: `Make it warmer [[mock:edit:${other}]]` });
    expect(out.script.scenes.find((sc) => sc.id === sceneId).lines[0].text).toBe(TRANSCRIPT);
  });

  it('N3: a share link that does not resolve is a free failure with a TikTok message', async () => {
    const ctx = await newProject();
    accounts.set({ paid: false });
    await start(ctx, { type: 'link', url: 'https://vm.tiktok.com/[[mock:fail]]/' });
    expect(await usage(ctx.userId)).toBe(1);
    await work();
    const [ref] = await refsOf(ctx.project.id);
    expect(ref.status).toBe('failed');
    expect(ref.error).toBe("We couldn't open that TikTok share link. Paste the full video link.");
    expect(ref.provider_started_at).toBeNull();
    expect(fetchReference).not.toHaveBeenCalled();
    expect(await usage(ctx.userId)).toBe(0);
  });

  it('N3: the resolved URL is what gets downloaded', async () => {
    const ctx = await newProject();
    await start(ctx, { type: 'link', url: 'https://vt.tiktok.com/ZS9/' });
    await work();
    expect(fetchReference.mock.calls[0][0]).toMatch(/^https:\/\/www\.tiktok\.com\//);
    expect((await refsOf(ctx.project.id))[0].platform).toBe('tiktok');
  });

  it('N4: when one thumbnail store fails the others are not left behind', async () => {
    const ctx = await newProject();
    await start(ctx, { type: 'upload', url: upload(ctx, FX.multi).url });
    const real = putObject.getMockImplementation();
    putObject.mockImplementation(async (args) => {
      if (/beat-2\.jpg$/.test(args.key)) throw new ProviderError('failed');
      return real(args);
    });
    try {
      await work();
    } finally {
      putObject.mockImplementation(real);
    }
    const [ref] = await refsOf(ctx.project.id);
    expect(ref.status).toBe('failed');
    for (const n of [1, 3]) expect(existsSync(mockStoragePath(`story/${ctx.project.id}/reference/${ref.id}/beat-${n}.jpg`))).toBe(false);
  });

  it('N5: the share hosts have one source', () => {
    expect(PROVIDER_CONFIG.reference.shareHosts).toBe(SHARE_HOSTS);
  });

  it('N6: a percent-encoded or malformed pathname cannot reach story-uploads/ through the plain surface', async () => {
    const { default: route } = await import('../../pages/api/upload-token.js');
    globalThis.__analyzeSession = { user: { id: randomUUID() } };
    // Round 3 (P1): a malformed encoding is no longer refused by itself; the raw form is still checked.
    for (const pathname of [`story-uploads%2F${randomUUID()}%2Fx.mp4`, `Story-Uploads%2f${randomUUID()}%2fx.mp4`, `story-uploads/${randomUUID()}/%E0%A4%A.mp4`]) {
      const res = makeRes();
      await route(makeReq({ method: 'POST', body: { type: 'blob.generate-client-token', payload: { pathname, clientPayload: '' } } }), res);
      expect(res.statusCode, pathname).toBe(400);
    }
  });

  it('N7: when another run set the paid marker first, this run calls nothing', async () => {
    const ctx = await newProject();
    await start(ctx, { type: 'link', url: 'https://www.instagram.com/reel/abc/' });
    const [ref] = await refsOf(ctx.project.id);
    resolveReferenceUrl.mockImplementationOnce(async (url) => {
      await storyDb().update('story_references', { id: ref.id }, { provider_started_at: new Date().toISOString() });
      return url;
    });
    await work();
    expect(fetchReference).not.toHaveBeenCalled();
    expect((await refsOf(ctx.project.id))[0].status).toBe('failed');
  });

  it('chat update_scene hands reference copy warnings back to the chat model', async () => {
    const { runTool } = await import('../../lib/story/chatTools.js');
    const { ctx } = await analysed(FX.multi);
    const script = await writeScript({ userId: ctx.userId, projectId: ctx.project.id });
    const out = await runTool({ userId: ctx.userId, chatProjectId: ctx.project.id, name: 'update_scene', input: { scene_id: script.scenes[0].id, patch: { lines: [{ speaker: 'narrator', text: TRANSCRIPT }] } } });
    expect(out.ok).toBe(true);
    expect(out.reference_copies).toHaveLength(1);
    expect(out.reference_copies[0].matched).toMatch(/baker dreamed big/);
    expect(out.reference_copies[0].message).toBeTruthy();
  });
});

// ---------------------------------------------------------------- round 3

describe('round 3', () => {
  const lineRules = (text, reference) => checkScriptRules([{ id: 's1', title: 'A', visual: 'A shop.', lines: [{ speaker: 'narrator', text }] }], { reference }).filter((v) => v.rule === 'reference_copy');
  const PUNCTUATED = 'So the old baker kneaded dough every single morning before sunrise and sang to the bread. He smiled.';

  it('P2: an 8-word copied run from a punctuated transcript is flagged, with the matched words', () => {
    const found = lineRules('Each day the old baker kneaded dough every single morning.', PUNCTUATED);
    expect(found).toHaveLength(1);
    expect(found[0].matched).toBe('the old baker kneaded dough every single morning');
  });

  it('P2: on a punctuated transcript a 6 or 7 word run is not enough', () => {
    expect(lineRules('Today the old baker kneaded dough with care.', PUNCTUATED)).toHaveLength(0); // 6 words
    expect(lineRules('Then the old baker kneaded dough every day.', PUNCTUATED)).toHaveLength(0); // 7 words
  });

  it('P1: a plain upload whose name has a stray % is allowed, and story-uploads%2F is still refused', async () => {
    const { default: route } = await import('../../pages/api/upload-token.js');
    globalThis.__analyzeSession = { user: { id: randomUUID() } };
    const call = async (pathname) => {
      const res = makeRes();
      await route(makeReq({ method: 'POST', body: { type: 'blob.generate-client-token', payload: { pathname, clientPayload: '' } } }), res);
      return res.statusCode;
    };
    expect(await call('50% off.jpg')).toBe(200);
    expect(await call('uploads/100%.png')).toBe(200);
    expect(await call(`story-uploads%2F${randomUUID()}%2Fx.mp4`)).toBe(400);
    expect(await call(`story-uploads/${randomUUID()}/50% off.mp4`)).toBe(400);
  });
});
