// Task 23: brand kit, product references, the customer's own footage and pictures. Mock mode only (STORY_MOCK=1).
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { ModerationError, screenImage } from '../../lib/moderation.js';
import { mockStoragePath } from '../../lib/providers/storage.js';
import {
  attachProjectAsset, brandUploadKey, cleanAvoidList, deleteAsset, detachProjectAsset, getBrand, linkBrandAssets, listAssets, listProjectAssets,
  registerAsset, saveBrand, withBrandDefaults,
} from '../../lib/story/assets.js';
import { brandPrefix } from '../../lib/story/assetRules.js';
import { buildShotList, generateStills, markStale, sceneSig, shotsView, updateShot } from '../../lib/story/storyboard.js';
import { quoteGeneration, startGeneration } from '../../lib/story/shots.js';
import { getScript, updateScene } from '../../lib/story/script.js';
import { pickCast, setCastImage } from '../../lib/story/cast.js';
import { createProject } from '../../lib/story/projects.js';
import { duplicateProject } from '../../lib/story/projects.js';
import { registerAudio } from '../../lib/story/voices.js';
import { setAudioPlan } from '../../lib/story/audio.js';
import { imageInputArgs, imageMime } from '../../lib/story/mediaArgs.js';
import { tick } from '../../lib/story/runner.js';

// The picture check is a spy: it passes by default, and a test can make it block or be unavailable.
vi.mock('../../lib/moderation.js', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    screenImage: vi.fn(async () => {
      if (globalThis.__imageVerdict === 'block') throw new real.ModerationError('sexual', 'blocked');
      if (globalThis.__imageVerdict === 'unavailable') throw new real.ModerationError('unavailable', 'unavailable');
      return { ok: true };
    }),
  };
});
vi.mock('@vercel/blob/client', () => ({
  handleUpload: async ({ body, onBeforeGenerateToken }) => {
    const options = await onBeforeGenerateToken(body.payload.pathname, body.payload.clientPayload);
    return { type: 'blob.generate-client-token', options };
  },
}));
vi.mock('../../lib/supabaseServer.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getUserFromRequest: vi.fn(async () => globalThis.__assetSession ?? null),
}));

useRegexOnlyModeration();
useTestAccounts();

let raw;
let dir;
const files = {};
const ff = (args) => {
  const r = spawnSync(ffmpegInstaller.path, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
};

beforeAll(async () => {
  raw = await createTestDb();
  setStoryDb(raw);
  setCreditsDb(raw);
  setPricingDb(raw);
  dir = mkdtempSync(path.join(os.tmpdir(), 'assets-fixture-'));
  const make = (name, args) => {
    ff([...args, path.join(dir, name)]);
    files[name] = readFileSync(path.join(dir, name));
  };
  make('logo.png', ['-f', 'lavfi', '-i', 'testsrc=s=96x64:d=1', '-frames:v', '1']);
  make('photo.jpg', ['-f', 'lavfi', '-i', 'testsrc=s=64x96:d=1', '-frames:v', '1']);
  // The bundled ffmpeg has no WebP encoder: a 1x1 lossless WebP, byte for byte.
  files['photo.webp'] = Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', 'base64');
  make('clip.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=24:d=2', '-pix_fmt', 'yuv420p']);
  make('phone.mov', ['-f', 'lavfi', '-i', 'testsrc2=s=240x320:r=24:d=2', '-pix_fmt', 'yuv420p', '-f', 'mov']);
  make('voice.m4a', ['-f', 'lavfi', '-i', 'sine=f=300:d=12', '-c:a', 'aac']);
  make('twelve.wav', ['-f', 'lavfi', '-i', 'sine=f=300:d=12', '-ar', '22050', '-ac', '1']);
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
  screenImage.mockClear();
});
afterEach(() => {
  globalThis.__imageVerdict = null;
  globalThis.__assetSession = null;
});

// ---------------------------------------------------------------- helpers

const newUser = async ({ funds = 500 } = {}) => {
  const userId = randomUUID();
  if (funds) await grantCredits({ userId, currency: 'video', amount: funds, bucket: 'topup', reason: 'test', ref: randomUUID() });
  return userId;
};

/** Puts a file where the browser upload would have put it (the mock store) and returns its URL. */
function store(userId, name, bytes, prefix = brandPrefix(userId)) {
  const key = `${prefix}${name}`;
  const file = mockStoragePath(key);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  return { url: `/api/mock/storage/${key}`, key, file };
}
const put = (userId, fixture, name = `${randomUUID()}.${fixture.split('.').pop()}`) => store(userId, name, files[fixture]).url;
// Like the brand page: pictures join the kit unless a test says otherwise (the default of registerAsset itself is out of the kit).
const upload = (userId, kind, fixture, over = {}) => registerAsset({ userId, kind, url: put(userId, fixture), name: fixture, inBrandKit: ['logo', 'product', 'mascot'].includes(kind), ...over });
const assetRow = async (id) => (await storyDb().select('story_assets', { id }))[0];

const SCENES = [
  { id: 's1', title: 'The shop', visual: 'Maya sweeps the small barbershop at night.', lines: [{ speaker: 'narrator', text: 'Nobody believed this would work.' }] },
  { id: 's2', title: 'The visit', visual: 'Leo walks in with two coffees and Maya laughs.', lines: [{ speaker: 'narrator', text: 'Then Leo walked in with coffee.' }] },
];

/** A project with a script and shots that all have a still, like a project that reached the generate step. */
async function newProject({ userId, shots = 2, quality = 'pro_narrated' } = {}) {
  const owner = userId || (await newUser());
  const [project] = await storyDb().insert('story_projects', {
    user_id: owner, title: `Video ${randomUUID().slice(0, 4)}`, style: '3d_family', step: 'generate', seconds: 30, quality, mode: 'narrated', fee_charged: true,
  });
  await storyDb().insert('story_scripts', { project_id: project.id, version: 1, scenes: SCENES, source: 'brief' });
  const rows = await storyDb().insert('story_shots', Array.from({ length: shots }, (_, i) => ({
    project_id: project.id, ord: i, scene_id: SCENES[i % 2].id, scene_sig: sceneSig(SCENES[i % 2]), description: `Shot ${i + 1} of the shop.`,
    seconds: 5, quality, status: 'still_ready', still_url: `/still/${i}.png`, still_key: `still-${i}`, still_delivered: true,
  })));
  return { userId: owner, project, shots: rows.sort((a, b) => a.ord - b.ord) };
}
const shotRow = async (id) => (await storyDb().select('story_shots', { id }))[0];

// ---------------------------------------------------------------- registering an upload

describe('registering pictures and clips', () => {
  it('keeps a picture the server could read, under the database kind, with its size, and checks it by content', async () => {
    const userId = await newUser();
    const logo = await upload(userId, 'logo', 'logo.png');
    expect(logo).toMatchObject({ kind: 'logo', name: 'logo.png', width: 96, height: 64, inBrandKit: true });
    const product = await upload(userId, 'product', 'photo.jpg');
    const mascot = await upload(userId, 'mascot', 'photo.webp');
    expect([product.width, product.height, mascot.width, mascot.height]).toEqual([64, 96, 1, 1]);
    const rows = await Promise.all([logo, product, mascot].map((a) => assetRow(a.id)));
    expect(rows.map((r) => [r.kind, r.mime, r.user_id])).toEqual([['logo', 'image/png', userId], ['product_photo', 'image/jpeg', userId], ['mascot', 'image/webp', userId]]);
    expect(screenImage).toHaveBeenCalledTimes(3);
    expect(screenImage.mock.calls[0][0]).toBe(logo.url);
  });

  it('a picture stays out of the brand kit unless the brand page asks, so it is never attached to new projects or used as a product reference', async () => {
    const userId = await newUser();
    const plain = await registerAsset({ userId, kind: 'logo', url: put(userId, 'logo.png') });
    expect(plain.inBrandKit).toBe(false);
    const inset = await upload(userId, 'image', 'photo.jpg', { inBrandKit: undefined });
    const face = await upload(userId, 'image', 'photo.webp', { inBrandKit: undefined });
    expect(inset).toMatchObject({ kind: 'image', inBrandKit: false });
    expect((await assetRow(inset.id)).kind).toBe('image');
    expect((await listAssets({ userId, kinds: ['image'] })).map((a) => a.id).sort()).toEqual([inset.id, face.id].sort());
    expect(await listAssets({ userId, brandOnly: true })).toEqual([]);
    const kept = await upload(userId, 'product', 'photo.jpg');
    const project = await createProject({ userId, input: { title: 'Fresh' } });
    expect((await listProjectAssets({ userId, projectId: project.id })).map((a) => a.id)).toEqual([kept.id]);
    expect(await upload(userId, 'clip', 'clip.mp4')).toMatchObject({ inBrandKit: false });
  });

  it('keeps an mp4 and a mov clip, with their length and size, and does not send a clip to the picture check', async () => {
    const userId = await newUser();
    const clip = await upload(userId, 'clip', 'clip.mp4');
    const rec = await upload(userId, 'recording', 'phone.mov');
    expect(clip).toMatchObject({ kind: 'clip', width: 320, height: 240, inBrandKit: false });
    expect(clip.seconds).toBeGreaterThan(1.5);
    expect(rec).toMatchObject({ kind: 'recording', width: 240, height: 320 });
    expect((await assetRow(rec.id)).kind).toBe('screen_recording');
    expect((await assetRow(rec.id)).mime).toBe('video/quicktime');
    expect(screenImage).not.toHaveBeenCalled();
  });

  it('refuses a file that is not what its name says, and deletes it', async () => {
    const userId = await newUser();
    const target = path.join(dir, 'secret.png');
    ff(['-f', 'lavfi', '-i', 'testsrc=s=32x32:d=1', '-frames:v', '1', target]);
    const refusals = [
      // a playlist saved as a picture or a clip (its file:// entries must never be followed)
      ['logo', 'a.png', Buffer.from(`#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nfile://${target}\n#EXT-X-ENDLIST\n`), /could not read that file as a picture/],
      ['clip', 'a.mp4', Buffer.from('#EXTM3U\n#EXTINF:1,\nfile:///etc/hosts\n'), /could not read that file as a video/],
      // a clip that is renamed to be a picture, and a picture renamed to be a clip
      ['product', 'b.png', files['clip.mp4'], /could not read that file as a picture/],
      ['clip', 'b.mp4', files['logo.png'], /could not read that file as a video/],
      // right first bytes, but nothing ffmpeg can decode
      ['product', 'c.png', Buffer.concat([files['logo.png'].subarray(0, 12), Buffer.alloc(64)]), /could not read that file as a picture/],
      // an audio file with an mp4 name: it has the right box but no picture
      ['clip', 'd.mp4', files['voice.m4a'], /could not read that file as a video/],
      // a gif or a pdf by extension
      ['product', 'e.gif', files['logo.png'], /Only PNG, JPG and WebP/],
      ['clip', 'f.avi', files['clip.mp4'], /Only MP4 and MOV/],
    ];
    for (const [kind, name, bytes, message] of refusals) {
      const { url, file } = store(userId, name, bytes);
      await expect(registerAsset({ userId, kind, url }), name).rejects.toMatchObject({ status: 422, field: 'url', message: expect.stringMatching(message) });
      expect(existsSync(file), `${name} is deleted`).toBe(false);
    }
    expect(await storyDb().select('story_assets', { user_id: userId })).toEqual([]);
  });

  it('keeps at most 200 files per customer, and keeps the upload for another try', async () => {
    const userId = await newUser();
    await storyDb().insert('story_assets', Array.from({ length: 200 }, (_, i) => ({ user_id: userId, kind: 'product_photo', name: `f${i}`, url: `/x/${i}.png` })));
    const stored = store(userId, 'late.png', files['logo.png']);
    await expect(registerAsset({ userId, kind: 'logo', url: stored.url })).rejects.toMatchObject({ status: 429, code: 'asset_limit' });
    expect(existsSync(stored.file)).toBe(true);
    const [one] = await storyDb().select('story_assets', { user_id: userId }, { limit: 1 });
    await deleteAsset({ userId, assetId: one.id });
    expect(await registerAsset({ userId, kind: 'logo', url: stored.url })).toMatchObject({ kind: 'logo' });
  });

  it('refuses a picture over 5 MB, a clip over 5 minutes, and a kind it does not know', async () => {
    const userId = await newUser();
    const big = store(userId, 'big.png', Buffer.concat([files['logo.png'], Buffer.alloc(5 * 1024 * 1024)]));
    await expect(registerAsset({ userId, kind: 'logo', url: big.url })).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/larger than 5 MB/) });
    expect(existsSync(big.file)).toBe(false);
    const long = path.join(dir, 'long.mp4');
    ff(['-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=1:d=301', '-pix_fmt', 'yuv420p', '-g', '1', long]);
    const stored = store(userId, 'long.mp4', readFileSync(long));
    await expect(registerAsset({ userId, kind: 'clip', url: stored.url })).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/longer than 5 minutes/) });
    expect(existsSync(stored.file)).toBe(false);
    await expect(registerAsset({ userId, kind: 'banner', url: put(userId, 'logo.png') })).rejects.toMatchObject({ status: 422, field: 'kind' });
  }, 60_000);

  it("only takes a file under the caller's own folder of our own store", async () => {
    const maya = await newUser();
    const leo = await newUser();
    const theirs = put(leo, 'logo.png');
    await expect(registerAsset({ userId: maya, kind: 'logo', url: theirs })).rejects.toMatchObject({ status: 422, field: 'url' });
    expect(existsSync(mockStoragePath(`${brandPrefix(leo)}${theirs.split('/').pop()}`))).toBe(true); // not Maya's to delete
    const elsewhere = store(maya, 'x.png', files['logo.png'], `story-audio/${maya}/`);
    await expect(registerAsset({ userId: maya, kind: 'logo', url: elsewhere.url })).rejects.toMatchObject({ status: 422 });
    await expect(registerAsset({ userId: maya, kind: 'logo', url: 'https://evil.example/story-brand/x.png' })).rejects.toMatchObject({ status: 422 });
    await expect(registerAsset({ userId: maya, kind: 'logo', url: `/api/mock/storage/${brandPrefix(maya)}../x.png` })).rejects.toMatchObject({ status: 422 });
    await expect(registerAsset({ userId: maya, kind: 'logo', url: `/api/mock/storage/${brandPrefix(maya)}sub/x.png` })).rejects.toMatchObject({ status: 422 });
    await expect(registerAsset({ userId: maya, kind: 'logo', url: `/api/mock/storage/${brandPrefix(maya)}missing.png` })).rejects.toMatchObject({ status: 422 });
  });

  it('real mode: only our own Blob store counts, and a percent-encoded path is read decoded', () => {
    vi.stubEnv('BLOB_READ_WRITE_TOKEN', 'vercel_blob_rw_AbC123xyz_secretpart');
    const u = randomUUID();
    const ours = (p) => `https://abc123xyz.public.blob.vercel-storage.com/${p}`;
    expect(brandUploadKey(u, ours(`story-brand/${u}/a-1.png`), { mock: false })).toBe(`story-brand/${u}/a-1.png`);
    expect(brandUploadKey(u, ours(`story-brand/${u}/clip-1.mov`), { mock: false })).toBe(`story-brand/${u}/clip-1.mov`);
    expect(brandUploadKey(u, ours(`story-brand/${u}/a%201.png`), { mock: false })).toBe(`story-brand/${u}/a 1.png`);
    expect(brandUploadKey(u, ours(`story-brand%2F${u}%2Fa-1.png`), { mock: false })).toBe(`story-brand/${u}/a-1.png`);
    expect(brandUploadKey(u, `https://someoneelse.public.blob.vercel-storage.com/story-brand/${u}/a-1.png`, { mock: false })).toBeNull();
    expect(brandUploadKey(u, ours(`story-brand/${randomUUID()}/a-1.png`), { mock: false })).toBeNull();
    expect(brandUploadKey(u, ours(`story-brand/${u}/sub/a-1.png`), { mock: false })).toBeNull();
    expect(brandUploadKey(u, ours(`story-brand/${u}/%2e%2e/a-1.png`), { mock: false })).toBeNull();
    expect(brandUploadKey(u, ours(`story-audio/${u}/a-1.png`), { mock: false })).toBeNull();
    expect(brandUploadKey(u, `http://abc123xyz.public.blob.vercel-storage.com/story-brand/${u}/a-1.png`, { mock: false })).toBeNull();
    vi.stubEnv('BLOB_READ_WRITE_TOKEN', '');
    expect(brandUploadKey(u, ours(`story-brand/${u}/a-1.png`), { mock: false })).toBeNull();
    vi.unstubAllEnvs();
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('STORY_MOCK', '1');
  });

  it('fails closed on the picture check: a block deletes the file, an unavailable checker keeps nothing in the kit and the file', async () => {
    const userId = await newUser();
    globalThis.__imageVerdict = 'block';
    const blocked = store(userId, 'b.png', files['logo.png']);
    await expect(registerAsset({ userId, kind: 'product', url: blocked.url })).rejects.toBeInstanceOf(ModerationError);
    expect(existsSync(blocked.file)).toBe(false);
    globalThis.__imageVerdict = 'unavailable';
    const waiting = store(userId, 'u.png', files['logo.png']);
    await expect(registerAsset({ userId, kind: 'product', url: waiting.url })).rejects.toMatchObject({ code: 'MODERATION_UNAVAILABLE' });
    expect(existsSync(waiting.file)).toBe(true);
    expect(await storyDb().select('story_assets', { user_id: userId })).toEqual([]);
    globalThis.__imageVerdict = null;
    expect(await registerAsset({ userId, kind: 'product', url: waiting.url })).toMatchObject({ kind: 'product' });
  });

  it('answers a block with the shared moderation payload over HTTP', async () => {
    const userId = await newUser();
    const { default: route } = await import('../../pages/api/story/assets.js');
    globalThis.__assetSession = { user: { id: userId } };
    globalThis.__imageVerdict = 'block';
    const res = makeRes();
    await route(makeReq({ method: 'POST', body: { kind: 'logo', url: put(userId, 'logo.png') } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('BLOCKED_NSFW');
    globalThis.__imageVerdict = 'unavailable';
    const again = makeRes();
    await route(makeReq({ method: 'POST', body: { kind: 'logo', url: put(userId, 'logo.png') } }), again);
    expect(again.statusCode).toBe(503);
  });

  it("still takes the customer's audio through the same route, including the kind 'audio'", async () => {
    const userId = await newUser();
    const a = await registerAsset({ userId, kind: 'audio', url: store(userId, 'a.wav', files['twelve.wav'], `story-audio/${userId}/`).url });
    expect(a).toMatchObject({ kind: 'audio', seconds: expect.any(Number) });
    await expect(registerAsset({ userId, kind: 'music', url: put(userId, 'logo.png') })).rejects.toMatchObject({ status: 422 });
  });
});

describe('the assets route', () => {
  const call = async (method, { query = {}, body = {}, session = true, userId } = {}) => {
    const { default: route } = await import('../../pages/api/story/assets.js');
    globalThis.__assetSession = session ? { user: { id: userId } } : null;
    const res = makeRes();
    await route(makeReq({ method, query, body }), res);
    return res;
  };

  it('the route is allowed 300 s for a 200 MB download, and the download stays inside it', async () => {
    const { config } = await import('../../pages/api/story/assets.js');
    expect(config.maxDuration).toBe(300);
    const { downloadToFile } = await import('../../lib/providers/http.js');
    expect(downloadToFile).toBeTypeOf('function');
  });

  it('GET with no query still answers the audio upload folder, and adds the picture folder', async () => {
    const userId = await newUser();
    const res = await call('GET', { userId });
    expect(res.statusCode).toBe(200);
    expect(res.body.uploadPrefix).toBe(`story-audio/${userId}/`);
    expect(res.body.brandPrefix).toBe(`story-brand/${userId}/`);
    expect(res.body.limits.maxBytes).toBe(20 * 1024 * 1024);
  });

  it('lists the caller\'s files by kind, newest first, and only their own', async () => {
    const maya = await newUser();
    const leo = await newUser();
    const logo = await upload(maya, 'logo', 'logo.png');
    const clip = await upload(maya, 'clip', 'clip.mp4');
    await upload(leo, 'logo', 'logo.png');
    const all = await call('GET', { userId: maya, query: { list: '1' } });
    expect(all.body.assets.map((a) => a.id).sort()).toEqual([logo.id, clip.id].sort());
    const clips = await call('GET', { userId: maya, query: { kinds: 'clip,recording' } });
    expect(clips.body.assets.map((a) => a.id)).toEqual([clip.id]);
    const kit = await call('GET', { userId: maya, query: { list: '1', brand: '1' } });
    expect(kit.body.assets.map((a) => a.id)).toEqual([logo.id]);
    expect((await listAssets({ userId: maya, kinds: ['mascot'] }))).toEqual([]);
  });

  it('needs a session, and answers other methods with Allow', async () => {
    expect((await call('GET', { session: false })).statusCode).toBe(401);
    expect((await call('DELETE', { session: false, query: { id: randomUUID() } })).statusCode).toBe(401);
    const res = await call('PUT', { userId: 'x' });
    expect(res.statusCode).toBe(405);
    expect(res.headers.Allow).toBe('GET, POST, DELETE');
  });
});

// ---------------------------------------------------------------- deleting

describe('deleting an asset', () => {
  const del = async (userId, id) => {
    const { default: route } = await import('../../pages/api/story/assets.js');
    globalThis.__assetSession = { user: { id: userId } };
    const res = makeRes();
    await route(makeReq({ method: 'DELETE', query: { id } }), res);
    return res;
  };

  it('deletes an unused asset and its stored file; a link to a project goes with it', async () => {
    const { userId, project } = await newProject();
    const asset = await upload(userId, 'product', 'photo.jpg');
    await attachProjectAsset({ userId, projectId: project.id, assetId: asset.id, role: 'product' });
    const file = mockStoragePath((await assetRow(asset.id)).storage_key);
    expect(existsSync(file)).toBe(true);
    const res = await del(userId, asset.id);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ id: asset.id });
    expect(await assetRow(asset.id)).toBeUndefined();
    expect(existsSync(file)).toBe(false);
    expect(await storyDb().select('story_project_assets', { project_id: project.id })).toEqual([]);
  });

  it('an asset in use returns 409 listing the projects, deletes nothing, and says what to do', async () => {
    const maya = await newUser();
    const a = await newProject({ userId: maya });
    const b = await newProject({ userId: maya });
    await newProject({ userId: maya }); // a third project that does not use it
    const clip = await upload(maya, 'clip', 'clip.mp4');
    await updateShot({ userId: maya, projectId: a.project.id, shotId: a.shots[0].id, patch: { source: 'footage', footage_asset_id: clip.id } });
    await updateShot({ userId: maya, projectId: b.project.id, shotId: b.shots[1].id, patch: { inset_asset_id: clip.id } });
    const res = await del(maya, clip.id);
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe('asset_in_use');
    expect(res.body.projects).toEqual(expect.arrayContaining([{ id: a.project.id, title: a.project.title }, { id: b.project.id, title: b.project.title }]));
    expect(res.body.projects).toHaveLength(2);
    expect(res.body.message).toMatch(/used in/);
    expect(await assetRow(clip.id)).toBeDefined();
    expect(existsSync(mockStoragePath((await assetRow(clip.id)).storage_key))).toBe(true);
    // taken out of both videos, it can go
    await updateShot({ userId: maya, projectId: a.project.id, shotId: a.shots[0].id, patch: { source: 'generated' } });
    await updateShot({ userId: maya, projectId: b.project.id, shotId: b.shots[1].id, patch: { inset_asset_id: null } });
    expect((await del(maya, clip.id)).statusCode).toBe(200);
  });

  it('every other way a project uses a file counts: a reference picture on a shot, a character, the audio plan', async () => {
    const maya = await newUser();
    const { project, shots } = await newProject({ userId: maya });
    const ref = await upload(maya, 'product', 'photo.jpg');
    await storyDb().update('story_shots', { id: shots[0].id }, { ref_asset_ids: [ref.id] });
    expect((await del(maya, ref.id)).body.projects).toEqual([{ id: project.id, title: project.title }]);
    await storyDb().update('story_shots', { id: shots[0].id }, { ref_asset_ids: [] });
    expect((await del(maya, ref.id)).statusCode).toBe(200);

    const face = await upload(maya, 'mascot', 'photo.webp');
    const [cast] = await storyDb().insert('story_cast', { project_id: project.id, name: 'Maya', status: 'ready', image_url: '/p.png', image_key: 'p', asset_id: face.id });
    expect((await del(maya, face.id)).statusCode).toBe(409);
    await storyDb().update('story_cast', { id: cast.id }, { asset_id: null });
    expect((await del(maya, face.id)).statusCode).toBe(200);

    const track = await registerAsset({ userId: maya, kind: 'voice_track', url: store(maya, 't.wav', files['twelve.wav'], `story-audio/${maya}/`).url });
    const song = await registerAsset({ userId: maya, kind: 'music', url: store(maya, 's.wav', files['twelve.wav'], `story-audio/${maya}/`).url });
    await setAudioPlan({ userId: maya, projectId: project.id, plan: { voiceTrackAssetId: track.id, music: { type: 'upload', assetId: song.id } } });
    expect((await del(maya, track.id)).body.projects).toEqual([{ id: project.id, title: project.title }]);
    expect((await del(maya, song.id)).statusCode).toBe(409);
    await setAudioPlan({ userId: maya, projectId: project.id, plan: { voiceTrackAssetId: null, music: { type: 'none', assetId: null } } });
    expect((await del(maya, track.id)).statusCode).toBe(200);
    expect((await del(maya, song.id)).statusCode).toBe(200);
  });

  it("another customer's id, an unknown id and a malformed id are all the same 404", async () => {
    const maya = await newUser();
    const leo = await newUser();
    const mine = await upload(maya, 'logo', 'logo.png');
    for (const id of [mine.id, randomUUID(), 'not-an-id', '']) {
      const res = await del(leo, id);
      expect(res.statusCode, id).toBe(404);
      expect(res.body.error).toBe('not_found');
    }
    expect(await assetRow(mine.id)).toBeDefined();
    await expect(deleteAsset({ userId: leo, assetId: mine.id })).rejects.toMatchObject({ status: 404 });
  });

  it('the brand logo is cleared when its file goes', async () => {
    const userId = await newUser();
    const logo = await upload(userId, 'logo', 'logo.png');
    await saveBrand({ userId, patch: { logoAssetId: logo.id } });
    expect((await getBrand({ userId })).logo).toMatchObject({ id: logo.id });
    await deleteAsset({ userId, assetId: logo.id });
    expect((await getBrand({ userId })).logo).toBeNull();
  });
});

// ---------------------------------------------------------------- brand

describe('the brand kit', () => {
  it('starts empty, saves the fields it is given and keeps the others', async () => {
    const userId = await newUser();
    expect(await getBrand({ userId })).toEqual({ offer: null, audience: null, tone: null, avoid: [], colors: [], logo: null });
    await saveBrand({ userId, patch: { offer: 'Haircuts that last', audience: 'busy dads' } });
    const brand = await saveBrand({ userId, patch: { tone: 'warm and plain', avoid: ['hustle', ' Hustle ', 'cheap'], colors: ['#ABC', '#112233', '#aabbcc'] } });
    expect(brand).toEqual({ offer: 'Haircuts that last', audience: 'busy dads', tone: 'warm and plain', avoid: ['hustle', 'cheap'], colors: ['#aabbcc', '#112233'], logo: null });
    expect(await storyDb().select('story_brand', { user_id: userId })).toHaveLength(1);
    expect((await saveBrand({ userId, patch: { offer: null } })).offer).toBeNull();
  });

  it('refuses what is too long, not a colour, not an avoid list, or a logo that is not the caller\'s', async () => {
    const maya = await newUser();
    const leo = await newUser();
    await expect(saveBrand({ userId: maya, patch: { offer: 'x'.repeat(1001) } })).rejects.toMatchObject({ status: 422, field: 'offer' });
    await expect(saveBrand({ userId: maya, patch: { audience: 'x'.repeat(501) } })).rejects.toMatchObject({ field: 'audience' });
    await expect(saveBrand({ userId: maya, patch: { colors: ['red'] } })).rejects.toMatchObject({ field: 'colors' });
    await expect(saveBrand({ userId: maya, patch: { colors: Array(7).fill('#fff') } })).rejects.toMatchObject({ field: 'colors' });
    await expect(saveBrand({ userId: maya, patch: { avoid: ['x'.repeat(41)] } })).rejects.toMatchObject({ field: 'avoid' });
    await expect(saveBrand({ userId: maya, patch: { avoid: Array.from({ length: 31 }, (_, i) => `w${i}`) } })).rejects.toMatchObject({ field: 'avoid' });
    await expect(saveBrand({ userId: maya, patch: { avoid: 5 } })).rejects.toMatchObject({ field: 'avoid' });
    await expect(saveBrand({ userId: maya, patch: { nope: 1 } })).rejects.toMatchObject({ field: 'nope' });
    await expect(saveBrand({ userId: maya, patch: {} })).rejects.toMatchObject({ status: 422 });
    const theirs = await upload(leo, 'logo', 'logo.png');
    const product = await upload(maya, 'product', 'photo.jpg');
    await expect(saveBrand({ userId: maya, patch: { logoAssetId: theirs.id } })).rejects.toMatchObject({ field: 'logoAssetId' });
    await expect(saveBrand({ userId: maya, patch: { logoAssetId: product.id } })).rejects.toMatchObject({ field: 'logoAssetId' });
    expect(await storyDb().select('story_brand', { user_id: maya })).toEqual([]);
  });

  it('saving the brand moves updated_at', async () => {
    const userId = await newUser();
    await saveBrand({ userId, patch: { tone: 'warm' } });
    const [first] = await storyDb().select('story_brand', { user_id: userId });
    await new Promise((r) => setTimeout(r, 20));
    await saveBrand({ userId, patch: { tone: 'plain' } });
    const [second] = await storyDb().select('story_brand', { user_id: userId });
    expect(Date.parse(second.updated_at)).toBeGreaterThan(Date.parse(first.updated_at));
  });

  it('screens the offer, audience and tone with the content rules, but not the words to avoid', async () => {
    const userId = await newUser();
    await expect(saveBrand({ userId, patch: { tone: 'nude' } })).rejects.toBeInstanceOf(ModerationError);
    await expect(saveBrand({ userId, patch: { offer: 'nude photos' } })).rejects.toBeInstanceOf(ModerationError);
    expect(await storyDb().select('story_brand', { user_id: userId })).toEqual([]);
    expect((await saveBrand({ userId, patch: { avoid: ['nude'] } })).avoid).toEqual(['nude']);
  });

  it('takes the avoid list as text too, one word or phrase per line or comma', () => {
    expect(cleanAvoidList('hustle, cheap\nfree money')).toEqual(['hustle', 'cheap', 'free money']);
  });

  it('an avoid word in a script line is flagged, through the saved brand', async () => {
    const { userId, project } = await newProject();
    const scenes = [{ ...SCENES[0], lines: [{ speaker: 'narrator', text: 'Rise and grind, it is all hustle.' }] }, SCENES[1]];
    await storyDb().update('story_scripts', { project_id: project.id, version: 1 }, { scenes });
    expect((await getScript({ userId, projectId: project.id })).violations.map((v) => v.rule)).not.toContain('avoid_word');
    await saveBrand({ userId, patch: { avoid: ['Hustle'] } });
    const { violations } = await getScript({ userId, projectId: project.id });
    expect(violations).toContainEqual(expect.objectContaining({ sceneId: 's1', rule: 'avoid_word', message: expect.stringContaining('"Hustle"') }));
    const edited = await updateScene({ userId, projectId: project.id, sceneId: 's1', patch: { lines: [{ speaker: 'narrator', text: 'Rise early and keep going.' }] } });
    expect(edited.script.violations.map((v) => v.rule)).not.toContain('avoid_word');
  });

  it('a new project starts with the brand offer and audience unless the request has its own; the kit pictures are attached', async () => {
    const userId = await newUser();
    const logo = await upload(userId, 'logo', 'logo.png');
    const product = await upload(userId, 'product', 'photo.jpg');
    await upload(userId, 'clip', 'clip.mp4'); // not a picture of the kit
    await saveBrand({ userId, patch: { offer: 'Haircuts that last', audience: 'busy dads' } });
    expect(await withBrandDefaults({ userId, input: { title: 'T' } })).toEqual({ title: 'T', offer: 'Haircuts that last', audience: 'busy dads' });
    expect(await withBrandDefaults({ userId, input: { offer: 'Mine', audience: null } })).toEqual({ offer: 'Mine', audience: null });
    expect(await withBrandDefaults({ userId: randomUUID(), input: { title: 'T' } })).toEqual({ title: 'T' });
    expect(await withBrandDefaults({ userId, input: [] })).toEqual([]);
    const { project } = await newProject({ userId });
    await linkBrandAssets({ userId, projectId: project.id });
    const linked = await listProjectAssets({ userId, projectId: project.id });
    expect(linked.map((a) => [a.id, a.role]).sort()).toEqual([[logo.id, 'logo'], [product.id, 'product']].sort());
  });

  it('over HTTP, POST /projects creates the project with the brand fields filled in', async () => {
    const { createProject } = await import('../../lib/story/projects.js');
    const userId = await newUser({ funds: 0 });
    await saveBrand({ userId, patch: { offer: 'Haircuts that last', audience: 'busy dads' } });
    const product = await upload(userId, 'product', 'photo.jpg');
    const { default: route } = await import('../../pages/api/story/projects/index.js');
    globalThis.__assetSession = { user: { id: userId, email: 'a@example.test', email_confirmed_at: '2026-01-01T00:00:00.000Z' } };
    const res = makeRes();
    await route(makeReq({ method: 'POST', body: { title: 'My video', purpose: 'product' } }), res);
    expect(res.statusCode).toBe(201);
    expect(res.body.project).toMatchObject({ title: 'My video', offer: 'Haircuts that last', audience: 'busy dads' });
    expect((await listProjectAssets({ userId, projectId: res.body.project.id })).map((a) => [a.id, a.role])).toEqual([[product.id, 'product']]);
    expect(createProject).toBeTypeOf('function');
  });

  it("the brand route reads and saves the caller's own row", async () => {
    const { default: route } = await import('../../pages/api/story/brand.js');
    const userId = await newUser();
    globalThis.__assetSession = { user: { id: userId } };
    const put = makeRes();
    await route(makeReq({ method: 'PUT', body: { tone: 'warm', avoid: ['hustle'] } }), put);
    expect(put.statusCode).toBe(200);
    const get = makeRes();
    await route(makeReq({ method: 'GET' }), get);
    expect(get.body.brand).toMatchObject({ tone: 'warm', avoid: ['hustle'] });
    const bad = makeRes();
    await route(makeReq({ method: 'PUT', body: { colors: ['nope'] } }), bad);
    expect(bad.statusCode).toBe(422);
    globalThis.__assetSession = null;
    const anon = makeRes();
    await route(makeReq({ method: 'GET' }), anon);
    expect(anon.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------- product pictures in stills

describe('product pictures', () => {
  it('an attached product picture is a reference of the stills; a logo or a removed picture is not', async () => {
    const userId = await newUser();
    const { project, shots } = await newProject({ userId, shots: 2, quality: 'standard' });
    const [maya] = await storyDb().insert('story_cast', { project_id: project.id, ord: 0, name: 'Maya', description: 'Friendly.', status: 'ready', image_url: '/pick/Maya.png', image_key: 'pick-Maya', sheet: { url: '/sheet/Maya.png', key: 'sheet-Maya', from_key: 'pick-Maya' } });
    const draftShots = async () => storyDb().update('story_shots', { project_id: project.id }, { status: 'draft', still_url: null, still_key: null, cast_ids: [maya.id] });
    await draftShots();
    const product = await upload(userId, 'product', 'photo.jpg');
    const logo = await upload(userId, 'logo', 'logo.png');
    await attachProjectAsset({ userId, projectId: project.id, assetId: product.id, role: 'product' });
    await attachProjectAsset({ userId, projectId: project.id, assetId: logo.id, role: 'logo' });
    await generateStills({ userId, projectId: project.id });
    const jobs = await storyDb().select('story_jobs', { project_id: project.id, kind: 'still' });
    expect(jobs.length).toBeGreaterThan(0);
    for (const job of jobs) {
      expect(job.payload.refs).toContain(product.url);
      expect(job.payload.refs).not.toContain(logo.url);
    }
    // not a link to a picture (an old or odd link): never a reference
    await detachProjectAsset({ userId, projectId: project.id, assetId: product.id });
    const clip = await upload(userId, 'clip', 'clip.mp4');
    await storyDb().insert('story_project_assets', { project_id: project.id, asset_id: clip.id, role: 'product' });
    await draftShots();
    await storyDb().remove('story_jobs', { project_id: project.id });
    await generateStills({ userId, projectId: project.id });
    for (const job of await storyDb().select('story_jobs', { project_id: project.id, kind: 'still' })) expect(job.payload.refs).not.toContain(clip.url);
  });

  it('attach is for the caller\'s own pictures, in a known role, and is idempotent', async () => {
    const maya = await newUser();
    const leo = await newUser();
    const { project } = await newProject({ userId: maya });
    const mine = await upload(maya, 'product', 'photo.jpg');
    const theirs = await upload(leo, 'product', 'photo.jpg');
    const clip = await upload(maya, 'clip', 'clip.mp4');
    await attachProjectAsset({ userId: maya, projectId: project.id, assetId: mine.id, role: 'product' });
    const { assets } = await attachProjectAsset({ userId: maya, projectId: project.id, assetId: mine.id, role: 'product' });
    expect(assets).toHaveLength(1);
    await expect(attachProjectAsset({ userId: maya, projectId: project.id, assetId: theirs.id, role: 'product' })).rejects.toMatchObject({ status: 404 });
    await expect(attachProjectAsset({ userId: maya, projectId: project.id, assetId: 'nope', role: 'product' })).rejects.toMatchObject({ status: 404 });
    await expect(attachProjectAsset({ userId: maya, projectId: project.id, assetId: clip.id, role: 'product' })).rejects.toMatchObject({ status: 422, field: 'assetId' });
    await expect(attachProjectAsset({ userId: maya, projectId: project.id, assetId: mine.id, role: 'banner' })).rejects.toMatchObject({ status: 422, field: 'role' });
  });

  it('works through the project assets action: GET, POST and DELETE', async () => {
    const { handleAction } = await import('../../lib/story/actionRoute.js');
    const { userId, project } = await newProject();
    const product = await upload(userId, 'product', 'photo.jpg');
    globalThis.__assetSession = { user: { id: userId } };
    const run = async (method, body) => {
      const res = makeRes();
      await handleAction(makeReq({ method, body, query: { id: project.id } }), res, 'assets');
      return res;
    };
    expect((await run('POST', { assetId: product.id, role: 'product' })).body.assets).toMatchObject([{ id: product.id, role: 'product', kind: 'product' }]);
    expect((await run('GET')).body.assets).toHaveLength(1);
    expect((await run('DELETE', { assetId: product.id })).body.assets).toEqual([]);
    expect((await run('POST', { assetId: product.id, role: 'banner' })).statusCode).toBe(422);
  });
});

// ---------------------------------------------------------------- own footage and insets

describe('footage shots and insets', () => {
  it('a shot becomes a footage shot with its trim and fit (contain by default), and goes back', async () => {
    const { userId, project, shots } = await newProject();
    const clip = await upload(userId, 'clip', 'clip.mp4');
    const patch = (p, id = shots[0].id) => updateShot({ userId, projectId: project.id, shotId: id, patch: p });
    let { shot } = await patch({ source: 'footage', footage_asset_id: clip.id });
    expect(shot).toMatchObject({ source: 'footage', footage_asset_id: clip.id, footage: { trimStart: 0, fit: 'contain' } });
    ({ shot } = await patch({ footage: { trimStart: 0.5, fit: 'cover' } }));
    expect(shot.footage).toEqual({ trimStart: 0.5, fit: 'cover' });
    ({ shot } = await patch({ footage: { trimStart: 1 } }));
    expect(shot.footage).toEqual({ trimStart: 1, fit: 'cover' });
    ({ shot } = await patch({ source: 'generated' }));
    expect(shot).toMatchObject({ source: 'generated', footage_asset_id: null, footage: null, still_url: '/still/0.png' });
  });

  it('refuses a footage shot with no clip, a picture or a voice as footage, a bad trim or fit', async () => {
    const { userId, project, shots } = await newProject();
    const photo = await upload(userId, 'product', 'photo.jpg');
    const clip = await upload(userId, 'clip', 'clip.mp4');
    const patch = (p) => updateShot({ userId, projectId: project.id, shotId: shots[0].id, patch: p });
    await expect(patch({ source: 'footage' })).rejects.toMatchObject({ status: 404 });
    await expect(patch({ source: 'footage', footage_asset_id: photo.id })).rejects.toMatchObject({ status: 422, field: 'footage_asset_id' });
    await expect(patch({ source: 'videos' })).rejects.toMatchObject({ field: 'source' });
    await expect(patch({ source: 'footage', footage_asset_id: clip.id, footage: { trimStart: -1 } })).rejects.toMatchObject({ field: 'footage' });
    await expect(patch({ source: 'footage', footage_asset_id: clip.id, footage: { trimStart: 99 } })).rejects.toMatchObject({ field: 'footage' });
    await expect(patch({ source: 'footage', footage_asset_id: clip.id, footage: { fit: 'stretch' } })).rejects.toMatchObject({ field: 'footage' });
    await expect(patch({ source: 'footage', footage_asset_id: clip.id, footage: { speed: 2 } })).rejects.toMatchObject({ field: 'footage' });
    await expect(patch({ footage_asset_id: clip.id })).rejects.toMatchObject({ field: 'footage_asset_id' });
    expect((await shotRow(shots[0].id)).source).toBe('generated');
  });

  it("another customer's asset is a missing one (404) for footage, for an inset and for a character", async () => {
    const maya = await newUser();
    const leo = await newUser();
    const { project, shots } = await newProject({ userId: maya });
    const theirClip = await upload(leo, 'clip', 'clip.mp4');
    const theirPic = await upload(leo, 'mascot', 'photo.webp');
    const patch = (p) => updateShot({ userId: maya, projectId: project.id, shotId: shots[0].id, patch: p });
    await expect(patch({ source: 'footage', footage_asset_id: theirClip.id })).rejects.toMatchObject({ status: 404 });
    await expect(patch({ inset_asset_id: theirClip.id })).rejects.toMatchObject({ status: 404 });
    const [cast] = await storyDb().insert('story_cast', { project_id: project.id, name: 'Maya', status: 'ready', image_url: '/p.png', image_key: 'p' });
    await expect(setCastImage({ userId: maya, projectId: project.id, castId: cast.id, assetId: theirPic.id })).rejects.toMatchObject({ status: 404 });
    // and Leo cannot change Maya's project at all
    await expect(updateShot({ userId: leo, projectId: project.id, shotId: shots[0].id, patch: { quality: 'standard' } })).rejects.toMatchObject({ status: 404 });
  });

  it('an inset: a picture or a clip, placed in percent, stored as the fractions the render reads', async () => {
    const { userId, project, shots } = await newProject();
    const photo = await upload(userId, 'product', 'photo.jpg');
    const clip = await upload(userId, 'recording', 'phone.mov');
    const voice = await registerAudio({ userId, kind: 'voice_track', url: store(userId, 'v.wav', files['twelve.wav'], `story-audio/${userId}/`).url });
    const patch = (p) => updateShot({ userId, projectId: project.id, shotId: shots[0].id, patch: p });
    let { shot } = await patch({ inset_asset_id: photo.id });
    expect(shot).toMatchObject({ inset_asset_id: photo.id, inset: { x: 0.5, y: 0.3, w: 0.45 }, source: 'generated' });
    ({ shot } = await patch({ inset: { x: 70, w: 30 } }));
    expect(shot.inset).toEqual({ x: 0.7, y: 0.3, w: 0.3 });
    ({ shot } = await patch({ inset_asset_id: clip.id, inset: { x: 25, y: 80, w: 40 } }));
    expect(shot).toMatchObject({ inset_asset_id: clip.id, inset: { x: 0.25, y: 0.8, w: 0.4 } });
    await expect(patch({ inset: { x: 0 } })).rejects.toMatchObject({ field: 'inset' });
    await expect(patch({ inset: { w: 95 } })).rejects.toMatchObject({ field: 'inset' });
    await expect(patch({ inset: { x: '50' } })).rejects.toMatchObject({ field: 'inset' });
    await expect(patch({ inset: { z: 1 } })).rejects.toMatchObject({ field: 'inset' });
    await expect(patch({ inset_asset_id: voice.id })).rejects.toMatchObject({ status: 422, field: 'inset_asset_id' });
    ({ shot } = await patch({ inset_asset_id: null }));
    expect(shot).toMatchObject({ inset_asset_id: null, inset: null });
    await expect(patch({ inset: { x: 50 } })).rejects.toMatchObject({ field: 'inset' });
  });

  it('the shot list shows the footage and inset files, only the owner\'s', async () => {
    const { userId, project, shots } = await newProject();
    const clip = await upload(userId, 'clip', 'clip.mp4');
    const photo = await upload(userId, 'product', 'photo.jpg');
    await updateShot({ userId, projectId: project.id, shotId: shots[0].id, patch: { source: 'footage', footage_asset_id: clip.id, inset_asset_id: photo.id } });
    const view = await shotsView(project.id);
    expect(view[0]).toMatchObject({ footage_url: clip.url, footage_name: 'clip.mp4', inset_url: photo.url, inset_is_image: true, still_credits: null });
    expect(view[1]).toMatchObject({ footage_url: null, inset_url: null, inset_is_image: null });
    // a row pointing at someone else's file (not reachable through the API) shows nothing
    const other = await upload(await newUser(), 'clip', 'clip.mp4');
    await storyDb().update('story_shots', { id: shots[1].id }, { footage_asset_id: other.id, source: 'footage' });
    expect((await shotsView(project.id))[1].footage_url).toBeNull();
  });

  it('footage shots are left out of quotes, and cannot be generated', async () => {
    const { userId, project, shots } = await newProject({ shots: 3 });
    const before = await quoteGeneration({ userId, projectId: project.id });
    expect(before.shotIds).toHaveLength(3);
    const clip = await upload(userId, 'clip', 'clip.mp4');
    await updateShot({ userId, projectId: project.id, shotId: shots[1].id, patch: { source: 'footage', footage_asset_id: clip.id } });
    const after = await quoteGeneration({ userId, projectId: project.id });
    expect(after.shotIds).toEqual([shots[0].id, shots[2].id]);
    expect(after.total).toBeLessThan(before.total);
    expect(after.total).toBe(before.total - before.total / 3); // the three shots cost the same
    await expect(quoteGeneration({ userId, projectId: project.id, shotIds: [shots[1].id] })).rejects.toMatchObject({ status: 422 });
    const out = await startGeneration({ userId, projectId: project.id, confirmTotal: after.total });
    expect(out.queued).toHaveLength(2);
    expect((await storyDb().select('story_jobs', { project_id: project.id, kind: 'clip' })).map((j) => j.shot_id).sort()).toEqual([shots[0].id, shots[2].id].sort());
    expect((await shotRow(shots[1].id)).status).toBe('still_ready');
  });

  it('a footage shot carries its scene_sig, so a script change marks it stale like any shot', async () => {
    const { userId, project, shots } = await newProject();
    const clip = await upload(userId, 'clip', 'clip.mp4');
    await updateShot({ userId, projectId: project.id, shotId: shots[0].id, patch: { source: 'footage', footage_asset_id: clip.id } });
    expect((await shotRow(shots[0].id)).scene_sig).toBe(sceneSig(SCENES[0]));
    expect((await shotsView(project.id)).every((s) => !s.needs_rebuild)).toBe(true);
    await updateScene({ userId, projectId: project.id, sceneId: 's1', patch: { visual: 'Maya sweeps the shop at dawn instead.' } });
    await markStale({ projectId: project.id, sceneIds: ['s1'] });
    expect((await shotRow(shots[0].id)).stale).toBe(true);
    expect((await shotsView(project.id))[0].needs_rebuild).toBe(true);
    // the other scene's shot still carries its own sig
    const other = await shotRow(shots[1].id);
    expect(other.scene_sig).toBe(sceneSig(SCENES[1]));
  });

  it('switching a shot to footage clears the stale flags left from its generated state', async () => {
    const { userId, project, shots } = await newProject();
    const clip = await upload(userId, 'clip', 'clip.mp4');
    await storyDb().update('story_shots', { id: shots[0].id }, { stale: true, clip_mismatch: true, clip_url: '/c.mp4', clip_key: 'c' });
    const { shot } = await updateShot({ userId, projectId: project.id, shotId: shots[0].id, patch: { source: 'footage', footage_asset_id: clip.id } });
    expect(shot).toMatchObject({ stale: false, clip_mismatch: false });
  });

  it('a rebuild that would remove a footage shot or a picture-in-picture asks first, and applies the confirmed plan', async () => {
    const { userId, project, shots } = await newProject({ shots: 4 });
    await storyDb().insert('story_cast', ['Maya', 'Leo'].map((name, ord) => ({ project_id: project.id, ord, name, status: 'ready', image_url: `/p/${name}.png`, image_key: name })));
    const clip = await upload(userId, 'clip', 'clip.mp4');
    const photo = await upload(userId, 'image', 'photo.jpg');
    await updateShot({ userId, projectId: project.id, shotId: shots[0].id, patch: { source: 'footage', footage_asset_id: clip.id } });
    await updateShot({ userId, projectId: project.id, shotId: shots[2].id, patch: { inset_asset_id: photo.id } });
    // scene s1 leaves the script: its shots (0 and 2) go
    await storyDb().update('story_scripts', { project_id: project.id, version: 1 }, { scenes: [SCENES[1]] });
    const err = await buildShotList({ userId, projectId: project.id }).catch((e) => e);
    expect(err).toMatchObject({ status: 409, code: 'rebuild_loses_clips', extra: { count: 0, own: 2 } });
    expect(err.message).toMatch(/2 shots with your own footage or picture-in-picture/);
    expect((await storyDb().select('story_shots', { project_id: project.id })).length).toBe(4);
    await buildShotList({ userId, projectId: project.id, confirm: err.extra.token });
    expect((await storyDb().select('story_shots', { project_id: project.id })).map((s) => s.id).sort()).toEqual([shots[1].id, shots[3].id].sort());
  });

  it('cannot change a shot that is being made', async () => {
    const { userId, project, shots } = await newProject();
    const clip = await upload(userId, 'clip', 'clip.mp4');
    await storyDb().update('story_shots', { id: shots[0].id }, { status: 'generating' });
    await expect(updateShot({ userId, projectId: project.id, shotId: shots[0].id, patch: { source: 'footage', footage_asset_id: clip.id } })).rejects.toMatchObject({ status: 409 });
  });
});

// ---------------------------------------------------------------- the character's own picture

describe('a character with the customer\'s own picture', () => {
  async function withCast() {
    const ctx = await newProject({ shots: 3 });
    const [maya, leo] = await storyDb().insert('story_cast', ['Maya', 'Leo'].map((name, ord) => ({
      project_id: ctx.project.id, ord, name, status: 'ready', image_url: `/pick/${name}.png`, image_key: `pick-${name}`, chosen_index: 0, candidates: [{ url: `/pick/${name}.png`, key: `pick-${name}` }],
      sheet: { url: `/sheet/${name}.png`, key: `sheet-${name}`, from_key: `pick-${name}` },
    })));
    await storyDb().update('story_shots', { id: ctx.shots[0].id }, { cast_ids: [maya.id], clip_url: '/clip/0.mp4', clip_key: 'clip-0', status: 'ready' });
    await storyDb().update('story_shots', { id: ctx.shots[1].id }, { cast_ids: [maya.id, leo.id] });
    await storyDb().update('story_shots', { id: ctx.shots[2].id }, { cast_ids: [leo.id] });
    return { ...ctx, maya, leo };
  }

  it('uses the picture as the character\'s image, drops the sheet, and marks the shots with that character stale', async () => {
    const { userId, project, shots, maya, leo } = await withCast();
    const face = await upload(userId, 'mascot', 'photo.webp');
    const { cast } = await setCastImage({ userId, projectId: project.id, castId: maya.id, assetId: face.id });
    expect(cast).toMatchObject({ asset_id: face.id, image_url: face.url, status: 'ready', chosen_index: null, sheet: {} });
    const rows = await Promise.all(shots.map((s) => shotRow(s.id)));
    expect(rows[0]).toMatchObject({ stale: true, clip_mismatch: true });
    expect(rows[1]).toMatchObject({ stale: true, clip_mismatch: false });
    expect(rows[2]).toMatchObject({ stale: false });
    expect((await storyDb().select('story_cast', { id: leo.id }))[0].image_url).toBe('/pick/Leo.png');
    // the stills now draw from the picture
    await storyDb().update('story_shots', { id: shots[1].id }, { status: 'draft', still_url: null, still_key: null });
    await generateStills({ userId, projectId: project.id, shotIds: [shots[1].id] });
    const [job] = await storyDb().select('story_jobs', { project_id: project.id, kind: 'still' });
    expect(job.payload.refs).toEqual([face.url, '/sheet/Leo.png']);
    await tick({ projectId: project.id });
  });

  it('is the same call again, a no-op; a character being drawn is refused; only the caller\'s pictures', async () => {
    const { userId, project, shots, maya } = await withCast();
    const face = await upload(userId, 'mascot', 'photo.webp');
    const clip = await upload(userId, 'clip', 'clip.mp4');
    await setCastImage({ userId, projectId: project.id, castId: maya.id, assetId: face.id });
    await storyDb().update('story_shots', { id: shots[0].id }, { stale: false, clip_mismatch: false });
    await setCastImage({ userId, projectId: project.id, castId: maya.id, assetId: face.id });
    expect((await shotRow(shots[0].id)).stale).toBe(false);
    await expect(setCastImage({ userId, projectId: project.id, castId: maya.id, assetId: clip.id })).rejects.toMatchObject({ status: 422, field: 'assetId' });
    await expect(setCastImage({ userId, projectId: project.id, castId: maya.id, assetId: randomUUID() })).rejects.toMatchObject({ status: 404 });
    await expect(setCastImage({ userId: randomUUID(), projectId: project.id, castId: maya.id, assetId: face.id })).rejects.toMatchObject({ status: 404 });
    await expect(setCastImage({ userId, projectId: project.id, castId: randomUUID(), assetId: face.id })).rejects.toMatchObject({ status: 404 });
    await storyDb().update('story_cast', { id: maya.id }, { status: 'pending' });
    const logo = await upload(userId, 'logo', 'logo.png');
    await expect(setCastImage({ userId, projectId: project.id, castId: maya.id, assetId: logo.id })).rejects.toMatchObject({ status: 409 });
  });

  it('picking another drawn option marks the shots with that character stale; picking the same one again marks nothing', async () => {
    const { userId, project, shots, maya } = await withCast();
    await storyDb().update('story_cast', { id: maya.id }, { candidates: [{ url: '/pick/Maya.png', key: 'pick-Maya' }, { url: '/pick/Maya2.png', key: 'pick-Maya2' }] });
    await pickCast({ userId, projectId: project.id, castId: maya.id, candidateIndex: 0 });
    for (const s of shots) expect((await shotRow(s.id)).stale).toBe(false);
    await pickCast({ userId, projectId: project.id, castId: maya.id, candidateIndex: 1 });
    expect(await shotRow(shots[0].id)).toMatchObject({ stale: true, clip_mismatch: true });
    expect(await shotRow(shots[1].id)).toMatchObject({ stale: true, clip_mismatch: false });
    expect((await shotRow(shots[2].id)).stale).toBe(false);
    await storyDb().update('story_shots', { project_id: project.id }, { stale: false, clip_mismatch: false });
    await pickCast({ userId, projectId: project.id, castId: maya.id, candidateIndex: 1 });
    for (const s of shots) expect((await shotRow(s.id)).stale).toBe(false);
  });

  it('giving up the own picture for a drawn option marks the shots stale too', async () => {
    const { userId, project, shots, maya } = await withCast();
    const face = await upload(userId, 'image', 'photo.webp');
    await setCastImage({ userId, projectId: project.id, castId: maya.id, assetId: face.id });
    await storyDb().update('story_shots', { project_id: project.id }, { stale: false, clip_mismatch: false });
    await pickCast({ userId, projectId: project.id, castId: maya.id, candidateIndex: 0 });
    expect(await shotRow(shots[1].id)).toMatchObject({ stale: true });
  });

  it('picking one of the drawn options again takes the own picture off the character, so the file can be deleted', async () => {
    const { userId, project, maya } = await withCast();
    const face = await upload(userId, 'mascot', 'photo.webp');
    await setCastImage({ userId, projectId: project.id, castId: maya.id, assetId: face.id });
    await expect(deleteAsset({ userId, assetId: face.id })).rejects.toMatchObject({ status: 409, code: 'asset_in_use', extra: { projects: [{ id: project.id, title: project.title }] } });
    const { cast } = await pickCast({ userId, projectId: project.id, castId: maya.id, candidateIndex: 0 });
    expect(cast).toMatchObject({ asset_id: null, image_url: '/pick/Maya.png', chosen_index: 0 });
    expect(await deleteAsset({ userId, assetId: face.id })).toEqual({ id: face.id });
  });

  it('an expired project copy keeps a character\'s own picture (kit files do not expire) and drops only the drawn options', async () => {
    const { userId, project, maya, leo } = await withCast();
    const face = await upload(userId, 'image', 'photo.webp');
    await setCastImage({ userId, projectId: project.id, castId: maya.id, assetId: face.id });
    await storyDb().update('story_projects', { id: project.id }, { status: 'expired' });
    const copy = await duplicateProject({ userId, id: project.id });
    const rows = await storyDb().select('story_cast', { project_id: copy.id }, { order: 'ord' });
    expect(rows[0]).toMatchObject({ name: 'Maya', status: 'ready', asset_id: face.id, image_url: face.url, candidates: [], sheet: {} });
    expect(rows[1]).toMatchObject({ name: 'Leo', status: 'draft', asset_id: null, image_url: null });
    expect(leo.id).toBeTruthy();
  });

  it('works through the cast-image action', async () => {
    const { handleAction } = await import('../../lib/story/actionRoute.js');
    const { userId, project, maya } = await withCast();
    const face = await upload(userId, 'mascot', 'photo.webp');
    globalThis.__assetSession = { user: { id: userId } };
    const res = makeRes();
    await handleAction(makeReq({ method: 'POST', body: { castId: maya.id, assetId: face.id }, query: { id: project.id } }), res, 'cast-image');
    expect(res.statusCode).toBe(200);
    expect(res.body.cast).toMatchObject({ asset_id: face.id, image_url: face.url });
    const bad = makeRes();
    await handleAction(makeReq({ method: 'POST', body: { assetId: face.id }, query: { id: project.id } }), bad, 'cast-image');
    expect(bad.statusCode).toBe(422);
  });
});

// ---------------------------------------------------------------- the upload token

describe('the upload token route, story-brand surface', () => {
  const token = async (session, pathname, surface = 'story-brand') => {
    const { default: route } = await import('../../pages/api/upload-token.js');
    globalThis.__assetSession = session;
    const res = makeRes();
    await route(makeReq({ method: 'POST', body: { type: 'blob.generate-client-token', payload: { pathname, clientPayload: JSON.stringify({ surface }) } } }), res);
    return res;
  };

  it('gives pictures 5 MB of image types and clips 200 MB of video types, in the caller\'s own folder only', async () => {
    const userId = randomUUID();
    const me = { user: { id: userId } };
    const image = await token(me, `story-brand/${userId}/my logo.png`);
    expect(image.statusCode).toBe(200);
    expect(image.body.options).toMatchObject({ maximumSizeInBytes: 5 * 1024 * 1024, addRandomSuffix: true, allowedContentTypes: ['image/png'] });
    const video = await token(me, `story-brand/${userId}/take.mov`);
    expect(video.body.options).toMatchObject({ maximumSizeInBytes: 200 * 1024 * 1024, allowedContentTypes: ['video/quicktime'] });
    expect((await token(me, `story-brand/${userId}/a.jpeg`)).body.options.allowedContentTypes).toEqual(['image/jpeg']);
    expect((await token(me, `story-brand/${userId}/a.mp4`)).body.options.allowedContentTypes).toEqual(['video/mp4']);
    for (const name of ['jpg', 'jpeg', 'webp', 'mp4']) expect((await token(me, `story-brand/${userId}/a.${name}`)).statusCode).toBe(200);
    const bad = [
      `story-brand/${randomUUID()}/a.png`, `story-brand/${userId}/a.gif`, `story-brand/${userId}/a.html`, `story-brand/${userId}/a.svg`, `story-brand/${userId}/sub/a.png`,
      `story-brand/${userId}/../x.png`, `elsewhere/${userId}/a.png`, `story-brand/${userId}/`, `story-brand/${userId}/a.mp3`,
    ];
    for (const pathname of bad) expect((await token(me, pathname)).statusCode, pathname).toBe(400);
    expect((await token(null, `story-brand/${userId}/a.png`)).statusCode).toBe(401);
  });

  it('the plain signed-in surface cannot write into story-brand/, also written percent-encoded or in other case', async () => {
    const userId = randomUUID();
    const me = { user: { id: userId } };
    for (const pathname of [`story-brand/${userId}/a.png`, `story-brand%2F${userId}%2Fa.png`, `Story-Brand/${userId}/a.png`, `/story-brand/${userId}/a.png`, `story%2Dbrand/${userId}/a.png`]) {
      expect((await token(me, pathname, 'plain')).statusCode, pathname).toBe(400);
    }
    expect((await token(me, 'uploads/a.png', 'plain')).statusCode).toBe(200);
    expect((await token(me, 'my story-brand/a.png', 'plain')).statusCode).toBe(200);
    expect((await token(me, '50% off.jpg', 'plain')).statusCode).toBe(200);
  });
});

describe('the demuxer helpers', () => {
  it('force the image demuxer the type promised, and only the file protocol', () => {
    expect(imageInputArgs('image/png')).toEqual(['-protocol_whitelist', 'file', '-f', 'image2', '-pattern_type', 'none', '-c:v', 'png']);
    expect(imageInputArgs('image/jpeg')).toEqual(['-protocol_whitelist', 'file', '-f', 'image2', '-pattern_type', 'none', '-c:v', 'mjpeg']);
    expect(imageInputArgs('image/webp')).toEqual(['-protocol_whitelist', 'file', '-f', 'image2', '-pattern_type', 'none', '-c:v', 'webp']);
    expect(() => imageInputArgs('image/gif')).toThrow();
    expect(imageMime('image/png', 'x.bin')).toBe('image/png');
    expect(imageMime(null, 'https://abc.public.blob.vercel-storage.com/story-brand/u/a-1.JPG?x=1')).toBe('image/jpeg');
    expect(imageMime('text/html', 'a.txt')).toBeNull();
  });
});
