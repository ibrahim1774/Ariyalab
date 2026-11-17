import { getBalance } from '../credits.js';
import { isMock } from '../providers/mock.js';
import { storyDb } from './db.js';
import { getProject } from './projects.js';
import { tick } from './runner.js';
import { recoverStalledStills } from './storyboard.js';
import { castView } from './cast.js';
import { getAudio } from './audio.js';
import { clipView, recoverStalledClips, rerollAllowance } from './shots.js';
import { publicRender, recoverStalledRender, renderPrice } from './render.js';

/*
 * GET /api/story/projects/[id]/status: everything the maker screen polls, in
 * one answer. It also moves the project on: it puts back starts left by dead
 * requests and runs one runner tick for this project (async kinds only, so a
 * slow sync job never runs inside a request).
 *
 *   { project, shots, cast, jobs, balance, render, audio, rerolls }
 *
 *   project  the story_projects row without internal columns (claims, stored plans)
 *   shots    clipView: the storyboard view (retry_credits, still_credits, needs_rebuild)
 *            plus clip_credits, clip_price, reroll_credits; status 'generating' while a clip runs
 *   cast     castView (retry_credits, regen_credits)
 *   jobs     the newest JOBS_LIMIT jobs, story_jobs_public columns plus
 *            payload: { castId } / { shotId } only (never prompts, holds or costs)
 *   balance  getBalance(userId)            { plan, topup, held, available }
 *   render   the latest render (lib/story/render.js publicRender: id, version, status, url, warnings,
 *            created_at, finished_at, error), or null
 *   audio    the audio view (lib/story/audio.js getAudio), or null if it could not be read
 *   rerolls  { included, used, left }      free Make it again tries
 *   renders  the newest RENDERS_LIMIT story_renders rows, newest first (render = renders[0]); Task 20
 */

export const JOBS_LIMIT = 200;
export const RENDERS_LIMIT = 10;
// One status tick per project at most this often (several open tabs, fast polling).
export const STATUS_TICK_EVERY_MS = 3_000;
// A real request ticks briefly (the cron does the copying); local mock mode has no cron, so the request has time to copy.
export const STATUS_TICK_MS = { real: 5_000, mock: 30_000 };

const PROJECT_INTERNAL = [
  'pending_shots', 'pending_basis', 'pending_at', 'gen_claim_id', 'gen_hold_id', 'gen_claimed_at', 'gen_shots', 'gen_rerolls',
  'runner_ticked_at', 'audio_claims', 'status_ticked_at',
];
const JOB_PUBLIC = ['id', 'project_id', 'shot_id', 'kind', 'status', 'error', 'created_at', 'updated_at'];

function publicProject(row) {
  const out = { ...row };
  for (const k of PROJECT_INTERNAL) delete out[k];
  return out;
}

function publicJob(job) {
  const out = {};
  for (const k of JOB_PUBLIC) out[k] = job[k] ?? null;
  const payload = {};
  if (typeof job.payload?.castId === 'string') payload.castId = job.payload.castId;
  if (typeof job.payload?.shotId === 'string') payload.shotId = job.payload.shotId;
  // What a drafting job is doing (a script rewrite for set_mode shows the screen the script is being rewritten).
  if (job.kind === 'script' && typeof job.payload?.task === 'string') payload.task = job.payload.task;
  if (job.kind === 'script' && typeof job.payload?.mode === 'string') payload.mode = job.payload.mode;
  if (job.kind === 'script' && job.status === 'done' && job.result?.error?.message) out.error = job.result.error.message;
  out.payload = payload;
  return out;
}

const quietly = async (what, fn) => {
  try {
    return await fn();
  } catch (err) {
    console.error(`[story] status: ${what} failed`, err?.message || err);
    return null;
  }
};

/** Takes this project's status-tick turn (compare and set on status_ticked_at). -> true when this call may tick. */
async function takeTickTurn(row) {
  const last = row.status_ticked_at ? Date.parse(row.status_ticked_at) : NaN;
  if (Number.isFinite(last) && Date.now() - last < STATUS_TICK_EVERY_MS && Date.now() >= last) return false;
  const won = await storyDb().update('story_projects', { id: row.id, status_ticked_at: row.status_ticked_at ?? null }, { status_ticked_at: new Date().toISOString() });
  return won.length > 0;
}

export async function getProjectStatus({ userId, projectId }) {
  const before = await getProject({ userId, id: projectId });
  await quietly('still recovery', () => recoverStalledStills(projectId));
  await quietly('clip recovery', () => recoverStalledClips(projectId));
  await quietly('render recovery', () => recoverStalledRender(projectId));
  if (await quietly('tick turn', () => takeTickTurn(before))) {
    await quietly('tick', () => tick({
      projectId, limit: 15, runSync: false, deadline: Date.now() + (isMock() ? STATUS_TICK_MS.mock : STATUS_TICK_MS.real),
    }));
  }

  const project = await getProject({ userId, id: projectId });
  const [shots, castRows, jobs, balance, renders, audio, nextRender] = await Promise.all([
    clipView(projectId, project),
    storyDb().select('story_cast', { project_id: projectId }, { order: 'ord' }),
    storyDb().select('story_jobs', { project_id: projectId }, { order: ['-created_at', '-id'], limit: JOBS_LIMIT }),
    getBalance(userId, 'video'),
    storyDb().select('story_renders', { project_id: projectId }, { order: '-version', limit: RENDERS_LIMIT }),
    quietly('audio view', () => getAudio({ userId, projectId })),
    quietly('render price', () => renderPrice(project)),
  ]);
  return {
    project: publicProject(project),
    shots,
    cast: await castView(castRows),
    jobs: jobs.reverse().map(publicJob),
    balance,
    render: publicRender(renders[0] || null),
    audio,
    rerolls: await rerollAllowance(project, shots),
    renders: renders.map(publicRender),
    // What the next render costs ({ credits }; 0 = the included one), for the Finish screen's button.
    renderPrice: nextRender ?? null,
  };
}
