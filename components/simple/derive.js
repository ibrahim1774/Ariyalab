// The simple maker's decisions, as pure functions of the /status payload. No React, no network.
// Which screen shows, what the "design my video" pipeline does next, how scenes are grouped and whether the final render
// should start by itself. Everything is read from server state, so a reload or a second tab ends up in the same place.

import { startable } from '../maker/StepGenerate';
import { estimateCredits, isGenerated } from '../maker/steps';
import { renderActive } from '../maker/finish';

export const SCREENS = Object.freeze([
  { id: 'describe', label: 'Describe it' },
  { id: 'script', label: 'Check the script' },
  { id: 'plan', label: 'Check the plan' },
  { id: 'watch', label: 'Watch and fix' },
]);
export const screenIndex = (id) => SCREENS.findIndex((s) => s.id === id);

// The server's project steps, in order (lib/story/projects.js STEPS; no import, that file is server code).
const ORDER = ['brief', 'breakdown', 'script', 'cast', 'storyboard', 'audio', 'generate', 'review', 'done'];
const stepAt = (project) => ORDER.indexOf(project?.step || 'brief');

export const hasScript = (project) => Boolean(project) && stepAt(project) >= ORDER.indexOf('script');

const IN_FLIGHT = ['queued', 'generating'];

/** True once any clip was started: the project reached the generate step, a clip job exists, or a shot has a clip state. */
export function clipsStarted({ project, shots = [], jobs = [] } = {}) {
  if (!project) return false;
  if (stepAt(project) >= ORDER.indexOf('generate')) return true;
  if (jobs.some((j) => j.kind === 'clip')) return true;
  // A shot's own "failed" also covers a failed picture, so only the clip states count here.
  return shots.some((s) => s.status === 'queued' || s.status === 'generating' || s.status === 'ready');
}

/**
 * The screen the server state calls for.
 *   no script -> describe; script, no cast and no storyboard -> script; a plan in progress or ready, no clips -> plan;
 *   any clip started -> watch.
 */
export function deriveScreen(status) {
  const { project, shots = [], cast = [] } = status || {};
  if (!project || !hasScript(project)) return 'describe';
  if (clipsStarted(status)) return 'watch';
  if (cast.length > 0 || shots.length > 0) return 'plan';
  return 'script';
}

// ---- the idea box

const PURPOSE_WORDS = [
  ['app', /\b(app|software|saas|download)\b/i],
  ['coaching', /\b(coach|coaching|course|mentor)\b/i],
  ['service', /\b(service|clinic|salon|agency|barbershop|plumber|cleaning|consult)/i],
  ['product', /\b(product|sell|selling|launch|store|shop|brand|bottle|cream|shoes?)\b/i],
];
/** The purpose an idea most likely has. Not asked in the simple flow; a story is the safe default (it needs no offer). */
export function guessPurpose(text) {
  const t = String(text || '');
  for (const [purpose, pattern] of PURPOSE_WORDS) if (pattern.test(t)) return purpose;
  return 'story';
}

export const DEFAULT_STYLE = '3d_family';
export const DEFAULT_QUALITY = 'standard';
export const DEFAULT_SECONDS = 30;

/** "7 s", "30 s", "2 min". */
export const lengthLabel = (n) => (n === 120 ? '2 min' : `${n} s`);

/** What a video of this length and quality costs at the current prices (the number the quote bar would show). */
export const lengthCredits = (pricing, project, seconds, quality) => estimateCredits({ ...(project || {}), seconds, quality }, pricing);

// ---- the plan pipeline

const picked = (c) => c.chosen_index != null || Boolean(c.image_url);
const lacksPicture = (s) => isGenerated(s) && !s.still_url;

/**
 * What "Looks good, design my video" does next, from fresh status. One of:
 *   { type: 'cast', expected }        start the cast (the fee the customer confirmed)
 *   { type: 'build' }                 build the shot list (nothing to pay)
 *   { type: 'stills', ids, expected } first pictures for these shots
 *   { type: 'narration' | 'music', expected }
 *   { type: 'ask', what, credits, ids? }  a part now costs credits nobody confirmed: show its price, ask again
 *   { type: 'stale' }                 the script changed since the shots were made: rebuild first
 *   { type: 'wait', what: [..] }      something is being made
 *   { type: 'blocked', what: [..] }   something failed or was refused; the customer fixes it on the plan screen
 *   { type: 'done' }                  every part exists
 *   { type: 'none' }                  nothing to do yet (no script)
 * confirmed: credits the customer confirmed in this tab, { fee, pictures, voice, music }. A part that costs 0 never needs
 * confirming; a part that costs more only starts when its price equals what was confirmed (never a number nobody saw).
 * Audio does not depend on the cast, so it can start while pictures are being drawn.
 */
export function nextPlanAction(status, { confirmed = {} } = {}) {
  const { project, shots = [], cast = [], audio = null } = status || {};
  if (!project || !hasScript(project)) return { type: 'none' };
  const actions = [];
  const asks = [];
  const waits = [];
  const blocked = [];
  const gen = shots.filter(isGenerated);

  // 1. cast
  let castClear = true;
  if (project.consistent_cast !== false) {
    if (cast.length === 0) {
      castClear = false;
      if (confirmed.fee !== undefined) actions.push({ type: 'cast', expected: confirmed.fee });
    } else if (cast.some((c) => c.status === 'failed' || c.status === 'blocked')) {
      castClear = false;
      blocked.push('characters');
    } else if (cast.some((c) => c.status === 'pending' || c.status === 'draft')) {
      castClear = false;
      waits.push('characters');
    } else if (cast.some((c) => !picked(c))) {
      castClear = false;
      waits.push('looks');
    }
  }

  // 2. shots and their first pictures
  if (castClear) {
    if (shots.length === 0) {
      actions.push({ type: 'build' });
    } else if (shots.some((s) => s.needs_rebuild)) {
      asks.push({ type: 'stale' });
    } else {
      if (gen.some((s) => s.status === 'still_pending')) waits.push('pictures');
      if (gen.some((s) => lacksPicture(s) && (s.status === 'failed' || s.status === 'blocked'))) blocked.push('pictures');
      const need = gen.filter((s) => lacksPicture(s) && s.status === 'draft');
      if (need.length) {
        const credits = need.reduce((n, s) => n + (Number(s.still_credits) || 0), 0);
        const ids = need.map((s) => s.id);
        if (credits === 0 || credits === confirmed.pictures) actions.push({ type: 'stills', ids, expected: credits });
        else asks.push({ type: 'ask', what: 'pictures', credits, ids });
      }
    }
  }

  // 3. voice and music (the server's own prices, from the audio view)
  if (audio) {
    const n = audio.narration;
    if (audio.applicable?.narration && audio.applicable.narrationLines > 0 && n) {
      if (n.status === 'pending') waits.push('voice');
      else if (n.status === 'failed' || n.status === 'blocked') blocked.push('voice');
      else if (n.status === 'none') {
        const credits = Number(n.credits) || 0;
        if (credits === 0 || credits === confirmed.voice) actions.push({ type: 'narration', expected: credits });
        else asks.push({ type: 'ask', what: 'voice', credits });
      }
    }
    const m = audio.music;
    if (m && m.type === 'generated') {
      if (m.status === 'pending') waits.push('music');
      else if (m.status === 'failed' || m.status === 'blocked') blocked.push('music');
      else if (m.status === 'none') {
        const credits = Number(m.credits) || 0;
        if (credits === 0 || credits === confirmed.music) actions.push({ type: 'music', expected: credits });
        else asks.push({ type: 'ask', what: 'music', credits });
      }
    }
  }

  if (actions.length) return actions[0];
  if (asks.length) return asks[0];
  if (waits.length) return { type: 'wait', what: waits };
  if (blocked.length) return { type: 'blocked', what: blocked };
  return { type: 'done' };
}

/** A stable name for an action, so the same start is never sent twice from one screen. */
export const actionKey = (a) => (!a ? '' : a.type === 'stills' ? `stills:${a.ids.join(',')}` : ['cast', 'build', 'narration', 'music'].includes(a.type) ? a.type : '');

/** The amounts a quote lists, by part, as the customer confirms them when pressing the button. */
export function confirmedFrom(quote) {
  const line = (key) => quote?.lines?.find((l) => l.key === key)?.credits;
  return { fee: quote?.castFee ?? 0, pictures: quote?.stills ?? 0, voice: line('voice'), music: line('music') };
}

// ---- scenes (screens 3 and 4)

/** The shots grouped by scene, in order: [{ id, n, shots, state, startIds, readyShots }]. state: waiting, making, ready, failed. */
export function scenesOf(shots = []) {
  const order = [];
  const byScene = new Map();
  for (const s of [...shots].sort((a, b) => a.ord - b.ord)) {
    const key = s.scene_id || `shot-${s.id}`;
    if (!byScene.has(key)) {
      byScene.set(key, []);
      order.push(key);
    }
    byScene.get(key).push(s);
  }
  return order.map((id, i) => {
    const list = byScene.get(id);
    const gen = list.filter(isGenerated);
    let state = 'waiting';
    if (gen.length && gen.every((s) => s.status === 'ready')) state = 'ready';
    else if (gen.some((s) => IN_FLIGHT.includes(s.status))) state = 'making';
    else if (gen.some((s) => (s.status === 'failed' || s.status === 'blocked') && s.still_url)) state = 'failed';
    return {
      id,
      n: i + 1,
      shots: list,
      state,
      startIds: startable(list).map((s) => s.id),
      readyShots: list.filter((s) => s.status === 'ready' && s.clip_url),
    };
  });
}

/** Shot ids that can be started now across the whole video. */
export const startableIds = (shots) => startable(shots).map((s) => s.id);

/** The scenes still waiting to be made: the next one, and whether more follow. */
export function nextScenes(scenes) {
  const waiting = scenes.filter((s) => s.state === 'waiting' && s.startIds.length > 0);
  return { next: waiting[0] || null, waitingCount: waiting.length };
}

// ---- the final render

const finished = (jobs, kind) => jobs
  .filter((j) => j.kind === kind && j.status === 'done')
  .reduce((latest, j) => Math.max(latest, Date.parse(j.updated_at) || 0), 0);

/**
 * True when the final render should start by itself, once: every clip is ready, the voice and music are not still being made,
 * no render is running, none already covers the current clips, and the render is the included one (price 0).
 * A later render has a price and needs a click.
 */
export function shouldAutoRender(status) {
  const { project, shots = [], jobs = [], render = null, renderPrice = null, audio = null } = status || {};
  if (!project || project.status === 'expired') return false;
  const gen = shots.filter(isGenerated);
  if (!gen.length || gen.some((s) => s.status !== 'ready')) return false;
  if (audio?.narration?.status === 'pending' || audio?.music?.status === 'pending') return false;
  if (renderActive(render)) return false;
  if (renderPrice?.credits !== 0) return false;
  if (render) {
    const made = Date.parse(render.created_at) || 0;
    if (made >= finished(jobs, 'clip')) return false;
  }
  return true;
}

/** The newest finished clip job's time (ms), 0 when there is none. */
export const lastClipAt = (jobs = []) => finished(jobs, 'clip');

/** True when a render exists but a clip was made after it, so it no longer matches the clips. */
export function renderOutdated({ render = null, jobs = [] } = {}) {
  if (!render) return false;
  return (Date.parse(render.created_at) || 0) < lastClipAt(jobs);
}
