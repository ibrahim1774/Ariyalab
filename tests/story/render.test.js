// Task 20: the finished video. Renders real mp4s from ffmpeg-made fixtures (mock storage, mock transcription).
import { titleSlug } from '../../lib/story/filenames.js';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { useRegexOnlyModeration, useTestAccounts } from '../helpers/storyEnv.js';
import { makeReq, makeRes } from '../helpers/apiMock.js';
import { setStoryDb, storyDb } from '../../lib/story/db.js';
import { setCreditsDb, grantCredits, getBalance } from '../../lib/credits.js';
import { setPricingDb, _resetPricingCache } from '../../lib/pricing.js';
import { putObject, localPathFor, mockStoragePath } from '../../lib/providers/storage.js';
import { transcribe } from '../../lib/providers/stt.js';
import { runWorkerJob, sweep, enqueue } from '../../lib/story/runner.js';
import { KINDS_REGISTERED_LATER } from '../../lib/story/handlers.js';
import { setAudioPlan, checkedAudioExt } from '../../lib/story/audio.js';
import { startRender, renderTargetSize, _configureRender, planNarration, CLIP_BED_DB } from '../../lib/story/render.js';
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
  return {
    ...real,
    captionFilterAvailable: vi.fn(real.captionFilterAvailable),
    captionPngs: vi.fn(async (args) => {
      if (globalThis.__pngCalls !== undefined) {
        globalThis.__pngCalls += 1;
        if (globalThis.__pngCalls > 1) throw new Error('no text support');
      }
      return real.captionPngs(args);
    }),
  };
});
// Every ffmpeg call the render makes, to see how each input is opened.
vi.mock('../../lib/story/checks.js', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    runFfmpeg: vi.fn(async (args, opts) => {
      (globalThis.__ffCalls ||= []).push(args);
      return real.runFfmpeg(args, opts);
    }),
  };
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
  // A clip with a sound track that is silent (a model clip with no sound, or a customer's footage).
  ff([
    '-f', 'lavfi', '-i', 'testsrc2=size=540x960:rate=24:duration=4',
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono',
    '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', 'quiet.mp4',
  ]);
  // Narration tracks: two "lines" of tone (s1, s2) with a 0.3 s breath between.
  const narration = (name, a, b) => ff([
    '-filter_complex',
    `sine=f=220:d=${a},volume=0.5,adelay=200|200,apad=pad_dur=0.3[a];sine=f=260:d=${b},volume=0.5[b];[a][b]concat=n=2:v=0:a=1,apad=pad_dur=0.5[out]`,
    '-map', '[out]', '-ac', '1', '-ar', '44100', name,
  ]);
  narration('narration.wav', 5.7, 5.5); // each line fills its scene (6 s of shots)
  narration('short.wav', 2.2, 2.7); // short lines: the voice has a long gap once placed at the scenes
  narration('long.wav', 5.7, 8); // s2 is longer than its 6 s even sped up
  // s1's line has a 1 s pause inside it (2.5 s, 1 s of silence, 2.2 s): a gap inside one speech span.
  ff([
    '-filter_complex',
    'sine=f=220:d=2.5,volume=0.5,adelay=200|200[a];anullsrc=r=44100:cl=mono,atrim=0:1[g];sine=f=220:d=2.2,volume=0.5,apad=pad_dur=0.3[b];sine=f=260:d=5.5,volume=0.5,apad=pad_dur=0.5[c];[a][g][b][c]concat=n=4:v=0:a=1[out]',
    '-map', '[out]', '-ac', '1', '-ar', '44100', 'gappy.wav',
  ]);
  // A talking clip whose speech (0.4 to 3.8 s) runs past a 3 s shot.
  ff([
    '-f', 'lavfi', '-i', 'testsrc2=size=540x960:rate=24:duration=4',
    '-f', 'lavfi', '-i', "sine=f=300:d=4,volume='between(t,0.4,3.8)':eval=frame",
    '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', 'tk2.mp4',
  ]);
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
  for (const n of ['c1', 'c2', 'c3', 'c4', 'quiet', 'tk1', 'tk2']) media[n] = await store(`${n}.mp4`, 'mp4');
  media.narration = await store('narration.wav', 'wav');
  media.short = await store('short.wav', 'wav');
  media.long = await store('long.wav', 'wav');
  media.gappy = await store('gappy.wav', 'wav');
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
// A talking video whose characters speak every line: nobody to narrate.
const TALK_SCENES = [
  { id: 's1', title: 'Morning', visual: 'A small bakery at dawn.', lines: [{ speaker: 'Maya', text: 'Once upon a time,' }] },
  { id: 's2', title: 'Dream', visual: 'The baker looks out of the window.', lines: [{ speaker: 'Leo', text: 'a baker dreamed big.' }] },
];
// A talking video with a narrator who opens it and a character in the second scene.
const MIXED_SCENES = [
  { id: 's1', title: 'Morning', visual: 'A small bakery at dawn.', lines: [{ speaker: 'narrator', text: 'Once upon a time,' }] },
  { id: 's2', title: 'Dream', visual: 'The baker looks out of the window.', lines: [{ speaker: 'Maya', text: 'a baker dreamed big.' }] },
];
const segs = (a, b) => [
  { sceneId: 's1', lineIndex: 0, text: 'Once upon a time,', start: 0.2, end: 0.2 + a },
  { sceneId: 's2', lineIndex: 1, text: 'a baker dreamed big.', start: 0.5 + a, end: 0.5 + a + b },
];
const NARRATIONS = { fill: segs(5.7, 5.5), short: segs(2.2, 2.7), long: segs(5.7, 8), gappy: segs(5.7, 5.5) };
const SEGMENTS = NARRATIONS.fill;

async function newProject({ style = 'serif_accent', captions = true, music = true, clips = ['c1', 'c2', 'c3', 'c4'], ready = true, narration = 'fill', musicFile = 'music' } = {}) {
  const userId = randomUUID();
  const track = { fill: media.narration, short: media.short, long: media.long, gappy: media.gappy }[narration];
  const [project] = await storyDb().insert('story_projects', {
    fee_charged: true,
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
    expect(row.storage_key).toMatch(new RegExp(`^story/${ctx.project.id}/render/[0-9a-f-]{36}/[a-z0-9-]+-v1\\.mp4$`));
    expect(row.storage_key.split('/').pop()).toBe(`${titleSlug(ctx.project.title)}-v1.mp4`);
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
    fee_charged: true,
      user_id: userId, title: 'Talking', style: '3d_family', step: 'review', seconds: 15, quality: 'pro_talking', mode: 'talking', aspect: '16:9',
      audio_plan: { captions: { on: true, style: 'clean' }, music: { type: 'none', prompt: '', assetId: null } },
    });
    await storyDb().insert('story_scripts', { project_id: project.id, version: 1, scenes: TALK_SCENES, source: 'brief' });
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

  it('a re-render after a caption-style change creates version 2: the first is included, the second spends exactly 5', async () => {
    const ctx = await newProject();
    await grantCredits({ userId: ctx.userId, currency: 'video', amount: 500, bucket: 'topup', reason: 'test', ref: randomUUID() });
    const before = await ledgerRows(ctx.userId);
    const v1 = await renderOnce(ctx);
    expect(await ledgerRows(ctx.userId)).toBe(before);
    expect((await getBalance(ctx.userId, 'video')).available).toBe(500);
    await setAudioPlan({ userId: ctx.userId, projectId: ctx.project.id, plan: { captions: { on: true, style: 'bold_pop' } } });
    const v2 = await renderOnce(ctx);
    expect(v1).toMatchObject({ version: 1, status: 'done' });
    expect(v2).toMatchObject({ version: 2, status: 'done' });
    expect(v2.settings.captions.style).toBe('bold_pop');
    expect(v2.storage_key).not.toBe(v1.storage_key);
    // Owner decision 2026-11-16: the second render was held at start and settled when it was stored.
    const after = await getBalance(ctx.userId, 'video');
    expect(after.available).toBe(495);
    expect(after.held).toBe(0);
    const rows = await renders(ctx.project.id);
    expect(rows.map((r) => r.version)).toEqual([1, 2]);
    expect(rows.map((r) => r.cost_credits)).toEqual([0, 5]);
    const jobs = await storyDb().select('story_jobs', { project_id: ctx.project.id, kind: 'render' }, { order: 'created_at' });
    expect(jobs).toHaveLength(2);
    expect([jobs[0].hold_id, jobs[0].cost_credits]).toEqual([null, null]);
    expect([jobs[1].hold_id, jobs[1].cost_credits]).toEqual([rows[1].hold_id, 5]);
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
    expect(Object.keys(status.render).sort()).toEqual(['created_at', 'duration_seconds', 'error', 'finished_at', 'id', 'status', 'url', 'version', 'warnings']);
    expect(Object.keys(res.body.render).sort()).toEqual(['created_at', 'duration_seconds', 'error', 'finished_at', 'id', 'status', 'url', 'version', 'warnings']);
  });
});

describe('final review I5: per-project render cap (rolling 24 h)', () => {
  async function pastRenders(projectId, list) {
    let v = 0;
    for (const { status, hoursAgo } of list) {
      v += 1;
      await raw.query(
        `insert into story_renders (project_id, version, status, created_at) values ($1, $2, $3, now() - make_interval(secs => $4))`,
        [projectId, v, status, hoursAgo * 3600],
      );
    }
  }
  // Past renders that finished make the next one paid (owner decision 2026-11-16): the account has credits for it.
  const refusal = async (ctx) => {
    await grantCredits({ userId: ctx.userId, currency: 'video', amount: 50, bucket: 'topup', reason: 'test', ref: randomUUID() });
    return startRender({ userId: ctx.userId, projectId: ctx.project.id }).then(() => null, (e) => e);
  };

  it('refuses the 11th render of a project inside 24 hours with a clear 429 message', async () => {
    const ctx = await newProject();
    await pastRenders(ctx.project.id, Array.from({ length: 10 }, (_, i) => ({ status: 'done', hoursAgo: 1 + i })));
    const err = await refusal(ctx);
    expect(err).toBeTruthy();
    expect(err).toMatchObject({ status: 429, code: 'daily_limit', extra: { action: 'render', limit: 10 } });
    expect(err.message).toMatch(/10 times in the last 24 hours/);
    expect(await renders(ctx.project.id)).toHaveLength(10);
  });

  it('a failed render gives its count back, and renders older than 24 hours no longer count', async () => {
    const failedBack = await newProject();
    await pastRenders(failedBack.project.id, [
      ...Array.from({ length: 9 }, () => ({ status: 'done', hoursAgo: 2 })),
      ...Array.from({ length: 3 }, () => ({ status: 'failed', hoursAgo: 1 })),
    ]);
    expect(await refusal(failedBack)).toBeNull();
    const rolled = await newProject();
    await pastRenders(rolled.project.id, [
      ...Array.from({ length: 9 }, () => ({ status: 'done', hoursAgo: 25 })),
      { status: 'done', hoursAgo: 23 },
    ]);
    expect(await refusal(rolled)).toBeNull();
  });

  it('the cap is read from pricing_config free_limits.rendersPerProjectPer24h', async () => {
    await raw.query(`insert into pricing_config (key, value) values ('free_limits', '{"rendersPerProjectPer24h": 2}'::jsonb)
                     on conflict (key) do update set value = excluded.value`);
    _resetPricingCache();
    try {
      const ctx = await newProject();
      await pastRenders(ctx.project.id, [{ status: 'done', hoursAgo: 3 }, { status: 'done', hoursAgo: 2 }]);
      expect(await refusal(ctx)).toMatchObject({ status: 429, code: 'daily_limit', extra: { limit: 2 } });
    } finally {
      await raw.query(`delete from pricing_config where key = 'free_limits'`);
      _resetPricingCache();
    }
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

  it('N1: a pause inside a line fails the silence check even under music', async () => {
    const row = await renderOnce(await newProject({ narration: 'gappy' }));
    expect(row.status).toBe('done');
    expect(codes(row)).toContain('silence');
    expect(row.settings.checks.longestSilence).toBeGreaterThan(0.6);
  }, 240_000);

  it('N1: a gap between scenes is fine under music, and fails only when the whole mix is silent there', async () => {
    const withMusic = await renderOnce(await newProject({ narration: 'short' }));
    expect(codes(withMusic)).not.toContain('silence');
    // R2: the long pause after the scene's line is said instead (no remix).
    const gaps = withMusic.warnings.filter((w) => w.code === 'narration_gap').map((w) => w.message);
    expect(gaps).toContain('The narration for "Morning" ends well before its shots do, so there is a long pause. Lengthen the line or shorten the shots.');
    // Dead air needs clips with no sound of their own: a clip's own sound now fills a pause.
    const bare = await renderOnce(await newProject({ narration: 'short', music: false, clips: ['quiet', 'quiet', 'quiet', 'quiet'] }));
    expect(codes(bare)).toContain('silence');
    expect(bare.settings.checks.longestSilence).toBeGreaterThan(3);
  }, 240_000);

  it('O1: a scene whose narration does not fit is sped up to 1.15 and then runs on, with a warning, never cut silently', async () => {
    const row = await renderOnce(await newProject({ narration: 'long' }));
    expect(row.status).toBe('done');
    const s2 = row.settings.narrationPlan.find((p) => p.sceneId === 's2');
    expect(s2.tempo).toBeCloseTo(1.15, 6);
    expect(codes(row)).toContain('narration_overrun');
    expect(row.warnings.find((w) => w.code === 'narration_overrun').message).toMatch(/Dream/);
    // N3: the speech past the video's end is said too.
    expect(row.warnings.some((w) => w.code === 'narration_overrun' && /last words are cut off/.test(w.message))).toBe(true);
  }, 240_000);

  it('N2: an uncut narration longer than the video is a warning too', async () => {
    const ctx = await newProject({ narration: 'long' });
    // No narrator lines in the script, so the track cannot be cut: it plays from 0 as one stretch.
    await storyDb().insert('story_scripts', { project_id: ctx.project.id, version: 2, scenes: [{ id: 's1', title: 'Morning', visual: 'v', lines: [{ speaker: 'Maya', text: 'Hi.' }] }], source: 'brief' });
    await storyDb().update('story_projects', { id: ctx.project.id }, { narration_segments: null });
    const row = await renderOnce(ctx);
    expect(row.status).toBe('done');
    expect(row.warnings.some((w) => w.code === 'narration_overrun' && /last words are cut off/.test(w.message))).toBe(true);
  }, 240_000);

  it('N4: a scene that starts late because the one before ran on blames that one', () => {
    const { warnings } = planNarration({
      segments: [
        { sceneId: 's1', lineIndex: 0, text: 'a', start: 0, end: 8 },
        { sceneId: 's2', lineIndex: 0, text: 'b', start: 8.3, end: 14.2 },
      ],
      shots: [{ sceneId: 's1', seconds: 6 }, { sceneId: 's2', seconds: 6 }],
      totalSeconds: 12,
      titles: { s1: 'Morning', s2: 'Dream' },
    });
    const messages = warnings.filter((w) => w.code === 'narration_overrun').map((w) => w.message);
    expect(messages[0]).toMatch(/"Morning" is longer than its shots/);
    // Dream would fit its own shots (5.9 s sped up to 5.13 s in 6 s); it only starts late.
    expect(messages[1]).toMatch(/"Morning" runs on/);
    expect(messages[1]).toMatch(/"Dream" starts late/);
  });

  it('N7: our own narration and music are opened as plain files, a customer upload with its forced demuxer', async () => {
    globalThis.__ffCalls = [];
    const row = await renderOnce(await newProject());
    const narr = localPathFor(media.narration.url);
    const opens = globalThis.__ffCalls.filter((a) => a.includes(narr));
    expect(opens.length).toBeGreaterThan(0);
    for (const a of opens) {
      const i = a.indexOf(narr);
      expect(a.slice(Math.max(0, i - 4), i)).toEqual(expect.arrayContaining(['-protocol_whitelist', 'file', '-i']));
      expect(a.slice(Math.max(0, i - 4), i)).not.toContain('-f');
    }
    expect(row.status).toBe('done');
    globalThis.__ffCalls = undefined;
    expect(checkedAudioExt({ mime: 'audio/mpeg' })).toBe('mp3');
    expect(checkedAudioExt({ mime: 'Audio/MPEG' })).toBeNull();
    expect(checkedAudioExt({ mime: 'audio/mpeg; x=1' })).toBeNull();
  }, 240_000);

  it('N5: captions that fail to draw part way are a captions_missing warning', async () => {
    globalThis.__pngCalls = 0;
    try {
      captionFilterAvailable.mockResolvedValueOnce(false);
      const row = await renderOnce(await newProject());
      expect(row.status).toBe('done');
      expect(codes(row)).toContain('captions_missing');
    } finally {
      globalThis.__pngCalls = undefined;
    }
  }, 240_000);

  it('N8: a clip whose sound runs the whole clip (music or ambience) gives no speech window and no line_cut', async () => {
    const userId = randomUUID();
    const [project] = await storyDb().insert('story_projects', {
    fee_charged: true,
      user_id: userId, title: 'Talking', style: '3d_family', step: 'review', seconds: 15, quality: 'pro_talking', mode: 'talking', aspect: '9:16',
      audio_plan: { captions: { on: true, style: 'clean' }, music: { type: 'none', prompt: '', assetId: null } },
    });
    await storyDb().insert('story_scripts', { project_id: project.id, version: 1, scenes: TALK_SCENES, source: 'brief' });
    await storyDb().insert('story_shots', [
      { project_id: project.id, ord: 0, scene_id: 's1', seconds: 3, quality: 'pro_talking', source: 'generated', status: 'ready', clip_url: media.c1.url, clip_key: media.c1.key, line: 'Once upon a time,' },
    ]);
    const row = await renderOnce({ userId, project });
    expect(codes(row)).not.toContain('line_cut');
  }, 240_000);

  it('N9: a playlist dressed as footage is never followed: the render fails cleanly', async () => {
    const ctx = await newProject();
    const target = path.join(dir, 'secret.mp4');
    ff(['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=24:duration=2', '-pix_fmt', 'yuv420p', target]);
    const key = `test-fixtures/${randomUUID()}.mp4`;
    mkdirSync(path.dirname(mockStoragePath(key)), { recursive: true });
    writeFileSync(mockStoragePath(key), `#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:2,\nfile://${target}\n#EXT-X-ENDLIST\n`);
    const [asset] = await storyDb().insert('story_assets', { user_id: ctx.userId, kind: 'video_clip', url: `/api/mock/storage/${key}`, storage_key: key, name: 'mine', mime: 'video/mp4' });
    await storyDb().update('story_shots', { id: ctx.shots[1].id }, { source: 'footage', footage_asset_id: asset.id });
    const { render } = await startRender({ userId: ctx.userId, projectId: ctx.project.id });
    await runWorkerJob('render', {});
    const [row] = await storyDb().select('story_renders', { id: render.id });
    expect(row).toMatchObject({ status: 'failed', error: 'One of your clips has no picture. Pick another clip for that shot.' });
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
    fee_charged: true,
      user_id: userId, title: 'Talking', style: '3d_family', step: 'review', seconds: 15, quality: 'pro_talking', mode: 'talking', aspect: '9:16',
      audio_plan: { captions: { on: true, style: 'clean' }, music: { type: 'none', prompt: '', assetId: null } },
    });
    await storyDb().insert('story_scripts', { project_id: project.id, version: 1, scenes: TALK_SCENES, source: 'brief' });
    // tk2 speaks from 0.4 to 3.8 s; its shot is 3 s (an economy clip made at 4 s for a 3 s shot).
    await storyDb().insert('story_shots', [
      { project_id: project.id, ord: 0, scene_id: 's1', seconds: 3, quality: 'pro_talking', source: 'generated', status: 'ready', clip_url: media.tk2.url, clip_key: media.tk2.key, line: 'Once upon a time,' },
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

describe('round 3', () => {
  const codes = (row) => row.warnings.map((w) => w.code);
  const sliceCalls = () => (globalThis.__ffCalls || []).filter((a) => a.some((x) => String(x).startsWith('silencedetect=noise=-35dB')));

  it('R1: a re-cut of our own narration opens it as a plain file', async () => {
    const ctx = await newProject();
    await storyDb().update('story_projects', { id: ctx.project.id }, { narration_segments: null });
    globalThis.__ffCalls = [];
    try {
      const row = await renderOnce(ctx);
      expect(row.status).toBe('done');
      const narr = localPathFor(media.narration.url);
      const cuts = sliceCalls().filter((a) => a.includes(narr));
      expect(cuts).toHaveLength(1);
      // No forced demuxer before the input (the '-f null' after it is the output).
      expect(cuts[0].slice(0, cuts[0].indexOf('-i'))).not.toContain('-f');
      expect(cuts[0].slice(0, 3)).toEqual(['-protocol_whitelist', 'file', '-i']);
      // The re-cut found both lines, so each scene was placed at its own shots.
      expect(row.settings.narrationPlan.map((g) => g.sceneId)).toEqual(['s1', 's2']);
    } finally {
      globalThis.__ffCalls = undefined;
    }
  }, 240_000);

  it('R1: a re-cut of the customer\'s own recording keeps the forced demuxer', async () => {
    const ctx = await newProject();
    const [asset] = await storyDb().insert('story_assets', { user_id: ctx.userId, kind: 'voice_track', url: media.narration.url, storage_key: media.narration.key, name: 'mine', mime: 'audio/wav' });
    await storyDb().update('story_projects', { id: ctx.project.id }, {
      narration_key: null, narration_segments: null,
      audio_plan: { captions: { on: true, style: 'clean' }, music: { type: 'generated', prompt: '', assetId: null }, voiceTrackAssetId: asset.id },
    });
    globalThis.__ffCalls = [];
    try {
      const row = await renderOnce(ctx);
      expect(row.status).toBe('done');
      const narr = localPathFor(media.narration.url);
      const cuts = sliceCalls().filter((a) => a.includes(narr));
      expect(cuts).toHaveLength(1);
      expect(cuts[0].slice(0, 5)).toEqual(['-protocol_whitelist', 'file', '-f', 'wav', '-i']);
    } finally {
      globalThis.__ffCalls = undefined;
    }
  }, 240_000);

  it('R2: no narration_gap when each line fills its scene', async () => {
    const row = await renderOnce(await newProject());
    expect(codes(row)).not.toContain('narration_gap');
  }, 240_000);

  it('a playlist saved as a .png picture inset fails cleanly, and its segment is never read', async () => {
    const ctx = await newProject();
    const target = path.join(dir, 'secret-inset.ts');
    ff(['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=24:duration=2', '-pix_fmt', 'yuv420p', '-f', 'mpegts', target]);
    const key = `test-fixtures/${randomUUID()}.png`;
    mkdirSync(path.dirname(mockStoragePath(key)), { recursive: true });
    // A playlist whose segment is a real video: opened by content it would play, so only a forced image demuxer refuses it.
    writeFileSync(mockStoragePath(key), `#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:2,\nfile://${target}\n#EXT-X-ENDLIST\n`);
    const [asset] = await storyDb().insert('story_assets', { user_id: ctx.userId, kind: 'product_photo', url: `/api/mock/storage/${key}`, storage_key: key, name: 'pip', mime: 'image/png' });
    await storyDb().update('story_shots', { id: ctx.shots[0].id }, { inset_asset_id: asset.id });
    const { render } = await startRender({ userId: ctx.userId, projectId: ctx.project.id });
    await runWorkerJob('render', {});
    const [row] = await storyDb().select('story_renders', { id: render.id });
    expect(row).toMatchObject({ status: 'failed', error: 'One of your picture-in-picture files could not be read. Pick another file for that shot.' });
  }, 240_000);

  it('a picture inset whose type is only known by its extension is still opened with its own demuxer', async () => {
    const ctx = await newProject();
    const png = readFileSync(path.join(process.cwd(), 'tests/fixtures/still.png'));
    const key = `test-fixtures/${randomUUID()}.png`;
    mkdirSync(path.dirname(mockStoragePath(key)), { recursive: true });
    writeFileSync(mockStoragePath(key), png);
    const [asset] = await storyDb().insert('story_assets', { user_id: ctx.userId, kind: 'logo', url: `/api/mock/storage/${key}`, storage_key: key, name: 'logo' });
    await storyDb().update('story_shots', { id: ctx.shots[0].id }, { inset_asset_id: asset.id, inset: { x: 0.7, y: 0.2, w: 0.3 } });
    const row = await renderOnce(ctx);
    expect(row.status).toBe('done');
    expect(row.settings.shots[0].inset).toMatchObject({ image: true, mime: null, w: 0.3 });
  }, 240_000);

  it('R3 and R4: a playlist saved as an .mp4 video inset fails cleanly, with the inset wording', async () => {
    const ctx = await newProject();
    const target = path.join(dir, 'secret-inset.mp4');
    ff(['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=24:duration=2', '-pix_fmt', 'yuv420p', target]);
    const key = `test-fixtures/${randomUUID()}.mp4`;
    mkdirSync(path.dirname(mockStoragePath(key)), { recursive: true });
    writeFileSync(mockStoragePath(key), `#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:2,\nfile://${target}\n#EXT-X-ENDLIST\n`);
    const [asset] = await storyDb().insert('story_assets', { user_id: ctx.userId, kind: 'video_clip', url: `/api/mock/storage/${key}`, storage_key: key, name: 'pip', mime: 'video/mp4' });
    await storyDb().update('story_shots', { id: ctx.shots[0].id }, { inset_asset_id: asset.id });
    const { render } = await startRender({ userId: ctx.userId, projectId: ctx.project.id });
    await runWorkerJob('render', {});
    const [row] = await storyDb().select('story_renders', { id: render.id });
    expect(row).toMatchObject({ status: 'failed', error: 'One of your picture-in-picture files could not be read. Pick another file for that shot.' });
  }, 240_000);
});

// ---------------------------------------------------------------- sound in both modes

/** Mean level (dB) of a file's audio inside a narrow band around `hz` (-91 when there is nothing). */
function bandLevel(file, hz, { from = 0, length = 60 } = {}) {
  const r = spawnSync(FF, ['-hide_banner', '-nostats', '-ss', String(from), '-t', String(length), '-i', file, '-vn', '-af', `bandpass=f=${hz}:width_type=h:w=10,volumedetect`, '-f', 'null', '-'], { encoding: 'utf8' });
  const m = /mean_volume:\s*(-?\d+(?:\.\d+)?) dB/.exec(r.stderr);
  return m ? Number(m[1]) : -91;
}

async function mixedProject({ narrate = true, music = false } = {}) {
  const userId = randomUUID();
  const [project] = await storyDb().insert('story_projects', {
    fee_charged: true,
    user_id: userId, title: 'Mixed', style: '3d_family', step: 'review', seconds: 15, quality: 'standard', mode: 'talking', aspect: '9:16',
    narration_url: narrate ? media.narration.url : null, narration_key: narrate ? media.narration.key : null, narration_seconds: 2.4,
    narration_segments: narrate ? [{ sceneId: 's1', lineIndex: 0, text: 'Once upon a time,', start: 0.2, end: 2.4 }] : null,
    music_url: music ? media.music.url : null, music_key: music ? media.music.key : null,
    audio_plan: { captions: { on: true, style: 'clean' }, music: { type: music ? 'generated' : 'none', prompt: '', assetId: null } },
  });
  await storyDb().insert('story_scripts', { project_id: project.id, version: 1, scenes: MIXED_SCENES, source: 'brief' });
  await storyDb().insert('story_shots', [
    { project_id: project.id, ord: 0, scene_id: 's1', seconds: 3, quality: 'standard', source: 'generated', status: 'ready', clip_url: media.c1.url, clip_key: media.c1.key, line: 'Once upon a time,' },
    { project_id: project.id, ord: 1, scene_id: 's2', seconds: 3, quality: 'standard', source: 'generated', status: 'ready', clip_url: media.tk1.url, clip_key: media.tk1.key, line: 'a baker dreamed big.' },
  ]);
  return { userId, project };
}

describe('sound in both modes', () => {
  it('a talking video with narrator lines is rendered with the narration; the narrator line is not a character line', async () => {
    const ctx = await mixedProject();
    const row = await renderOnce(ctx);
    expect(row).toMatchObject({ status: 'done', error: null });
    expect(row.settings.mode).toBe('talking');
    expect(row.settings.narrationUrl).toBeTruthy();
    expect(row.settings.lines.map((l) => l.text)).toEqual(['Once upon a time,']);
    expect(row.settings.narrationPlan.map((g) => g.sceneId)).toEqual(['s1']);
    // The narrator's line is voiced by the narration; only the character's line is read from the clip.
    expect(row.settings.shots.map((s) => s.line)).toEqual([null, 'a baker dreamed big.']);
    expect(row.settings.scriptWords).toEqual(['once', 'upon', 'a', 'time', 'a', 'baker', 'dreamed', 'big']);
    expect(row.warnings).toEqual([]);
    const file = localPathFor(row.file_url);
    expect(measure(file).audioStreams).toBe(1);
    // The narration's tone (220 Hz) is in the video, and so is the character's clip (300 Hz).
    expect(bandLevel(file, 220)).toBeGreaterThan(-60);
    expect(bandLevel(file, 300)).toBeGreaterThan(-60);
  }, 240_000);

  it('a talking video with narrator lines needs its narration first (the same not ready message as a narrated one)', async () => {
    const ctx = await mixedProject({ narrate: false });
    await expect(startRender({ userId: ctx.userId, projectId: ctx.project.id })).rejects.toMatchObject({
      status: 409, code: 'audio_not_ready', message: expect.stringMatching(/narration but no voice yet/),
    });
    expect(await renders(ctx.project.id)).toHaveLength(0);
    // Character lines only: nothing to narrate, so it starts.
    const speakers = await mixedProject({ narrate: false });
    await storyDb().update('story_scripts', { project_id: speakers.project.id }, { scenes: TALK_SCENES });
    await expect(startRender({ userId: speakers.userId, projectId: speakers.project.id })).resolves.toMatchObject({ charged: 0 });
  }, 120_000);

  it('a narrated video with no narrator lines and no music keeps the clips\' own sound (it is not replaced by silence)', async () => {
    const userId = randomUUID();
    const [project] = await storyDb().insert('story_projects', {
      fee_charged: true, user_id: userId, title: 'Ambience', style: '3d_family', step: 'review', seconds: 15, quality: 'standard', mode: 'narrated', aspect: '9:16',
      audio_plan: { captions: { on: false, style: 'clean' }, music: { type: 'none', prompt: '', assetId: null } },
    });
    await storyDb().insert('story_scripts', { project_id: project.id, version: 1, scenes: [{ id: 's1', title: 'T', visual: 'v', lines: [] }], source: 'brief' });
    await storyDb().insert('story_shots', [
      { project_id: project.id, ord: 0, scene_id: 's1', seconds: 3, quality: 'standard', source: 'generated', status: 'ready', clip_url: media.c1.url, clip_key: media.c1.key },
      { project_id: project.id, ord: 1, scene_id: 's1', seconds: 3, quality: 'standard', source: 'generated', status: 'ready', clip_url: media.c3.url, clip_key: media.c3.key },
    ]);
    const row = await renderOnce({ userId, project });
    expect(row.status).toBe('done');
    const file = localPathFor(row.file_url);
    expect(bandLevel(file, 300)).toBeGreaterThan(-45);
    expect(Math.abs(measure(file).lufs - -14)).toBeLessThanOrEqual(1);
  }, 240_000);

  it('a narrated video keeps the clip sound with the narration: heard in the pauses between the narrator\'s scenes, at the bed level', async () => {
    const ctx = await newProject({ music: false, narration: 'short' });
    const row = await renderOnce(ctx);
    const file = localPathFor(row.file_url);
    // short.wav is spoken at 0 to 2.4 s and 6 to 8.7 s; 3.2 to 5.4 s is the clips' own sound alone.
    expect(bandLevel(file, 300, { from: 3.2, length: 2.2 })).toBeGreaterThan(-45);
    expect(bandLevel(file, 220, { from: 0.4, length: 1.8 })).toBeGreaterThan(-45);
    expect(CLIP_BED_DB).toBeLessThan(0);
  }, 240_000);

  it('checks count every voiced line: narrator lines and character lines in a talking video, narrator lines only in a narrated one', () => {
    expect(scriptWordsOf(MIXED_SCENES, 'talking')).toEqual(['once', 'upon', 'a', 'time', 'a', 'baker', 'dreamed', 'big']);
    expect(scriptWordsOf(SCENES, 'narrated')).toEqual(['once', 'upon', 'a', 'time', 'a', 'baker', 'dreamed', 'big']);
    expect(scriptWordsOf(MIXED_SCENES, 'narrated')).toEqual(['once', 'upon', 'a', 'time']);
  });
});
