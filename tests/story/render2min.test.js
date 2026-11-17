// A 2 minute (120 s) video renders in mock mode inside the render worker's window: 40 shots of 3 seconds,
// narration over every scene, captions and music, from a tiny fixture clip. Temp files are small and removed.
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { useRegexOnlyModeration, useTestAccounts } from '../helpers/storyEnv.js';
import { setStoryDb, storyDb } from '../../lib/story/db.js';
import { setCreditsDb } from '../../lib/credits.js';
import { setPricingDb, _resetPricingCache } from '../../lib/pricing.js';
import { putObject, localPathFor } from '../../lib/providers/storage.js';
import { runWorkerJob } from '../../lib/story/runner.js';
import { startRender } from '../../lib/story/render.js';

vi.mock('../../lib/supabaseServer.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getUserFromRequest: vi.fn(async () => null),
}));

useRegexOnlyModeration();
useTestAccounts();

const FF = ffmpegInstaller.path;
const SHOTS = 40;
const SHOT_SECONDS = 3;
const TOTAL = SHOTS * SHOT_SECONDS;
// The render worker's limit: pages/api/story/render-worker.js maxDuration 300 s (lib/story/render.js RENDER_WINDOW_MS 280 s).
const WORKER_LIMIT_MS = 280_000;

let raw;
let dir;
let clip;
let voice;

function ff(args) {
  const r = spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
}

beforeAll(async () => {
  raw = await createTestDb();
  setStoryDb(raw);
  setCreditsDb(raw);
  setPricingDb(raw);
  dir = mkdtempSync(path.join(os.tmpdir(), 'render2min-'));
  // One tiny 3 second clip, used for all 40 shots.
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=270x480:rate=24:duration=3', '-f', 'lavfi', '-i', 'sine=f=300:d=3', '-shortest',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '40', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '32k', 'c.mp4']);
  // 16 lines of tone, one per scene, each shorter than its scene's 7.5 s of shots.
  const parts = Array.from({ length: 16 }, (_, i) => `sine=f=${200 + i * 5}:d=6.5,volume=0.4,apad=pad_dur=1[a${i}]`).join(';');
  const ins = Array.from({ length: 16 }, (_, i) => `[a${i}]`).join('');
  ff(['-filter_complex', `${parts};${ins}concat=n=16:v=0:a=1[out]`, '-map', '[out]', '-ac', '1', '-ar', '22050', 'voice.wav']);
  clip = await putObject({ key: `test-fixtures/${randomUUID()}.mp4`, body: readFileSync(path.join(dir, 'c.mp4')) });
  voice = await putObject({ key: `test-fixtures/${randomUUID()}.wav`, body: readFileSync(path.join(dir, 'voice.wav')) });
}, 180_000);

afterAll(async () => {
  setStoryDb(null);
  setCreditsDb(null);
  setPricingDb(null);
  _resetPricingCache();
  rmSync(dir, { recursive: true, force: true });
  await raw?.close();
});

describe('a 2 minute video', () => {
  it('renders 40 shots of 3 seconds in mock mode inside the worker window and cleans up its work files', async () => {
    const userId = randomUUID();
    const scenes = Array.from({ length: 16 }, (_, i) => ({
      id: `s${i + 1}`, title: `Scene ${i + 1}`, visual: `Moment ${i + 1} in the shop.`, lines: [{ speaker: 'narrator', text: `Line ${i + 1} of the long story.` }],
    }));
    const sceneOfShot = (i) => Math.min(15, Math.floor((i * 16) / SHOTS));
    const segments = scenes.map((s, i) => ({ sceneId: s.id, lineIndex: 0, text: s.lines[0].text, start: i * 7.5 + 0.2, end: i * 7.5 + 6.7 }));
    const [project] = await storyDb().insert('story_projects', {
      user_id: userId, title: 'Two minutes', style: '3d_family', step: 'review', seconds: 120, quality: 'standard', mode: 'narrated', aspect: '9:16',
      narration_url: voice.url, narration_key: voice.key, narration_seconds: 120, narration_segments: segments,
      audio_plan: { captions: { on: true, style: 'clean' }, music: { type: 'none', prompt: '', assetId: null } },
    });
    await storyDb().insert('story_scripts', { project_id: project.id, version: 1, scenes, source: 'brief' });
    await storyDb().insert('story_shots', Array.from({ length: SHOTS }, (_, i) => ({
      project_id: project.id, ord: i, scene_id: scenes[sceneOfShot(i)].id, description: `shot ${i}`, seconds: SHOT_SECONDS, quality: 'standard',
      source: 'generated', status: 'ready', clip_url: clip.url, clip_key: clip.key,
    })));

    const before = readdirSync(os.tmpdir()).filter((n) => n.startsWith('story-render-'));
    await startRender({ userId, projectId: project.id });
    const started = Date.now();
    const out = await runWorkerJob('render', { deadline: started + WORKER_LIMIT_MS });
    const took = Date.now() - started;
    expect(out).toMatchObject({ claimed: true, outcome: 'done' });
    const [row] = await storyDb().select('story_renders', { project_id: project.id });
    expect(row).toMatchObject({ status: 'done', error: null });
    expect(row.settings.shots).toHaveLength(SHOTS);
    expect(Math.abs(row.duration_seconds - TOTAL)).toBeLessThanOrEqual(0.5);
    expect(took).toBeLessThan(WORKER_LIMIT_MS - 40_000);
    const info = spawnSync(FF, ['-hide_banner', '-i', localPathFor(row.file_url)], { encoding: 'utf8' }).stderr;
    const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(info);
    expect(Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3])).toBeGreaterThan(119);
    if (process.env.RENDER_TEST_LOG) console.log('[render 2 min] took ms', took, 'warnings', JSON.stringify(row.warnings));
    // The work dir is removed.
    expect(readdirSync(os.tmpdir()).filter((n) => n.startsWith('story-render-') && !before.includes(n))).toEqual([]);
  }, 330_000);
});
