import { ModerationError } from '../moderation.js';
import { storyDb } from './db.js';
import { StoryError } from './errors.js';
import { releaseAllowance } from './limits.js';
import { registerHandler } from './runner.js';
import { reviseScript, writeScript } from './script.js';
import { assertNoShotBeingMade, updateProject } from './projects.js';
import { draftCastCharacters } from './cast.js';
import { buildShotList } from './storyboard.js';

/*
 * Drafting jobs (job kind 'script'): the model steps the MCP connector queues
 * instead of awaiting them inside /api/mcp (maxDuration 25). A worker kind
 * (lib/story/runner.js WORKER_KINDS): only /api/story/worker/draft runs it
 * (maxDuration 300), one claim per invocation; the cron and the tool that
 * queued it kick that route.
 *
 *   payload.task   'write'  writeScript, with the script_write count the tool took (payload.receipt)
 *                  'revise' reviseScript(payload.instruction), with the script_revise count the tool took
 *                  'mode'   set_mode's rewrite (chat confirm card): reviseScript(payload.instruction) written for payload.mode, then
 *                           the project's mode is set, with the script_revise count the card took (payload.receipt). Refused with
 *                           shots_busy (nothing changed) while a shot is being made. The script is saved first and the mode second: a run
 *                           that died between them is retried and finishes by setting the mode. When the job ends without the
 *                           change, the count and the card (payload.chatId, confirmId) are given back.
 *                  'cast'   draftCastCharacters: the characters only; nothing saved or charged
 *                           (generate_cast's confirm step starts them, lib/mcp/tools.js)
 *                  'shots'  buildShotList (payload.rebuildToken confirms a plan that removes clips), with the
 *                           shots_build count the tool took (payload.buildReceipt): a retry never counts twice.
 *                           Once any attempt asked the model, payload.model_asked is set and the count is kept
 *                           (as on the website); a job that ends without a plan and never asked gives it back once.
 *
 * write and revise tag the version they save with the job id (story_scripts.draft_job_id). A first attempt
 * always runs: a revise applies to the latest version, a write makes a new one, whatever was saved while it
 * waited. Only a retry (attempts > 1) that finds a version tagged with its own id finishes as done without
 * writing again. A tagged version found on a first attempt is not a draft this run made: the job ends with
 * the error script_changed and the count goes back.
 *
 * The handlers call the website's own services. No credit hold, spend or paid
 * work claim happens in a drafting job.
 *
 * A refusal the services raise (StoryError, ModerationError) is not retried: it
 * is the job's result { error: { code, message, count?, token? } }, read by
 * get_status and the tools. Any other failure goes through the runner (one
 * retry, then failed). The count the tool took (payload.receipt) is given back
 * when the job ends without a draft: onDone with an error result, or onFail
 * (a run that threw twice, or a killed run the sweep ended). The runner may
 * run those hooks again, so the give-back is claimed first by a compare and
 * set on story_jobs.allowance_returned_at; only the call that sets it gives
 * the count back.
 */

export const DRAFT_TASKS = Object.freeze(['write', 'revise', 'mode', 'cast', 'shots']);

function refusal(err) {
  if (err instanceof ModerationError) {
    return err.code === 'MODERATION_UNAVAILABLE'
      ? { code: 'moderation_unavailable', message: err.message }
      : { code: 'blocked', message: 'That wording is not allowed here. Try different words.' };
  }
  const out = { code: err.code, message: err.message };
  if (Number.isInteger(err.extra?.count)) out.count = err.extra.count;
  if (typeof err.extra?.token === 'string') out.token = err.extra.token;
  return out;
}

export const SCRIPT_CHANGED = Object.freeze({ code: 'script_changed', message: 'The script changed while this was waiting. Ask again.' });

/** The script version this job already saved, if any. */
async function savedByThisJob(job) {
  const [row] = await storyDb().select('story_scripts', { project_id: job.project_id, draft_job_id: job.id }, { columns: ['version'], order: '-version', limit: 1 });
  return row || null;
}

/** Marks on the job that the model was asked (kept across retries: the build count is then never given back). */
function askedTracker(job) {
  let asked = Boolean(job.payload?.model_asked);
  const tracker = {
    pending: null,
    get model() {
      return asked;
    },
    set model(value) {
      if (!value || asked) return;
      asked = true;
      // Written while the model call runs; awaited before the run returns, so a retry sees it.
      tracker.pending = storyDb().update('story_jobs', { id: job.id }, { payload: { ...job.payload, model_asked: true } }).catch((err) => {
        console.error('[story] could not mark a drafting job as having asked the model', job.id, err?.message);
      });
    },
  };
  return tracker;
}

async function draft(job) {
  const p = job.payload || {};
  const userId = job.user_id;
  const projectId = job.project_id;
  if (p.task === 'write' || p.task === 'revise' || p.task === 'mode') {
    const saved = await savedByThisJob(job);
    if (saved) {
      // Only a retry of a run that died after saving may skip; anything else is not this run's draft.
      if ((job.attempts || 0) > 1) {
        if (p.task === 'mode') await updateProject({ userId, id: projectId, patch: { mode: p.mode }, modeJob: true });
        return { script_version: saved.version, already_saved: true };
      }
      return { error: { ...SCRIPT_CHANGED } };
    }
  }
  switch (p.task) {
    case 'write': {
      const script = await writeScript({ userId, projectId, allowance: p.receipt || { userId, counters: [] }, draftJobId: job.id });
      return { script_version: script.version };
    }
    case 'revise': {
      const out = await reviseScript({ userId, projectId, instruction: p.instruction, chatCounted: true, draftJobId: job.id });
      return { script_version: out.script.version, changed_scene_ids: out.changedSceneIds };
    }
    case 'mode': {
      // The mode already is the target (something else changed it) and no rewrite of ours was saved: nothing to do, and no count.
      const [now] = await storyDb().select('story_projects', { id: projectId }, { columns: ['mode'], limit: 1 });
      if (now?.mode === p.mode) return { unchanged: true, mode: p.mode };
      // Nothing is written while a shot is being made: this refusal is the job's result, with nothing changed.
      await assertNoShotBeingMade(projectId);
      const out = await reviseScript({ userId, projectId, instruction: p.instruction, chatCounted: true, draftJobId: job.id, mode: p.mode });
      // A busy shot now (after the script was saved) throws as a plain failure: the retry finds the saved version and sets the mode.
      try {
        await updateProject({ userId, id: projectId, patch: { mode: p.mode }, modeJob: true });
      } catch (err) {
        throw new Error(`mode not set after the rewrite: ${err?.message}`);
      }
      return { script_version: out.script.version, mode: p.mode };
    }
    case 'cast': {
      const out = await draftCastCharacters({ userId, projectId });
      return { characters: out.characters, script_id: out.scriptId, script_version: out.scriptVersion };
    }
    case 'shots': {
      const asked = askedTracker(job);
      try {
        const out = await buildShotList({ userId, projectId, confirm: p.rebuildToken ?? null, allowance: p.buildReceipt || undefined, asked });
        return { shots: out.shots.length, ...(out.length_note ? { length_note: out.length_note } : {}), ...(asked.model ? { model_asked: true } : {}) };
      } catch (err) {
        if (err instanceof StoryError || err instanceof ModerationError) return { error: refusal(err), ...(asked.model ? { model_asked: true } : {}) };
        throw err;
      } finally {
        await asked.pending;
      }
    }
    default:
      throw new StoryError('Unknown drafting task.', { status: 422, code: 'validation_failed' });
  }
}

/**
 * Gives the job's count back at most once, however often onDone or onFail runs: the script count (receipt), or
 * the storyboard build count (buildReceipt) when no attempt asked the model. The row is read again, so a retry's
 * model_asked mark is seen.
 */
async function giveBackOnce(job, result = null) {
  const [row] = await storyDb().select('story_jobs', { id: job.id }, { columns: ['id', 'payload'] });
  const payload = row?.payload || job.payload || {};
  // A rewrite that saved the script and set the mode before it was killed is a success: the count stays, the card stays used.
  if (payload.task === 'mode' && !result?.unchanged && (await modeChangeLanded(job, payload))) {
    await chatLine(job, MODE_DONE[payload.mode]);
    return;
  }
  const receipt = payload.receipt || (payload.buildReceipt && !payload.model_asked && !result?.model_asked ? payload.buildReceipt : null);
  if (!receipt) return;
  const [claimed] = await storyDb().update('story_jobs', { id: job.id, allowance_returned_at: null }, { allowance_returned_at: new Date().toISOString() });
  if (!claimed) return;
  try {
    await releaseAllowance(receipt);
    // The chat card that queued it works again (a failed try is not a used one), and the customer is told.
    if (payload.task === 'mode') {
      // Said as it is: nothing changed; or the script was rewritten but the switch did not finish (pressing again finishes it, free).
      const line = result?.unchanged ? MODE_DONE[payload.mode] : (await savedByThisJob(job)) ? MODE_PARTIAL : MODE_FAILED;
      await chatLine(job, line);
    }
    if (payload.chatId && payload.confirmId) {
      await storyDb().rpc('story_chat_confirm_give_back', { p_project: job.project_id, p_chat: payload.chatId, p_confirm: payload.confirmId }).catch(() => {});
    }
  } catch (err) {
    // Not given back: open the claim again so the hook's retry can.
    await storyDb().update('story_jobs', { id: job.id }, { allowance_returned_at: null }).catch(() => {});
    throw err;
  }
}

const MODE_DONE = { narrated: 'Done. A narrator now tells the story.', talking: 'Done. The characters now speak their lines.' };
const MODE_FAILED = 'That did not work, so nothing changed. Try again.';
const MODE_PARTIAL = 'Your script was rewritten, but the switch did not finish. Press the button again to finish it.';

/** Did this job's rewrite land: its script version is saved and the project already has the mode? */
async function modeChangeLanded(job, payload) {
  const [project] = await storyDb().select('story_projects', { id: job.project_id }, { columns: ['mode'], limit: 1 });
  return project?.mode === payload.mode && Boolean(await savedByThisJob(job));
}

/** One plain line in the project's chat when a mode job ends (once, however often the hooks run). */
async function chatLine(job, text) {
  const rows = await storyDb().select('story_chat', { project_id: job.project_id, role: 'assistant' }, { order: '-created_at', limit: 20 });
  if (rows.some((r) => Array.isArray(r.content) && r.content.some((c) => c?.jobId === job.id))) return;
  await storyDb().insert('story_chat', { project_id: job.project_id, role: 'assistant', content: [{ type: 'text', text, jobId: job.id }] })
    .catch((err) => console.error('[story] could not post the mode line', job.id, err?.message));
}

export const draftHandler = {
  sync: true,

  run: async (job) => {
    try {
      return await draft(job);
    } catch (err) {
      if (err instanceof StoryError || err instanceof ModerationError) return { error: refusal(err) };
      throw err;
    }
  },

  // Database only (runner contract).
  onDone: async (job, result) => {
    if (result?.error || result?.unchanged) await giveBackOnce(job, result);
    else if (job.payload?.task === 'mode') await chatLine(job, MODE_DONE[job.payload.mode]);
  },

  onFail: async (job) => {
    await giveBackOnce(job);
  },
};

registerHandler('script', draftHandler);
