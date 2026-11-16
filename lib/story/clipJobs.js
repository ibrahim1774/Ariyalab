import { getClip, submitClip } from '../providers/video.js';
import { HoldClosedError, HoldExceededError, holdHasEntry, releaseHold } from '../credits.js';
import { storyDb } from './db.js';
import { callbackUrl, registerHandler, settleJob } from './runner.js';
import { sceneSig } from './storyboard.js';

/*
 * The clip job handler (loaded by lib/story/handlers.js, so every route that
 * drives the runner has it). lib/story/shots.js builds the payload:
 *
 *   { shotId, round, claimId, kind: 'first'|'retry'|'reroll'|'reroll_free', credits,
 *     prompt, imageUrl, seconds, quality, aspect }
 *
 * round is the shot's clip_round when the job was queued. Both callbacks
 * write only while the shot is still 'queued' for that round, so a job the
 * customer has moved past changes nothing, a shot that went back to making
 * its picture (still_pending) never gets a clip, and running either callback
 * twice changes nothing more.
 * onDone sets the clip, 'ready', clip_mismatch false and stale from the
 * scene's signature now (a scene edited while the clip was made stays stale);
 * settleJob is its last step. A clip that is not written (the row is gone or
 * moved on) is discarded: its share is released, not settled (ref `job:<id>`,
 * the runner's own release ref). onFail is database only (the runner has
 * already released the share): 'failed' or 'blocked' with a message the
 * customer can read. A failed re-roll keeps the earlier clip on the row.
 */

const FAILED_MESSAGE = 'This clip could not be made. Try again.';
const BLOCKED_MESSAGE = 'This clip was stopped by our content rules. Change the description, then make it again.';

async function releaseDiscarded(job) {
  if (!job.hold_id || !(job.cost_credits > 0)) return;
  if (await holdHasEntry({ holdId: job.hold_id, op: 'settle', ref: `job:${job.id}:settle` })) return;
  try {
    await releaseHold({ holdId: job.hold_id, amount: job.cost_credits, ref: `job:${job.id}` });
  } catch (err) {
    if (err instanceof HoldClosedError || err instanceof HoldExceededError || /hold_not_found/.test(err?.message || '')) return;
    throw err;
  }
}

async function currentSig(projectId, sceneId) {
  const [script] = await storyDb().select('story_scripts', { project_id: projectId }, { order: '-version', limit: 1 });
  const scene = (script?.scenes || []).find((s) => s.id === sceneId);
  return scene ? sceneSig(scene) : null;
}

export const clipHandler = {
  submit: async (job) => {
    const p = job.payload || {};
    return submitClip({
      quality: p.quality, imageUrl: p.imageUrl, prompt: p.prompt, seconds: p.seconds, aspect: p.aspect, callbackUrl: callbackUrl(job),
    });
  },

  poll: async (job) => getClip({ provider: job.provider, taskId: job.provider_task_id }),

  onDone: async (job, { url, key }) => {
    const p = job.payload || {};
    const [current] = await storyDb().select('story_shots', { id: p.shotId, project_id: job.project_id });
    let applied = [];
    if (current && current.status === 'queued' && current.clip_round === p.round) {
      const sig = await currentSig(job.project_id, current.scene_id);
      applied = await storyDb().update(
        'story_shots',
        { id: p.shotId, project_id: job.project_id, clip_round: p.round, status: 'queued' },
        {
          clip_url: url, clip_key: key, status: 'ready', error: null, clip_prev: null, attempts: p.round,
          clip_mismatch: false, stale: !sig || current.scene_sig !== sig,
        }
      );
    }
    if (!applied.length) {
      const [row] = await storyDb().select('story_shots', { id: p.shotId });
      const alreadyApplied = row && row.clip_round === p.round && row.clip_key === key;
      if (!alreadyApplied) {
        await releaseDiscarded(job);
        return;
      }
    }
    await settleJob(job);
  },

  onFail: async (job, { blocked } = {}) => {
    const p = job.payload || {};
    await storyDb().update(
      'story_shots',
      { id: p.shotId, project_id: job.project_id, clip_round: p.round, status: 'queued' },
      { status: blocked ? 'blocked' : 'failed', error: blocked ? BLOCKED_MESSAGE : FAILED_MESSAGE, clip_prev: null }
    );
  },
};

registerHandler('clip', clipHandler);
