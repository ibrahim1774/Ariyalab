#!/usr/bin/env node
/*
 * Generates the small media fixtures that mock mode (STORY_MOCK=1) and the
 * tests use, with the ffmpeg binary bundled by @ffmpeg-installer/ffmpeg.
 *
 *   node scripts/make-fixtures.mjs
 *
 * Writes tests/fixtures/{clip.mp4, still.png, voice.mp3, music.mp3,
 * reference.mp4, reference-silent.mp4}. In dev, mock URLs such as
 * /api/mock/fixtures/clip.mp4 are served from here by a dev-only API route
 * (nothing is copied into public/, so fixtures never ship to production).
 * Output is deterministic enough to commit; re-run only when a fixture's
 * spec changes.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturesDir = path.join(root, 'tests', 'fixtures');
const W = 432;
const H = 768;

function ffmpeg(args) {
  const r = spawnSync(ffmpegInstaller.path, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${args.join(' ')}`);
}

const out = (name) => path.join(fixturesDir, name);
const x264 = ['-c:v', 'libx264', '-preset', 'veryslow', '-crf', '40', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];

mkdirSync(fixturesDir, { recursive: true });

// clip.mp4: 3 s, 432x768, 24 fps, silent colour bars.
ffmpeg(['-f', 'lavfi', '-i', `smptebars=size=${W}x${H}:rate=24:duration=3`, ...x264, '-an', out('clip.mp4')]);

// still.png: one 432x768 frame of colour bars.
ffmpeg(['-f', 'lavfi', '-i', `smptebars=size=${W}x${H}`, '-frames:v', '1', out('still.png')]);

// voice.mp3: 4 s of speech-like tone bursts with two 0.4 s silences
// (1.4-1.8 s and 2.8-3.2 s) so silence detection finds real gaps.
const gate = 'not(between(t\\,1.4\\,1.8))*not(between(t\\,2.8\\,3.2))'; // commas escaped for lavfi
const voiceExpr = `0.6*sin(2*PI*180*t)*(0.55+0.45*sin(2*PI*5*t))*${gate}`;
ffmpeg(['-f', 'lavfi', '-i', `aevalsrc=${voiceExpr}:s=22050:d=4`, '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '32k', out('voice.mp3')]);

// music.mp3: 10 s soft chord.
const musicExpr = '0.2*sin(2*PI*220*t)+0.15*sin(2*PI*277.18*t)+0.15*sin(2*PI*329.63*t)';
ffmpeg(['-f', 'lavfi', '-i', `aevalsrc=${musicExpr}:s=22050:d=10`, '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '32k', out('music.mp3')]);

// reference.mp4: 12 s, three visually distinct 4 s scenes (two hard cuts at
// 4 s and 8 s) with a tone track.
ffmpeg([
  '-f', 'lavfi', '-i', `color=c=0xC0392B:size=${W}x${H}:rate=24:duration=4`,
  '-f', 'lavfi', '-i', `testsrc2=size=${W}x${H}:rate=24:duration=4`,
  '-f', 'lavfi', '-i', `color=c=0x1F4E8C:size=${W}x${H}:rate=24:duration=4`,
  '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=22050:duration=12',
  '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]',
  '-map', '[v]', '-map', '3:a',
  ...x264, '-c:a', 'aac', '-b:a', '32k', '-ac', '1',
  out('reference.mp4'),
]);

// reference-silent.mp4: the same 12 s video with no audio track, for the
// "silent reel + separate audio" path ([[mock:silent-reel]]).
ffmpeg(['-i', out('reference.mp4'), '-c:v', 'copy', '-an', out('reference-silent.mp4')]);

let total = 0;
for (const name of ['clip.mp4', 'still.png', 'voice.mp3', 'music.mp3', 'reference.mp4', 'reference-silent.mp4']) {
  const size = statSync(out(name)).size;
  total += size;
  console.log(`${name.padEnd(14)} ${(size / 1024).toFixed(1)} KB`);
}
console.log(`total          ${(total / 1024).toFixed(1)} KB`);
