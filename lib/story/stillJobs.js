import { getImage, submitImage } from '../providers/image.js';
import { storyDb } from './db.js';
import { registerHandler, settleJob } from './runner.js';

/*
 * The still job handler (loaded by lib/story/handlers.js, so every route that
 * drives the runner has it). lib/story/storyboard.js builds the payload:
 *
 *   { shotId, round, kind: 'first'|'reroll'|'retry', credits, prompt, refs, aspect }
 *
 * round is the shot's still_round when the job was queued. Both callbacks
 * write only while the shot is still waiting for that round, so a job the
 * customer has moved past (a new description, a newer attempt) changes
 * nothing, and running either callback twice changes nothing more.
 * onFail is database only. A paid attempt (re-roll, or the retry of a failed
 * re-roll) carries a hold; settling goes through settleJob, as the last step
 * of onDone, and the runner releases the hold of a job that fails.
 */

const FAILED_MESSAGE = 'The picture could not be made. Try again.';
const BLOCKED_MESSAGE = 'This picture was stopped by our content rules. Change the description and make it again.';

export const stillHandler = {
  submit: async (job) => submitImage({
    prompt: job.payload.prompt,
    refs: job.payload.refs || [],
    aspect: job.payload.aspect,
  }),

  poll: async (job) => getImage({ provider: job.provider, taskId: job.provider_task_id }),

  onDone: async (job, { url, key }) => {
    const p = job.payload || {};
    await storyDb().update(
      'story_shots',
      { id: p.shotId, project_id: job.project_id, still_round: p.round, status: 'still_pending' },
      { still_url: url, still_key: key, status: 'still_ready', error: null }
    );
    await settleJob(job);
  },

  onFail: async (job, { blocked } = {}) => {
    const p = job.payload || {};
    await storyDb().update(
      'story_shots',
      { id: p.shotId, project_id: job.project_id, still_round: p.round, status: 'still_pending' },
      { status: blocked ? 'blocked' : 'failed', error: blocked ? BLOCKED_MESSAGE : FAILED_MESSAGE }
    );
  },
};

registerHandler('still', stillHandler);
