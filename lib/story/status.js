import { getBalance } from '../credits.js';
import { isMock } from '../providers/mock.js';
import { storyDb } from './db.js';
import { getProject } from './projects.js';
import { tick } from './runner.js';
import { afterResponse } from './afterResponse.js';
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
// The status request itself stays short: its tick (claims, paid submits, polls) has this long. Real mode: 5 s. Local mock mode
// has no cron and no copy to wait for, so it has time to do everything in the request.
export const STATUS_TICK_MS = { real: 5_000, mock: 30_000 };
// A finished picture is copied into storage after the answer is sent (backgroundCopy): the copy takes about 8 s (a clip about
// 25 s; runner.js mirrorMinMs 8 s / 25 s plus mirrorDeadlineMarginMs 2 s must fit). The route's maxDuration is 60 s
// (pages/api/story/projects/[id]/status.js), so 40 s leaves 20 s. The minute cron stays the backstop.
export const STATUS_COPY_MS = 40_000;

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

// One background copy per project in this process, so polls and tabs do not stack. The per-job lease (runner takeLease) keeps
// the cron and other processes from copying the same file or settling it twice.
const copying = new Map();

/** The running background copy of a project (a promise), or null. Tests wait on it. */
export const backgroundCopy = async (projectId) => (copying.has(projectId) ? copying.get(projectId) : null);

/** True when a finished provider answer of this project still waits for its copy. */
async function hasKeptFile(projectId) {
  const running = await storyDb().select('story_jobs', { project_id: projectId, status: 'running' }, { columns: ['id', 'provider_result'] });
  return running.some((j) => j.provider_result);
}

/**
 * After the answer: copies the project's finished files (and polls what is due) for up to STATUS_COPY_MS. No claims, so nothing
 * paid is started here. Starts at most one per project; never throws.
 */
function startBackgroundCopy(projectId) {
  if (copying.has(projectId)) return;
  const work = (async () => {
    try {
      await tick({ projectId, limit: 0, runSync: false, deadline: Date.now() + STATUS_COPY_MS });
    } catch (err) {
      console.error('[story] status: background copy failed', err?.message || err);
    } finally {
      copying.delete(projectId);
    }
  })();
  copying.set(projectId, work);
  afterResponse(work);
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
  // A finished file the short tick could not copy is copied now, without holding this answer (mock mode copies inside the tick).
  if (!isMock() && !copying.has(projectId) && (await quietly('kept files', () => hasKeptFile(projectId)))) startBackgroundCopy(projectId);
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
