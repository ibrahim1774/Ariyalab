import { storyDb } from './db.js';
import { ConflictError } from './errors.js';

/*
 * Drafting jobs (job kind 'script', lib/story/draftJobs.js) that are waiting or running for a project, and what they
 * keep the rest of the project from doing meanwhile. Kept apart from script.js so every service can ask without a cycle.
 */

export const REWRITING_MESSAGE = 'Your script is being rewritten. This will carry on when it is done.';
const BUSY_MESSAGES = {
  write: 'Your script is being written. This will carry on when it is done.',
  revise: REWRITING_MESSAGE,
  mode: REWRITING_MESSAGE,
  cast: 'Your characters are being drafted. This will carry on when it is done.',
  shots: 'Your scenes are being planned. This will carry on when it is done.',
};

const activeScriptJobs = (projectId) =>
  storyDb().select('story_jobs', { project_id: projectId, kind: 'script', status: ['queued', 'running'] }, { columns: ['id', 'payload'], limit: 20 });

/** 409 drafting_busy while any drafting job of this project is waiting or running; the message says which. */
export async function assertNotDrafting(projectId) {
  const [active] = await activeScriptJobs(projectId);
  if (active) throw new ConflictError(BUSY_MESSAGES[active.payload?.task] || REWRITING_MESSAGE, { code: 'drafting_busy' });
}

/**
 * 409 drafting_busy while a set_mode rewrite is waiting or running: stills, clips, plan builds, cast work and renders do not
 * start meanwhile (the rewrite checked that nothing was being made, and sets the mode when it ends).
 */
export async function assertNoModeRewrite(projectId) {
  const active = await activeScriptJobs(projectId);
  if (active.some((j) => j.payload?.task === 'mode')) throw new ConflictError(REWRITING_MESSAGE, { code: 'drafting_busy' });
}
