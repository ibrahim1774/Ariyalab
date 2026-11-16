import { ModerationError } from '../moderation.js';
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
 *                  'shots'  buildShotList (payload.rebuildToken confirms a plan that removes clips);
 *                           it counts its own storyboard build exactly as on the website
 *
 * The handlers call the website's own services. No credit hold, spend or paid
 * work claim happens in a drafting job.
 *
 * A refusal the services raise (StoryError, ModerationError) is not retried: it
 * is the job's result { error: { code, message, count?, token? } }, read by
 * get_status and the tools. Any other failure goes through the runner (one
 * retry, then failed). The count the tool took (payload.receipt) is given back
 * when the job ends without a draft: onDone with an error result, or onFail
 * (a run that threw twice, or a killed run the sweep ended).
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

async function draft(job) {
  const p = job.payload || {};
  const userId = job.user_id;
  const projectId = job.project_id;
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
      const out = await buildShotList({ userId, projectId, confirm: p.rebuildToken ?? null });
      return { shots: out.shots.length, ...(out.length_note ? { length_note: out.length_note } : {}) };
    }
    default:
      throw new StoryError('Unknown drafting task.', { status: 422, code: 'validation_failed' });
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
    if (result?.error) await releaseAllowance(job.payload?.receipt);
  },

  onFail: async (job) => {
    await releaseAllowance(job.payload?.receipt);
  },
};

registerHandler('script', draftHandler);
