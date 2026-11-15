import { getImage, submitImage } from '../providers/image.js';
import { HoldClosedError, releaseHold } from '../credits.js';
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
 * of onDone, and the runner releases the hold of a job that fails. A picture
 * that lands after its shot is gone or has moved on is released, not settled.
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
    // A new picture on a shot that has a clip: the clip no longer matches it. One update sets all of it.
    // The match includes the clip read just before, so the flags always describe the row they land on.
    const [current] = await storyDb().select('story_shots', { id: p.shotId, project_id: job.project_id });
    const applied = current ? await storyDb().update(
      'story_shots',
      { id: p.shotId, project_id: job.project_id, still_round: p.round, status: 'still_pending', clip_url: current.clip_url ?? null },
      {
        still_url: url, still_key: key, status: 'still_ready', error: null, still_delivered: true,
        ...(current.clip_url ? { stale: true, clip_mismatch: true } : {}),
      }
    ) : [];
    if (!applied.length) {
      const [row] = await storyDb().select('story_shots', { id: p.shotId });
      const alreadyApplied = row && row.still_round === p.round && row.still_key === key;
      if (!alreadyApplied) {
        // The shot is gone or moved on: the customer never sees this picture, so it is not charged.
        if (job.hold_id && job.cost_credits > 0) {
          try {
            await releaseHold({ holdId: job.hold_id, amount: job.cost_credits, ref: `job:${job.id}` });
          } catch (err) {
            // Already given back (the start that queued this job was put back and released its whole hold).
            if (!(err instanceof HoldClosedError) && !/hold_not_found/.test(err?.message || '')) throw err;
          }
        }
        return;
      }
    }
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
