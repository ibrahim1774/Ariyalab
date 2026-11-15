import { getImage, submitImage } from '../providers/image.js';
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
 * of onDone. Initial pictures and the sheet carry no hold (the project fee
 * covers them); a paid regeneration holds its price, split over its 3 jobs.
 */

export const castImageHandler = {
  submit: async (job) => submitImage({
    prompt: job.payload.prompt,
    refs: job.payload.refs || [],
    aspect: job.payload.aspect,
  }),

  poll: async (job) => getImage({ provider: job.provider, taskId: job.provider_task_id }),

  onDone: async (job, { url, key }) => {
    const p = job.payload || {};
    if (p.stage === 'sheet') {
      await storyDb().update(
        'story_cast',
        { id: p.castId, project_id: job.project_id, image_key: p.fromKey },
        { sheet: { url, key, from_key: p.fromKey } }
      );
    } else {
      await storyDb().rpc('story_cast_apply', {
        p_cast: p.castId, p_round: p.round, p_slot: p.slot, p_url: url, p_key: key, p_prompt: p.prompt,
      });
    }
    await settleJob(job);
  },

  onFail: async (job) => {
    const p = job.payload || {};
    // A failed sheet leaves the pick as it is; picking again makes a new sheet job.
    if (p.stage === 'sheet') return;
    await storyDb().rpc('story_cast_apply', { p_cast: p.castId, p_round: p.round, p_slot: p.slot });
  },
};

registerHandler('cast_image', castImageHandler);
