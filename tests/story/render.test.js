// Task 20: the finished video. Renders real mp4s from ffmpeg-made fixtures (mock storage, mock transcription).
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { useRegexOnlyModeration, useTestAccounts } from '../helpers/storyEnv.js';
import { makeReq, makeRes } from '../helpers/apiMock.js';
import { setStoryDb, storyDb } from '../../lib/story/db.js';
import { setCreditsDb, grantCredits } from '../../lib/credits.js';
import { setPricingDb, _resetPricingCache } from '../../lib/pricing.js';
import { putObject, localPathFor, mockStoragePath } from '../../lib/providers/storage.js';
import { transcribe } from '../../lib/providers/stt.js';
import { runWorkerJob, sweep, enqueue } from '../../lib/story/runner.js';
import { KINDS_REGISTERED_LATER } from '../../lib/story/handlers.js';
import { setAudioPlan } from '../../lib/story/audio.js';
import { startRender, renderTargetSize, _configureRender } from '../../lib/story/render.js';
import { captionFilterAvailable } from '../../lib/story/captions.js';
import { run as runChecks, scriptWordsOf, wordCoverage } from '../../lib/story/checks.js';
import { getProjectStatus } from '../../lib/story/status.js';

vi.mock('../../lib/providers/stt.js', async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, transcribe: vi.fn(real.transcribe) };
});
vi.mock('../../lib/providers/storage.js', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    putObject: vi.fn(async (args) => {
      if (globalThis.__putFailures > 0 && String(args.key).includes('/render/')) {
        globalThis.__putFailures -= 1;
        throw new Error('storage hiccup');
      }
      return real.putObject(args);
    }),
  };
});
vi.mock('../../lib/story/captions.js', async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, captionFilterAvailable: vi.fn(real.captionFilterAvailable) };
});
vi.mock('../../lib/supabaseServer.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getUserFromRequest: vi.fn(async () => globalThis.__renderTestSession ?? null),
}));

useRegexOnlyModeration();
const accounts = useTestAccounts();

const FF = ffmpegInstaller.path;
let raw;
let dir;
const media = {};

function ff(args) {
  const r = spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
}

/** -> { duration, audioStreams, videoStreams, lufs } measured with the bundled ffmpeg (ebur128). */
function measure(file) {
  const r = spawnSync(FF, ['-hide_banner', '-nostats', '-i', file, '-filter_complex', '[0:a]ebur128', '-f', 'null', '-'], { encoding: 'utf8' });
  const err = r.stderr;
  const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(err);
  const summary = err.slice(err.lastIndexOf('Summary:'));
  const lufs = /I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/.exec(summary);
  // Only the input file's streams (the null output lists its own).
  const input = err.slice(err.indexOf('Input #0'), err.indexOf('Stream mapping'));
  return {
    duration: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : NaN,
    audioStreams: (input.match(/Stream #0:\d+(?:\[[^\]]*\])?(?:\([^)]*\))?: Audio/g) || []).length,
    videoStreams: (input.match(/Stream #0:\d+(?:\[[^\]]*\])?(?:\([^)]*\))?: Video/g) || []).length,
    lufs: lufs ? Number(lufs[1]) : NaN,
    size: /Stream #0:\d+.*Video:.*?(\d{3,4})x(\d{3,4})/.exec(input)?.slice(1, 3).map(Number),
  };
}

async function store(file, ext) {
  const key = `test-fixtures/${randomUUID()}.${ext}`;
  return putObject({ key, body: readFileSync(path.join(dir, file)) });
}

beforeAll(async () => {
  raw = await createTestDb();
  setStoryDb(raw);
  setCreditsDb(raw);
  setPricingDb(raw);
  dir = mkdtempSync(path.join(os.tmpdir(), 'render-fixture-'));
  // Four clips at a size and frame rate unlike the output; clip 2 is shorter than its 3 s shot; every clip has
  // its own (native) sound, which a narrated video must not use.
  const clip = (name, seconds, hue) => ff([
    '-f', 'lavfi', '-i', `testsrc2=size=540x960:rate=24:duration=${seconds},hue=h=${hue}`,
    '-f', 'lavfi', '-i', `sine=f=300:d=${seconds}`,
    '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', name,
  ]);
  clip('c1.mp4', 4, 0);
  clip('c2.mp4', 2.5, 90);
  clip('c3.mp4', 4, 180);
  clip('c4.mp4', 5, 270);
  // Narration tracks: two "lines" of tone (s1, s2) with a 0.3 s breath between.
  const narration = (name, a, b) => ff([
    '-filter_complex',
    `sine=f=220:d=${a},volume=0.5,adelay=200|200,apad=pad_dur=0.3[a];sine=f=260:d=${b},volume=0.5[b];[a][b]concat=n=2:v=0:a=1,apad=pad_dur=0.5[out]`,
    '-map', '[out]', '-ac', '1', '-ar', '44100', name,
  ]);
  narration('narration.wav', 5.7, 5.5); // each line fills its scene (6 s of shots)
  narration('short.wav', 2.2, 2.7); // short lines: the voice has a long gap once placed at the scenes
  narration('long.wav', 5.7, 8); // s2 is longer than its 6 s even sped up
  // A talking clip whose speech (0.3 to 2.6 s) ends before a 3 s shot does.
  ff([
    '-f', 'lavfi', '-i', 'testsrc2=size=540x960:rate=24:duration=4',
    '-f', 'lavfi', '-i', "sine=f=300:d=4,volume='between(t,0.3,2.6)':eval=frame",
    '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', 'tk1.mp4',
  ]);
  // Music shorter than the video, to be looped.
  ff(['-filter_complex', 'anoisesrc=d=5:c=pink:a=0.1[out]', '-map', '[out]', '-ac', '2', '-ar', '44100', 'music5.wav']);
  // Music: 20 s bed (long enough for the 4 s start).
  ff([
    '-filter_complex', 'anoisesrc=d=20:c=pink:a=0.08[n];sine=f=110:d=20,volume=0.2[s];[n][s]amix=inputs=2[out]',
    '-map', '[out]', '-ac', '2', '-ar', '44100', 'music.wav',
  ]);
  // A one-second gap, for the silence check.
  ff(['-filter_complex', 'sine=f=300:d=1[a];anullsrc=r=44100:cl=mono,atrim=0:1[g];sine=f=300:d=1[b];[a][g][b]concat=n=3:v=0:a=1[out]', '-map', '[out]', 'gap.wav']);
  for (const n of ['c1', 'c2', 'c3', 'c4', 'tk1']) media[n] = await store(`${n}.mp4`, 'mp4');
  media.narration = await store('narration.wav', 'wav');
  media.short = await store('short.wav', 'wav');
  media.long = await store('long.wav', 'wav');
  media.music = await store('music.wav', 'wav');
  media.music5 = await store('music5.wav', 'wav');
}, 120_000);

afterAll(async () => {
  setStoryDb(null);
  setCreditsDb(null);
  setPricingDb(null);
  _resetPricingCache();
  rmSync(dir, { recursive: true, force: true });
  await raw?.close();
});

beforeEach(async () => {
  _resetPricingCache();
  // runWorkerJob claims from any project: leftovers from an earlier test must not run in this one.
  await raw.query(`update story_jobs set status = 'failed', applied_at = now() where kind = 'render' and status in ('queued', 'running')`);
  await raw.query(`update story_renders set status = 'failed' where status in ('queued', 'running')`);
  transcribe.mockClear();
});
afterEach(() => {
  globalThis.__renderTestSession = null;
  _configureRender();
});

const SCENES = [
  { id: 's1', title: 'Morning', visual: 'A small bakery at dawn.', lines: [{ speaker: 'narrator', text: 'Once upon a time,' }] },
  { id: 's2', title: 'Dream', visual: 'The baker looks out of the window.', lines: [{ speaker: 'Maya', text: 'One day.' }, { speaker: 'narrator', text: 'a baker dreamed big.' }] },
];
const segs = (a, b) => [
  { sceneId: 's1', lineIndex: 0, text: 'Once upon a time,', start: 0.2, end: 0.2 + a },
  { sceneId: 's2', lineIndex: 1, text: 'a baker dreamed big.', start: 0.5 + a, end: 0.5 + a + b },
];
const NARRATIONS = { fill: segs(5.7, 5.5), short: segs(2.2, 2.7), long: segs(5.7, 8) };
const SEGMENTS = NARRATIONS.fill;

async function newProject({ style = 'serif_accent', captions = true, music = true, clips = ['c1', 'c2', 'c3', 'c4'], ready = true, narration = 'fill', musicFile = 'music' } = {}) {
  const userId = randomUUID();
  const track = { fill: media.narration, short: media.short, long: media.long }[narration];
  const [project] = await storyDb().insert('story_projects', {
    user_id: userId, title: 'Render test', style: '3d_family', step: 'review', seconds: 15, quality: 'standard', mode: 'narrated', aspect: '9:16',
    narration_url: track.url, narration_key: track.key, narration_seconds: 12, narration_segments: NARRATIONS[narration],
    music_url: music ? media[musicFile].url : null, music_key: music ? media[musicFile].key : null,
    audio_plan: { captions: { on: captions, style }, music: { type: music ? 'generated' : 'none', prompt: '', assetId: null } },
  });
  await storyDb().insert('story_scripts', { project_id: project.id, version: 1, scenes: SCENES, source: 'brief' });
  const shots = await storyDb().insert('story_shots', clips.map((c, i) => ({
    project_id: project.id, ord: i, scene_id: i < 2 ? 's1' : 's2', description: `shot ${i}`, seconds: 3, quality: 'standard',
    source: 'generated', status: ready || i > 0 ? 'ready' : 'still_ready', clip_url: ready || i > 0 ? media[c].url : null, clip_key: ready || i > 0 ? media[c].key : null,
  })));
  return { userId, project, shots };
}

const renders = (projectId) => storyDb().select('story_renders', { project_id: projectId }, { order: 'version' });
const ledgerRows = async (userId) => Number((await raw.query('select count(*)::int as n from credit_ledger where user_id = $1', [userId])).rows[0].n);

async function renderOnce(ctx) {
  const { render } = await startRender({ userId: ctx.userId, projectId: ctx.project.id });
  const out = await runWorkerJob('render', {});
  expect(out).toMatchObject({ claimed: true, outcome: 'done' });
  const [row] = await storyDb().select('story_renders', { id: render.id });
  return row;
}

describe('render', () => {
  it('is a registered worker kind', () => {
    expect(KINDS_REGISTERED_LATER).not.toContain('render');
  });

  it('renders 4 fixture clips with narration and music: duration within 0.1 s of the shot sum, one audio stream at -14 ±1 LUFS', async () => {
    const ctx = await newProject();
    const row = await renderOnce(ctx);
    expect(row).toMatchObject({ status: 'done', version: 1, error: null });
    expect(row.storage_key).toMatch(new RegExp(`^story/${ctx.project.id}/render/v1-`));
    expect(row.storage_key.endsWith('.mp4')).toBe(true);
    const file = localPathFor(row.file_url);
    const m = measure(file);
    if (process.env.RENDER_TEST_LOG) console.log('[render test] measured', JSON.stringify(m), 'row', JSON.stringify({ duration: row.duration_seconds, settings: row.settings, warnings: row.warnings }));
    expect(Math.abs(m.duration - 12)).toBeLessThanOrEqual(0.1);
    expect(Math.abs(row.duration_seconds - 12)).toBeLessThanOrEqual(0.1);
    expect(m.audioStreams).toBe(1);
    expect(m.videoStreams).toBe(1);
    expect(m.size).toEqual([1080, 1920]);
    expect(Math.abs(m.lufs - -14)).toBeLessThanOrEqual(1);
    // The checks ran on the final audio (mock transcription) and passed: no warnings.
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(row.warnings).toEqual([]);
    expect(row.settings).toMatchObject({ captions: { on: true, style: 'serif_accent', format: 'ass' }, aspect: '9:16', mode: 'narrated', music: true });
    expect(row.settings.shots).toHaveLength(4);
    expect(row.settings.checks).toMatchObject({ coverage: 1, ok: true });
    // O1: each scene's narration starts with that scene's first shot: s2's line is inside 6 to 12 s.
    const placed = Object.fromEntries(row.settings.narrationPlan.map((p) => [p.sceneId, p]));
    expect(placed.s1.at).toBeCloseTo(0, 6);
    expect(placed.s2.at).toBeCloseTo(6, 6);
    expect(placed.s2.at + placed.s2.length).toBeLessThanOrEqual(12);
  }, 240_000);

  it('talking mode on 16:9: the clips\' own sound, captions from the shot lines, a footage shot and a framed inset', async () => {
    const userId = randomUUID();
    const [project] = await storyDb().insert('story_projects', {
      user_id: userId, title: 'Talking', style: '3d_family', step: 'review', seconds: 15, quality: 'pro_talking', mode: 'talking', aspect: '16:9',
      audio_plan: { captions: { on: true, style: 'clean' }, music: { type: 'none', prompt: '', assetId: null } },
    });
    await storyDb().insert('story_scripts', { project_id: project.id, version: 1, scenes: SCENES, source: 'brief' });
    const still = await putObject({ key: `test-fixtures/${randomUUID()}.png`, body: readFileSync(path.join(process.cwd(), 'tests/fixtures/still.png')) });
    const [footage, inset] = await storyDb().insert('story_assets', [
      { user_id: userId, kind: 'video_clip', url: media.c4.url, storage_key: media.c4.key, name: 'mine' },
      { user_id: userId, kind: 'product_photo', url: still.url, storage_key: still.key, name: 'product' },
    ]);
    await storyDb().insert('story_shots', [
      { project_id: project.id, ord: 0, scene_id: 's1', seconds: 3, quality: 'pro_talking', source: 'generated', status: 'ready', clip_url: media.tk1.url, clip_key: media.tk1.key, line: 'Once upon a time,', inset_asset_id: inset.id, inset: { x: 0.5, y: 0.3, w: 0.3 } },
      { project_id: project.id, ord: 1, scene_id: 's2', seconds: 4, quality: 'pro_talking', source: 'footage', status: 'draft', footage_asset_id: footage.id, footage: { trimStart: 0.5, fit: 'contain' } },
      { project_id: project.id, ord: 2, scene_id: 's2', seconds: 3, quality: 'pro_talking', source: 'generated', status: 'ready', clip_url: media.c2.url, clip_key: media.c2.key, line: 'a baker dreamed big.' },
    ]);
    const row = await renderOnce({ userId, project });
    expect(row.status).toBe('done');
    const m = measure(localPathFor(row.file_url));
    expect(Math.abs(m.duration - 10)).toBeLessThanOrEqual(0.1);
    expect(m.size).toEqual([1920, 1080]);
    expect(m.audioStreams).toBe(1);
    expect(Math.abs(m.lufs - -14)).toBeLessThanOrEqual(1);
    expect(row.settings).toMatchObject({ mode: 'talking', aspect: '16:9', music: false, captions: { style: 'clean', format: 'ass' } });
    expect(row.settings.shots[0].inset).toMatchObject({ image: true, w: 0.3 });
    expect(row.settings.shots[1]).toMatchObject({ source: 'footage', fit: 'contain', trimStart: 0.5 });
    expect(row.settings.checks).toMatchObject({ coverage: 1 });
    expect(row.warnings).toEqual([]);
  }, 240_000);

  it('a re-render after a caption-style change creates version 2 and no ledger rows', async () => {
    const ctx = await newProject();
    await grantCredits({ userId: ctx.userId, currency: 'video', amount: 500, bucket: 'topup', reason: 'test', ref: randomUUID() });
    const before = await ledgerRows(ctx.userId);
    const v1 = await renderOnce(ctx);
    await setAudioPlan({ userId: ctx.userId, projectId: ctx.project.id, plan: { captions: { on: true, style: 'bold_pop' } } });
    const v2 = await renderOnce(ctx);
    expect(v1).toMatchObject({ version: 1, status: 'done' });
    expect(v2).toMatchObject({ version: 2, status: 'done' });
    expect(v2.settings.captions.style).toBe('bold_pop');
    expect(v2.storage_key).not.toBe(v1.storage_key);
    expect(await ledgerRows(ctx.userId)).toBe(before);
    const rows = await renders(ctx.project.id);
    expect(rows.map((r) => r.version)).toEqual([1, 2]);
    // No render job carries a hold or a cost.
    const jobs = await storyDb().select('story_jobs', { project_id: ctx.project.id, kind: 'render' });
    expect(jobs).toHaveLength(2);
    for (const j of jobs) expect([j.hold_id, j.cost_credits]).toEqual([null, null]);
  }, 300_000);

  it('never runs two renders of one project at once: a second start is 409 render_busy', async () => {
    const ctx = await newProject();
    const results = await Promise.allSettled([
      startRender({ userId: ctx.userId, projectId: ctx.project.id }),
      startRender({ userId: ctx.userId, projectId: ctx.project.id }),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0].reason).toMatchObject({ status: 409, code: 'render_busy' });
    await expect(startRender({ userId: ctx.userId, projectId: ctx.project.id })).rejects.toMatchObject({ status: 409, code: 'render_busy' });
    expect(await renders(ctx.project.id)).toHaveLength(1);
    const jobs = await storyDb().select('story_jobs', { project_id: ctx.project.id, kind: 'render' });
    expect(jobs).toHaveLength(1);
  });

  it('refuses while a shot has no clip, and for someone else\'s project', async () => {
    const ctx = await newProject({ ready: false });
    await expect(startRender({ userId: ctx.userId, projectId: ctx.project.id })).rejects.toMatchObject({ status: 409, code: 'shots_not_ready' });
    const other = await newProject();
    await expect(startRender({ userId: ctx.userId, projectId: other.project.id })).rejects.toMatchObject({ status: 404 });
    expect(await renders(ctx.project.id)).toHaveLength(0);
  });

  it('needs a paid plan', async () => {
    const ctx = await newProject();
    accounts.set({ paid: false });
    await expect(startRender({ userId: ctx.userId, projectId: ctx.project.id })).rejects.toMatchObject({ status: 402, code: 'plan_required' });
  });

  it('F3: a killed render is failed by the sweep after 330 s, never run a second time, and the row says so', async () => {
    const ctx = await newProject();
    const { render } = await startRender({ userId: ctx.userId, projectId: ctx.project.id });
    const [job] = await storyDb().select('story_jobs', { project_id: ctx.project.id, kind: 'render' });
    // The worker claimed it 5 minutes ago (inside its 330 s): the sweep leaves it alone.
    const recent = new Date(Date.now() - 300_000).toISOString();
    await raw.query(`update story_jobs set status = 'running', attempts = 1, started_at = $2, locked_until = $2 where id = $1`, [job.id, recent]);
    await raw.query(`update story_renders set status = 'running' where id = $1`, [render.id]);
    await sweep({});
    expect((await storyDb().select('story_jobs', { id: job.id }))[0].status).toBe('running');
    // Past 330 s the worker is gone: failed at once, not queued again.
    const gone = new Date(Date.now() - 340_000).toISOString();
    await raw.query(`update story_jobs set started_at = $2, locked_until = $2 where id = $1`, [job.id, gone]);
    await sweep({});
    await sweep({});
    expect((await storyDb().select('story_jobs', { id: job.id }))[0]).toMatchObject({ status: 'failed', attempts: 1 });
    const [row] = await storyDb().select('story_renders', { id: render.id });
    expect(row.status).toBe('failed');
    expect(row.error).toBe('The render stopped. Try again.');
    // A failed render frees the project for the next one.
    const next = await startRender({ userId: ctx.userId, projectId: ctx.project.id });
    expect(next.render.version).toBe(2);
  });

  it('a job whose render row already ended is not rendered (the row stays as it is)', async () => {
    const ctx = await newProject();
    const { render } = await startRender({ userId: ctx.userId, projectId: ctx.project.id });
    await raw.query(`update story_renders set status = 'failed', error = 'stopped' where id = $1`, [render.id]);
    const out = await runWorkerJob('render', {});
    expect(out).toMatchObject({ claimed: true, outcome: 'done' });
    const [row] = await storyDb().select('story_renders', { id: render.id });
    expect(row).toMatchObject({ status: 'failed', error: 'stopped', file_url: null, storage_key: null });
    // Nothing was rendered or stored for it.
    expect(existsSync(mockStoragePath(`story/${ctx.project.id}/render`))).toBe(false);
  });

  it('keeps the upload\'s time: the transcription gets only what is left before the deadline, less the upload reserve', async () => {
    const ctx = await newProject();
    await startRender({ userId: ctx.userId, projectId: ctx.project.id });
    const deadline = Date.now() + 150_000;
    const out = await runWorkerJob('render', { deadline });
    expect(out).toMatchObject({ claimed: true, outcome: 'done' });
    expect(transcribe).toHaveBeenCalledTimes(1);
    const { timeoutMs } = transcribe.mock.calls[0][0];
    expect(timeoutMs).toBeGreaterThan(0);
    expect(timeoutMs).toBeLessThanOrEqual(150_000 - 40_000);
  }, 240_000);

  it('with too little time left, the words are not checked and the mix is not made again', async () => {
    const ctx = await newProject({ music: false });
    _configureRender({ uploadReserveMs: 1_000_000 });
    const row = await renderOnce(ctx);
    expect(transcribe).not.toHaveBeenCalled();
    expect(row.status).toBe('done');
    expect(row.warnings.map((w) => w.code)).toContain('words_unchecked');
    expect(row.settings.checks.retried).toBe(false);
  }, 240_000);

  it('O4: without the ass filter the captions are drawn as PNG overlays, in the band', async () => {
    const plain = await renderOnce(await newProject({ style: 'bold_pop', captions: false }));
    captionFilterAvailable.mockResolvedValueOnce(false);
    const row = await renderOnce(await newProject({ style: 'bold_pop' }));
    expect(row.status).toBe('done');
    expect(row.settings.captions.format).toBe('png');
    expect(row.warnings.map((w) => w.code)).not.toContain('captions_missing');
    // At 1 s a caption is on screen: the band around y 1250 has the white text the same video without captions lacks.
    const band = (file) => {
      const r = spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-ss', '1', '-i', file, '-frames:v', '1', '-vf', 'crop=1080:300:0:1100,format=gray', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
      return r.stdout;
    };
    const png = band(localPathFor(row.file_url));
    const none = band(localPathFor(plain.file_url));
    const bright = (buf) => buf.reduce((n, v) => n + (v > 235 ? 1 : 0), 0);
    expect(bright(png) - bright(none)).toBeGreaterThan(500);
  }, 240_000);

  it('Fm3: characters the caption font does not have are a warning', async () => {
    const ctx = await newProject();
    const segments = NARRATIONS.fill.map((x, i) => (i === 0 ? { ...x, text: 'Once upon 你好 time,' } : x));
    await storyDb().update('story_projects', { id: ctx.project.id }, { narration_segments: segments });
    const row = await renderOnce(ctx);
    const w = row.warnings.find((x) => x.code === 'captions_missing');
    expect(w.message).toContain('你');
  }, 240_000);

  it('POST /render starts it through the action route, and /status shows the render', async () => {
    const ctx = await newProject();
    globalThis.__renderTestSession = { user: { id: ctx.userId, email: 'test@example.test' } };
    const { default: handler } = await import('../../pages/api/story/projects/[id]/[action].js');
    const req = makeReq({ method: 'POST', query: { id: ctx.project.id, action: 'render' }, body: {} });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.render).toMatchObject({ version: 1, status: 'queued' });
    const status = await getProjectStatus({ userId: ctx.userId, projectId: ctx.project.id });
    expect(status.render).toMatchObject({ id: res.body.render.id, status: 'queued', version: 1 });
    expect(status.renders.map((r) => r.version)).toEqual([1]);
    // Fm4: a public shape, never job ids, storage keys or the frozen settings.
    expect(Object.keys(status.render).sort()).toEqual(['created_at', 'error', 'finished_at', 'id', 'status', 'url', 'version', 'warnings']);
    expect(Object.keys(res.body.render).sort()).toEqual(['created_at', 'error', 'finished_at', 'id', 'status', 'url', 'version', 'warnings']);
  });
});

describe('render worker route', () => {
  it('needs the cron secret, and claims one render per invocation', async () => {
    vi.stubEnv('CRON_SECRET', 'render-secret');
    try {
      const { default: route, config } = await import('../../pages/api/story/render-worker.js');
      expect(config).toMatchObject({ maxDuration: 300 });
      const res = makeRes();
      await route(makeReq({ method: 'POST', headers: { authorization: 'Bearer nope' } }), res);
      expect(res.statusCode).toBe(401);
      const a = await newProject();
      const b = await newProject();
      await startRender({ userId: a.userId, projectId: a.project.id });
      await startRender({ userId: b.userId, projectId: b.project.id });
      const ok = makeRes();
      await route(makeReq({ method: 'POST', headers: { authorization: 'Bearer render-secret' } }), ok);
      expect(ok.statusCode).toBe(200);
      expect(ok.body).toMatchObject({ ok: true, render: 1 });
      const left = await storyDb().select('story_jobs', { kind: 'render', status: 'queued', project_id: [a.project.id, b.project.id] });
      expect(left).toHaveLength(1);
    } finally {
      vi.unstubAllEnvs();
      vi.stubEnv('STORY_MOCK', '1');
      vi.stubEnv('ANTHROPIC_API_KEY', '');
    }
  }, 240_000);
});

describe('checks', () => {
  it('counts the script words found in the transcript', () => {
    expect(scriptWordsOf(SCENES, 'narrated')).toEqual(['once', 'upon', 'a', 'time', 'a', 'baker', 'dreamed', 'big']);
    expect(wordCoverage(['once', 'upon', 'a', 'time'], [{ w: 'Once' }, { w: 'upon' }, { w: 'a' }, { w: 'TIME,' }])).toBe(1);
    expect(wordCoverage(['a', 'a', 'b', 'c'], [{ w: 'a' }, { w: 'b' }])).toBe(0.5);
  });

  it('reports a silence over 0.6 s, low word coverage and loudness out of range', async () => {
    const out = await runChecks({ renderPath: path.join(dir, 'gap.wav'), voicePath: path.join(dir, 'gap.wav'), scriptWords: ['the', 'quick', 'brown', 'fox'] });
    expect(out.ok).toBe(false);
    const codes = out.failures.map((f) => f.code).sort();
    expect(codes).toEqual(['loudness', 'silence', 'words']);
    expect(out.measures.longestSilence).toBeGreaterThan(0.6);
  }, 60_000);

  it('target sizes follow the aspect', () => {
    expect(renderTargetSize('9:16')).toEqual([1080, 1920]);
    expect(renderTargetSize('1:1')).toEqual([1080, 1080]);
    expect(renderTargetSize('16:9')).toEqual([1920, 1080]);
  });
});

describe('round 1', () => {
  const codes = (row) => row.warnings.map((w) => w.code);

  it('O2: a gap in the voice fails the silence check even under music', async () => {
    const row = await renderOnce(await newProject({ narration: 'short' }));
    expect(row.status).toBe('done');
    expect(codes(row)).toContain('silence');
    expect(row.settings.checks.longestSilence).toBeGreaterThan(3);
  }, 240_000);

  it('O1: a scene whose narration does not fit is sped up to 1.15 and then runs on, with a warning, never cut silently', async () => {
    const row = await renderOnce(await newProject({ narration: 'long' }));
    expect(row.status).toBe('done');
    const s2 = row.settings.narrationPlan.find((p) => p.sceneId === 's2');
    expect(s2.tempo).toBeCloseTo(1.15, 6);
    expect(codes(row)).toContain('narration_overrun');
    expect(row.warnings.find((w) => w.code === 'narration_overrun').message).toMatch(/Dream/);
  }, 240_000);

  it('Om4 and Om5: the script words are frozen at start, and a transcript that does not match is a words warning (re-heard once under music)', async () => {
    const ctx = await newProject();
    const { render } = await startRender({ userId: ctx.userId, projectId: ctx.project.id });
    expect(render).toBeTruthy();
    // The script changes after the start: the render still checks the words it was started with.
    await storyDb().insert('story_scripts', { project_id: ctx.project.id, version: 2, scenes: [{ id: 's1', title: 'x', visual: 'y', lines: [{ speaker: 'narrator', text: 'Completely different words here' }] }], source: 'brief' });
    transcribe.mockResolvedValueOnce({ text: 'nothing alike', words: [{ w: 'nothing', start: 0, end: 1 }, { w: 'alike', start: 1, end: 2 }] });
    await runWorkerJob('render', {});
    const [row] = await storyDb().select('story_renders', { id: render.id });
    expect(row.settings.scriptWords).toEqual(['once', 'upon', 'a', 'time', 'a', 'baker', 'dreamed', 'big']);
    // First hearing failed on words with music to lower: the mix is made again and heard again (the mock now matches).
    expect(transcribe).toHaveBeenCalledTimes(2);
    expect(row.settings.checks).toMatchObject({ retried: true, coverage: 1 });
    // Without music there is nothing to change: heard once, saved as a warning.
    const quiet = await newProject({ music: false });
    transcribe.mockClear();
    transcribe.mockResolvedValueOnce({ text: 'nothing alike', words: [{ w: 'nothing', start: 0, end: 1 }] });
    const row2 = await renderOnce(quiet);
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(codes(row2)).toContain('words');
    expect(row2.settings.checks.retried).toBe(false);
  }, 300_000);

  it('Om5: a talking line cut off by its shot (the clip speaks past the shot) is a warning', async () => {
    const userId = randomUUID();
    const [project] = await storyDb().insert('story_projects', {
      user_id: userId, title: 'Talking', style: '3d_family', step: 'review', seconds: 15, quality: 'pro_talking', mode: 'talking', aspect: '9:16',
      audio_plan: { captions: { on: true, style: 'clean' }, music: { type: 'none', prompt: '', assetId: null } },
    });
    await storyDb().insert('story_scripts', { project_id: project.id, version: 1, scenes: SCENES, source: 'brief' });
    // c1 speaks for 4 s; its shot is 3 s (an economy clip made at 4 s for a 3 s shot).
    await storyDb().insert('story_shots', [
      { project_id: project.id, ord: 0, scene_id: 's1', seconds: 3, quality: 'pro_talking', source: 'generated', status: 'ready', clip_url: media.c1.url, clip_key: media.c1.key, line: 'Once upon a time,' },
      { project_id: project.id, ord: 1, scene_id: 's2', seconds: 3, quality: 'pro_talking', source: 'generated', status: 'ready', clip_url: media.tk1.url, clip_key: media.tk1.key, line: 'a baker dreamed big.' },
    ]);
    const row = await renderOnce({ userId, project });
    const cut = row.warnings.filter((w) => w.code === 'line_cut');
    expect(cut).toHaveLength(1);
    expect(cut[0].message).toMatch(/shot 1/);
  }, 240_000);

  it('F1: no render while the voice or music is missing or still being made', async () => {
    const queued = await newProject();
    await enqueue({ projectId: queued.project.id, kind: 'narration', payload: {} });
    await expect(startRender({ userId: queued.userId, projectId: queued.project.id })).rejects.toMatchObject({ status: 409, code: 'audio_not_ready' });

    const noVoice = await newProject();
    await storyDb().update('story_projects', { id: noVoice.project.id }, { narration_url: null, narration_key: null, narration_segments: null });
    await expect(startRender({ userId: noVoice.userId, projectId: noVoice.project.id })).rejects.toMatchObject({ status: 409, code: 'audio_not_ready' });

    const noMusic = await newProject();
    await storyDb().update('story_projects', { id: noMusic.project.id }, { music_url: null, music_key: null });
    await expect(startRender({ userId: noMusic.userId, projectId: noMusic.project.id })).rejects.toMatchObject({ status: 409, code: 'audio_not_ready' });
    expect(await renders(noMusic.project.id)).toHaveLength(0);
  });

  it('F3: /status ends a queued render that a dead request left with no job', async () => {
    const ctx = await newProject();
    const [row] = await storyDb().insert('story_renders', { project_id: ctx.project.id, version: 1, status: 'queued', settings: {} });
    await raw.query(`update story_renders set created_at = now() - interval '1 minute' where id = $1`, [row.id]);
    const status = await getProjectStatus({ userId: ctx.userId, projectId: ctx.project.id });
    expect(status.render).toMatchObject({ id: row.id, status: 'failed' });
  });

  it('O6: music shorter than the video is looped to the end', async () => {
    const ctx = await newProject({ musicFile: 'music5', narration: 'fill' });
    const row = await renderOnce(ctx);
    // The last second of the final mix still has the music under it (it plays from 11 to 12 s with no voice).
    const r = spawnSync(FF, ['-hide_banner', '-nostats', '-ss', '11.6', '-i', localPathFor(row.file_url), '-vn', '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
    const mean = Number(/mean_volume:\s*(-?[\d.]+)/.exec(r.stderr)[1]);
    expect(mean).toBeGreaterThan(-60);
    expect(row.settings.music).toBe(true);
  }, 240_000);

  it('Om3 and Fm5: footage is fitted by default, a trim past its end is clamped, and an inset that is not a picture or clip is refused', async () => {
    const ctx = await newProject();
    const [footage, voice] = await storyDb().insert('story_assets', [
      { user_id: ctx.userId, kind: 'video_clip', url: media.c4.url, storage_key: media.c4.key, name: 'mine' },
      { user_id: ctx.userId, kind: 'voice_track', url: media.short.url, storage_key: media.short.key, name: 'voice', mime: 'audio/wav' },
    ]);
    await storyDb().update('story_shots', { id: ctx.shots[1].id }, { source: 'footage', footage_asset_id: footage.id, footage: { trimStart: 30 } });
    const row = await renderOnce(ctx);
    expect(row.status).toBe('done');
    expect(row.settings.shots[1]).toMatchObject({ source: 'footage', fit: 'contain', trimStart: 30 });
    const m = measure(localPathFor(row.file_url));
    expect(Math.abs(m.duration - 12)).toBeLessThanOrEqual(0.1);

    await storyDb().update('story_shots', { id: ctx.shots[2].id }, { inset_asset_id: voice.id });
    await expect(startRender({ userId: ctx.userId, projectId: ctx.project.id })).rejects.toMatchObject({ status: 422 });
  }, 240_000);

  it('Fm9: a frozen file that is gone at run time fails cleanly', async () => {
    const ctx = await newProject();
    const { render } = await startRender({ userId: ctx.userId, projectId: ctx.project.id });
    const settings = (await storyDb().select('story_renders', { id: render.id }))[0].settings;
    settings.shots[0].url = '/api/mock/storage/story/gone/missing.mp4';
    await storyDb().update('story_renders', { id: render.id }, { settings });
    await runWorkerJob('render', {});
    const [row] = await storyDb().select('story_renders', { id: render.id });
    expect(row).toMatchObject({ status: 'failed', error: 'Something changed while the video was being made. Make it again.' });
  });

  it('F4: a failed upload is tried once more inside the run, so the checked file is not thrown away', async () => {
    const ctx = await newProject();
    globalThis.__putFailures = 1;
    try {
      const row = await renderOnce(ctx);
      expect(row.status).toBe('done');
      expect(transcribe).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.__putFailures = 0;
    }
  }, 240_000);

  it('F2: old render work dirs left by killed runs are removed at the start of a run', async () => {
    const stale = path.join(os.tmpdir(), `story-render-stale-${randomUUID()}`);
    mkdirSync(stale);
    const old = (Date.now() - 20 * 60_000) / 1000;
    utimesSync(stale, old, old);
    await renderOnce(await newProject());
    expect(existsSync(stale)).toBe(false);
  }, 240_000);

  it('T24: a playlist dressed as an mp3 voice track is never followed: the render fails cleanly', async () => {
    const ctx = await newProject();
    // ID3 header, then an HLS playlist pointing at a local file (a way to read other files on the machine).
    const target = path.join(dir, 'secret.wav');
    ff(['-f', 'lavfi', '-i', 'sine=f=440:d=3', target]);
    const body = Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0]), Buffer.from(`#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:3,\nfile://${target}\n#EXT-X-ENDLIST\n`)]);
    const stored = await putObject({ key: `test-fixtures/${randomUUID()}.mp3`, body });
    const [asset] = await storyDb().insert('story_assets', { user_id: ctx.userId, kind: 'voice_track', url: stored.url, storage_key: stored.key, name: 'mine', mime: 'audio/mpeg' });
    await storyDb().update('story_projects', { id: ctx.project.id }, {
      narration_url: asset.url, narration_key: null, narration_segments: null,
      audio_plan: { captions: { on: true, style: 'clean' }, music: { type: 'generated', prompt: '', assetId: null }, voiceTrackAssetId: asset.id },
    });
    const { render } = await startRender({ userId: ctx.userId, projectId: ctx.project.id });
    await runWorkerJob('render', {});
    const [row] = await storyDb().select('story_renders', { id: render.id });
    expect(row.status).toBe('failed');
    expect(row.error).toBe('Your voice recording could not be read. Upload it again as an mp3, wav or m4a file.');
  }, 240_000);
});
