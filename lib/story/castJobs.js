import { getImage, submitImage } from '../providers/image.js';
import { HoldClosedError, HoldExceededError, holdHasEntry, releaseHold } from '../credits.js';
import { storyDb } from './db.js';
import { registerHandler, settleJob } from './runner.js';

/*
 * The cast_image job handler (loaded by lib/story/handlers.js, so every route
 * that drives the runner has it). Two stages share the kind, told apart by
 * payload.stage; lib/story/cast.js builds the payloads:
 *
 *   candidate  one of the 3 pictures to choose from for a character
 *              { stage, castId, round, slot, prompt, aspect, note }
 *   sheet      the cast sheet (front, three quarter and close up in one
 *              image) made from the picked picture
 *              { stage, castId, round, fromKey, refs: [pickedUrl], prompt, aspect }
 *
 * Both are safe to run twice and at the same moment as their siblings:
 *   candidate  story_cast_apply (SQL) takes the row lock, sets this slot and
 *              recomputes the row's status from the round's jobs. A job from
 *              an older round does nothing.
 *   sheet      one update that only matches while the customer's pick is
 *              still the picture the sheet was made from.
 * onFail is database only. Settling goes through settleJob, as the last step
 * of onDone, and only when this job's picture was written. A picture that was
 * not written (its round moved on, or the pick changed under its sheet) is
 * discarded, so its share is released instead (ref `job:<id>`, the runner's own
 * release ref, so any later release of it is a replay). Initial pictures and
 * the sheet carry no hold (the project fee covers them); a paid regeneration
 * holds its price, split over its 3 jobs.
 */

/**
 * Gives back the hold share of a job whose picture was discarded. Nothing to do
 * without a share, or when the share was already settled (an earlier run wrote
 * and settled before the round moved on). A closed, used up or missing hold
 * has nothing left to give.
 */
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

export const castImageHandler = {
  submit: async (job) => submitImage({
    prompt: job.payload.prompt,
    refs: job.payload.refs || [],
    aspect: job.payload.aspect,
  }),

  poll: async (job) => getImage({ provider: job.provider, taskId: job.provider_task_id }),

  onDone: async (job, { url, key }) => {
    const p = job.payload || {};
    let written;
    if (p.stage === 'sheet') {
      const rows = await storyDb().update(
        'story_cast',
        { id: p.castId, project_id: job.project_id, image_key: p.fromKey },
        { sheet: { url, key, from_key: p.fromKey } }
      );
      written = rows.length > 0;
    } else {
      // null: the row is gone or the job's round is no longer current, so nothing was written.
      written = (await storyDb().rpc('story_cast_apply', {
        p_cast: p.castId, p_round: p.round, p_slot: p.slot, p_url: url, p_key: key, p_prompt: p.prompt, p_job: job.id,
      })) !== null;
    }
    if (written) await settleJob(job);
    else await releaseDiscarded(job);
  },

  onFail: async (job) => {
    const p = job.payload || {};
    // A failed sheet leaves the pick as it is; picking again makes a new sheet job.
    if (p.stage === 'sheet') return;
    await storyDb().rpc('story_cast_apply', { p_cast: p.castId, p_round: p.round, p_slot: p.slot, p_job: job.id });
  },
};

registerHandler('cast_image', castImageHandler);
