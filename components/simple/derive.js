// The simple maker's decisions, as pure functions of the /status payload. No React, no network.
// Which screen shows, what the "design my video" pipeline does next, how scenes are grouped and whether the final render
// should start by itself. Everything is read from server state, so a reload or a second tab ends up in the same place.

import { startable } from '../maker/StepGenerate';
import { estimateCredits, isGenerated, scriptJobActive } from '../maker/steps';
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

/** A character the new art style cleared (style_stale, no pictures, no pick): it is drawn again with a regeneration. */
export const needsRedraw = (c) => c.style_stale === true && c.status === 'ready' && c.chosen_index == null && !c.image_url && !(c.candidates || []).length;

/** True once any clip was started: the project reached the generate step, a clip job exists, or a shot has a clip state. */
export function clipsStarted({ project, shots = [], jobs = [] } = {}) {
  if (!project) return false;
  if (stepAt(project) >= ORDER.indexOf('generate')) return true;
  if (jobs.some((j) => j.kind === 'clip')) return true;
  // A shot's own "failed" also covers a failed picture, so only the clip states count here.
  return shots.some((s) => s.status === 'queued' || s.status === 'generating' || s.status === 'ready');
}

/**
 * What is missing from the plan (cast, looks, storyboard, pictures), read from server state. A plan that was complete can become
 * incomplete again after clips exist: the script changed (needs_rebuild), a flag switch cleared the pictures, or the project now
 * wants the same characters and has no cast.
 *   cast      same characters wanted, no cast rows, and the plan had begun (shots or clips exist)
 *   redraw    a new art style cleared a character's pictures: they are drawn again
 *   pick      a character failed, was blocked, or has no look picked
 *   rebuild   a shot needs the storyboard rebuilt
 *   pictures  a generated shot has no picture (and none is a clip in flight)
 */
export function planGaps(status) {
  const { project, shots = [], cast = [] } = status || {};
  const none = { cast: false, redraw: false, pick: false, rebuild: false, pictures: false };
  if (!project || !hasScript(project)) return none;
  const gen = shots.filter((s) => (s.source || 'generated') !== 'footage');
  const begun = shots.length > 0 || clipsStarted(status);
  return {
    cast: project.consistent_cast !== false && cast.length === 0 && begun,
    // Leftover characters mean nothing on a different-people video: the cast is not used there.
    redraw: project.consistent_cast !== false && cast.some(needsRedraw),
    pick: project.consistent_cast !== false && cast.some((c) => c.status === 'failed' || c.status === 'blocked' || (c.status === 'ready' && c.chosen_index == null && !c.image_url && !needsRedraw(c))),
    rebuild: shots.some((s) => s.needs_rebuild),
    pictures: gen.some((s) => !s.still_url && !IN_FLIGHT.includes(s.status)),
  };
}

/** The one line that says why the plan screen is back, in plain words; null when the plan is complete. */
export function planReason(status) {
  const g = planGaps(status);
  if (g.cast) return 'This video now uses the same characters throughout, so they need making first.';
  if (g.redraw) return 'The art style changed, so the characters need drawing again.';
  if (g.rebuild) return 'The storyboard needs updating to match your changes.';
  if (g.pictures) return 'Some pictures are missing and need making.';
  if (g.pick) return 'A character needs a look before the video can go on.';
  return null;
}

/**
 * The screen the server state calls for.
 *   no script -> describe; script, no cast and no storyboard -> script; a plan in progress or ready, no clips -> plan;
 *   any clip started -> watch, unless the plan is incomplete again (planGaps), which brings the plan screen back.
 */
export function deriveScreen(status) {
  const { project, shots = [], cast = [] } = status || {};
  if (!project || !hasScript(project)) return 'describe';
  if (clipsStarted(status)) return planReason(status) ? 'plan' : 'watch';
  if (cast.length > 0 || shots.length > 0) return 'plan';
  return 'script';
}

/** The furthest screen the customer may open: finished scenes stay watchable while the plan is being finished. */
export function furthestScreen(status) {
  const { project } = status || {};
  if (project && hasScript(project) && clipsStarted(status)) return 'watch';
  return deriveScreen(status);
}

// ---- the idea box

export const DEFAULT_STYLE = '3d_family';
export const DEFAULT_QUALITY = 'standard';
export const DEFAULT_SECONDS = 30;

/** "7 s", "30 s", "2 min". */
export const lengthLabel = (n) => (n === 120 ? '2 min' : `${n} s`);

/** What a video of this length and quality costs at the current prices (the number the quote bar would show). */
export const lengthCredits = (pricing, project, seconds, quality) => estimateCredits({ ...(project || {}), seconds, quality }, pricing);

// ---- the plan pipeline

// A character left as a draft, or pending with no picture job running, this long is restarted (cast.js generateCast does it, charging nothing).
const STUCK_DRAFT_MS = 2 * 60_000;
const STUCK_PENDING_MS = 5 * 60_000;

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
 *   { type: 'redraw', items: [{ castId, name, expected }], expected }  draw cleared characters again (a regeneration each)
 *   { type: 'pick', castId }          a character is ready with no look picked: its first option
 *   { type: 'resume_cast' }           a character whose start died: start again (nothing to pay)
 *   { type: 'wait', what: [..] }      something is being made
 *   { type: 'blocked', what: [..] }   something failed or was refused; the customer fixes it on the plan screen
 *   { type: 'done' }                  every part exists
 *   { type: 'none' }                  nothing to do yet (no script)
 * confirmed: credits the customer confirmed in this tab, { fee, pictures, voice, music }. A part that costs 0 never needs
 * confirming; a part that costs more only starts when its price equals what was confirmed (never a number nobody saw).
 * Audio does not depend on the cast, so it can start while pictures are being drawn.
 */
export function nextPlanAction(status, { confirmed = {}, now = Date.now(), quote = null } = {}) {
  const { project, shots = [], cast = [], audio = null, jobs = [] } = status || {};
  if (!project || !hasScript(project)) return { type: 'none' };
  // A script rewrite is running: nothing starts until it is done (the server refuses starts meanwhile).
  if (scriptJobActive(jobs)) return { type: 'wait', what: ['script'] };
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
      // The plan already began (shots or clips) and the cast is missing: the price comes from the server and needs a press.
      else if (shots.length > 0 || clipsStarted(status)) asks.push({ type: 'ask', what: 'cast', credits: Number.isInteger(quote?.castFee) ? quote.castFee : null });
    } else {
      const running = (c) => jobs.some((j) => j.kind === 'cast_image' && (j.status === 'queued' || j.status === 'running') && j.payload?.castId === c.id);
      const old = (c, ms) => now - (Date.parse(c.updated_at) || now) > ms;
      if (cast.some((c) => c.status === 'failed' || c.status === 'blocked')) {
        castClear = false;
        blocked.push('characters');
      }
      // A character whose start died (still a draft with nothing running) is started again: with cast rows there is no fee, so it is 0.
      const stuck = cast.filter((c) => (c.status === 'draft' && !running(c) && old(c, STUCK_DRAFT_MS)) || (c.status === 'pending' && !running(c) && old(c, STUCK_PENDING_MS)));
      if (castClear && stuck.length) {
        castClear = false;
        actions.push({ type: 'resume_cast', expected: 0 });
      } else if (castClear && cast.some((c) => c.status === 'pending' || c.status === 'draft')) {
        castClear = false;
        waits.push('characters');
      } else if (castClear && cast.some(needsRedraw)) {
        castClear = false;
        const items = cast.filter(needsRedraw).map((c) => ({ castId: c.id, name: c.name, expected: Number(c.regen_credits) || 0 }));
        const credits = items.reduce((n, i) => n + i.expected, 0);
        if (credits === 0 || credits === confirmed.redraw) actions.push({ type: 'redraw', items, expected: credits });
        else asks.push({ type: 'ask', what: 'redraw', credits });
      } else if (castClear) {
        const open = cast.filter((c) => !picked(c));
        if (open.length) {
          castClear = false;
          const withOptions = open.find((c) => (c.candidates || []).length > 0);
          if (withOptions) actions.push({ type: 'pick', castId: withOptions.id, name: withOptions.name });
          else blocked.push('characters');
        }
      }
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
      const missing = gen.filter((s) => lacksPicture(s) && (s.status === 'draft' || s.status === 'ready'));
      // Same characters: a picture does not start while a character in the shot still has its sheet drawn (the server refuses it,
      // lib/story/storyboard.js generateStills). Those shots wait; the rest start now. A failed sheet is not waited for.
      const sheetMaking = (s) => project.consistent_cast !== false && (s.cast_ids || []).some((id) => cast.find((c) => c.id === id)?.sheet_state === 'making');
      const need = missing.filter((s) => !sheetMaking(s));
      if (missing.some(sheetMaking)) waits.push('sheets');
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
export const actionKey = (a) => (!a ? '' : a.type === 'stills' ? `stills:${a.ids.join(',')}` : a.type === 'pick' ? `pick:${a.castId}` : a.type === 'redraw' ? `redraw:${a.items.map((i) => i.castId).join(',')}` : ['cast', 'build', 'narration', 'music', 'resume_cast'].includes(a.type) ? a.type : '');

/** Parts the pipeline starts without a price: they need the customer's press (the marker) before they run by themselves. */
export const FREE_STARTS = ['build', 'stills', 'narration', 'music', 'pick', 'resume_cast', 'redraw'];

/** The amounts a quote lists, by part, as the customer confirms them when pressing the button. */
export function confirmedFrom(quote) {
  const line = (key) => quote?.lines?.find((l) => l.key === key)?.credits;
  return { fee: quote?.castFee ?? 0, pictures: quote?.stills ?? 0, voice: line('voice'), music: line('music'), redraw: quote?.redraw };
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
    const startIds = startable(list).map((s) => s.id);
    let state = 'waiting';
    if (gen.length && gen.every((s) => s.status === 'ready')) state = startIds.length > 0 || gen.some((s) => s.needs_rebuild) ? 'outdated' : 'ready';
    else if (gen.some((s) => IN_FLIGHT.includes(s.status))) state = 'making';
    else if (gen.some((s) => (s.status === 'failed' || s.status === 'blocked') && s.still_url)) state = 'failed';
    const broken = gen.find((s) => (s.status === 'failed' || s.status === 'blocked') && s.still_url);
    return {
      id,
      n: i + 1,
      shots: list,
      state,
      blocked: broken?.status === 'blocked',
      error: broken?.error || null,
      startIds,
      // Out of date: the clip exists but the script or the picture changed after it was made.
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
 * What is missing or failed in the voice and music, for the video to be put together: [{ kind: 'voice' | 'music', status, credits }].
 * credits is the server's price of the button that fixes it (the retry price after a failure, else a normal make); 0 = included.
 */
export function audioIssues(audio) {
  if (!audio) return [];
  const out = [];
  const bad = (st) => st === 'none' || st === 'failed' || st === 'blocked';
  const n = audio.narration;
  if (audio.applicable?.narration && audio.applicable.narrationLines > 0 && n && bad(n.status)) {
    out.push({ kind: 'voice', status: n.status, credits: Number.isInteger(n.retry_credits) && n.status === 'failed' ? n.retry_credits : Number(n.credits) || 0, retry: n.status === 'failed' });
  }
  const m = audio.music;
  if (m && m.type === 'generated' && bad(m.status)) {
    out.push({ kind: 'music', status: m.status, credits: Number.isInteger(m.retry_credits) && m.status === 'failed' ? m.retry_credits : Number(m.credits) || 0, retry: m.status === 'failed' });
  }
  return out;
}

/** True when a shot's clip is out of date or its storyboard needs a rebuild. */
export const clipsOutOfDate = (shots = []) => shots.some((s) => s.needs_rebuild || (s.status === 'ready' && s.stale));

/**
 * True when the final render should start by itself, once: every clip is ready and up to date, the voice and music exist (or are
 * being made, which waits), no render is running, NO finished render exists yet, and the render is the included one (price 0).
 * Anything later has a price (or follows a change) and needs a click.
 */
export function shouldAutoRender(status) {
  const { project, shots = [], jobs = [], render = null, renders = [], renderPrice = null, audio = null } = status || {};
  if (!project || project.status === 'expired') return false;
  if (scriptJobActive(jobs)) return false;
  const gen = shots.filter(isGenerated);
  if (!gen.length || gen.some((s) => s.status !== 'ready')) return false;
  if (clipsOutOfDate(shots)) return false;
  if (audio?.narration?.status === 'pending' || audio?.music?.status === 'pending') return false;
  if (audioIssues(audio).length) return false;
  if (renderActive(render)) return false;
  if (renderPrice?.credits !== 0) return false;
  if (render?.status === 'done' || (renders || []).some((r) => r.status === 'done')) return false;
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
