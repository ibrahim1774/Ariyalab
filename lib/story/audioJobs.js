import { releaseHold } from '../credits.js';
import { ProviderError } from '../providers/errors.js';
import { generateMusic } from '../providers/music.js';
import { putObject } from '../providers/storage.js';
import { synthesize } from '../providers/tts.js';
import { sliceBuffer, sliceUrl } from './audio.js';
import { storyDb } from './db.js';
import { registerHandler, settleJob } from './runner.js';

/*
 * The narration and music job handlers (loaded by lib/story/handlers.js, so
 * every route that drives the runner has them). Both are sync kinds: the
 * provider call and the file store happen in run(job), and the runner passes
 * the result to onDone. lib/story/audio.js builds the payloads:
 *
 *   narration { kind: 'first'|'regen'|'retry'|'upload', credits, source: 'generated'|'upload',
 *               voiceId, assetId, text, lines: [{ sceneId, lineIndex, text }], sig }
 *   music     { kind: 'first'|'regen'|'retry', credits, prompt, seconds }
 *
 * Results: narration { url, key, seconds, segments } (a generated track, stored
 * under story/<project>/narration/) or { trackUrl, seconds, segments } (the
 * customer's own recording, which is never ours to delete, so it has no key);
 * music { url, key }.
 *
 * onDone writes the track to the project only while this job is still the
 * project's latest job of its kind, and running it twice changes nothing more.
 * settleJob is its last step. A track that lands after a newer attempt is
 * released, not settled (the customer never sees it). A job that fails needs no
 * onFail: the runner releases its hold, and the screen reads the job's status.
 */

const EXTENSIONS = { 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/mp4': 'm4a', 'audio/aac': 'm4a', 'audio/x-m4a': 'm4a' };
const extensionFor = (mime) => EXTENSIONS[String(mime || '').split(';')[0].trim().toLowerCase()] || 'mp3';

async function latestJobId(projectId, kind) {
  const rows = await storyDb().select('story_jobs', { project_id: projectId, kind }, { columns: ['id', 'created_at'], order: ['-created_at', '-id'], limit: 1 });
  return rows[0]?.id ?? null;
}

/** True while this job is the newest of its kind; otherwise gives its hold share back. */
async function stillCurrent(job) {
  if ((await latestJobId(job.project_id, job.kind)) === job.id) return true;
  if (job.hold_id && job.cost_credits > 0) await releaseHold({ holdId: job.hold_id, amount: job.cost_credits, ref: `job:${job.id}` });
  return false;
}

export const narrationHandler = {
  sync: true,

  run: async (job) => {
    const p = job.payload || {};
    if (p.source === 'upload') {
      const [asset] = await storyDb().select('story_assets', { id: p.assetId, user_id: job.user_id });
      if (!asset) throw new ProviderError('failed', 'Your recording could not be found. Pick it again.');
      const cut = await sliceUrl({ url: asset.url, lines: p.lines });
      return { trackUrl: asset.url, seconds: cut.duration, segments: cut.segments, method: cut.method };
    }
    const { buffer, mime } = await synthesize({ voiceId: p.voiceId, text: p.text });
    const ext = extensionFor(mime);
    const stored = await putObject({ key: `story/${job.project_id}/narration/${job.id}.${ext}`, body: buffer });
    // The voice is paid for and stored; a cutting problem must not lose it, so the track is kept uncut.
    const cut = await sliceBuffer({ buffer, ext, lines: p.lines }).catch((err) => {
      console.error('[story] could not cut the narration into lines', job.id, err?.message);
      return null;
    });
    return { url: stored.url, key: stored.key, seconds: cut?.duration ?? null, segments: cut?.segments ?? null, method: cut?.method ?? null };
  },

  onDone: async (job, result) => {
    if (!(await stillCurrent(job))) return;
    await storyDb().update('story_projects', { id: job.project_id }, {
      narration_url: result.url ?? result.trackUrl ?? null,
      narration_key: result.key ?? null,
      narration_seconds: result.seconds ?? null,
      narration_segments: result.segments ?? null,
    });
    await settleJob(job);
  },
};

export const musicHandler = {
  sync: true,

  run: async (job) => {
    const p = job.payload || {};
    const { buffer, mime } = await generateMusic({ prompt: p.prompt, seconds: p.seconds });
    const stored = await putObject({ key: `story/${job.project_id}/music/${job.id}.${extensionFor(mime)}`, body: buffer });
    return { url: stored.url, key: stored.key };
  },

  onDone: async (job, result) => {
    if (!(await stillCurrent(job))) return;
    await storyDb().update('story_projects', { id: job.project_id }, { music_url: result.url, music_key: result.key });
    await settleJob(job);
  },
};

registerHandler('narration', narrationHandler);
registerHandler('music', musicHandler);
