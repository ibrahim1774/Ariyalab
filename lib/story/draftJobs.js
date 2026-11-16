import { ModerationError } from '../moderation.js';
import { storyDb } from './db.js';
import { StoryError } from './errors.js';
import { releaseAllowance } from './limits.js';
import { registerHandler } from './runner.js';
import { reviseScript, writeScript } from './script.js';
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
 *                  'cast'   draftCastCharacters: the characters only; nothing saved or charged
 *                           (generate_cast's confirm step starts them, lib/mcp/tools.js)
 *                  'shots'  buildShotList (payload.rebuildToken confirms a plan that removes clips), with the
 *                           shots_build count the tool took (payload.buildReceipt): a retry never counts twice;
 *                           it is kept once the model was asked, as on the website, and never given back here
 *
 * write and revise carry payload.baseVersion, the script version when they were
 * queued. A run that finds a newer version (a run that died after saving, then
 * retried) finishes as done without writing again.
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

export const DRAFT_TASKS = Object.freeze(['write', 'revise', 'cast', 'shots']);

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

async function latestVersion(projectId) {
  const [row] = await storyDb().select('story_scripts', { project_id: projectId }, { columns: ['version'], order: '-version', limit: 1 });
  return row?.version ?? 0;
}

async function draft(job) {
  const p = job.payload || {};
  const userId = job.user_id;
  const projectId = job.project_id;
  if ((p.task === 'write' || p.task === 'revise') && Number.isInteger(p.baseVersion)) {
    const now = await latestVersion(projectId);
    if (now > p.baseVersion) return { script_version: now, already_saved: true };
  }
  switch (p.task) {
    case 'write': {
      const script = await writeScript({ userId, projectId, allowance: p.receipt || { userId, counters: [] } });
      return { script_version: script.version };
    }
    case 'revise': {
      const out = await reviseScript({ userId, projectId, instruction: p.instruction, chatCounted: true });
      return { script_version: out.script.version, changed_scene_ids: out.changedSceneIds };
    }
    case 'cast': {
      const out = await draftCastCharacters({ userId, projectId });
      return { characters: out.characters, script_id: out.scriptId, script_version: out.scriptVersion };
    }
    case 'shots': {
      const out = await buildShotList({ userId, projectId, confirm: p.rebuildToken ?? null, allowance: p.buildReceipt || undefined });
      return { shots: out.shots.length, ...(out.length_note ? { length_note: out.length_note } : {}) };
    }
    default:
      throw new StoryError('Unknown drafting task.', { status: 422, code: 'validation_failed' });
  }
}

/** Gives the job's count back at most once, however often onDone or onFail runs. */
async function giveBackOnce(job) {
  if (!job.payload?.receipt) return;
  const [claimed] = await storyDb().update('story_jobs', { id: job.id, allowance_returned_at: null }, { allowance_returned_at: new Date().toISOString() });
  if (!claimed) return;
  try {
    await releaseAllowance(job.payload.receipt);
  } catch (err) {
    // Not given back: open the claim again so the hook's retry can.
    await storyDb().update('story_jobs', { id: job.id }, { allowance_returned_at: null }).catch(() => {});
    throw err;
  }
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
    if (result?.error) await giveBackOnce(job);
  },

  onFail: async (job) => {
    await giveBackOnce(job);
  },
};

registerHandler('script', draftHandler);
