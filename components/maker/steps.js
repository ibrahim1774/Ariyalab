// The maker's step model. The UI has twelve steps; Project.step has nine values
// ('brief' covers Start, Purpose, Style and Length). Pure helpers, no React.

import { DEFAULTS } from '../../lib/pricingConstants';

export const UI_STEPS = [
  { id: 'start', label: 'Start', server: 'brief' },
  { id: 'purpose', label: 'Purpose', server: 'brief' },
  { id: 'style', label: 'Style', server: 'brief' },
  { id: 'length', label: 'Length', server: 'brief' },
  { id: 'breakdown', label: 'Breakdown', server: 'breakdown', optional: true },
  { id: 'script', label: 'Script', server: 'script' },
  { id: 'cast', label: 'Cast', server: 'cast' },
  { id: 'storyboard', label: 'Storyboard', server: 'storyboard' },
  { id: 'audio', label: 'Voice and sound', server: 'audio' },
  { id: 'generate', label: 'Generate', server: 'generate' },
  { id: 'review', label: 'Review', server: 'review' },
  { id: 'finish', label: 'Finish', server: 'done' },
];

/** The steps this project shows. The breakdown step only exists for a project started from a video. */
export function stepsFor(project) {
  return UI_STEPS.filter((s) => !s.optional || project?.reference_id);
}

/** Id of the furthest step the server says this project has reached. */
export function furthestId(project) {
  if (!project) return 'start';
  const step = project.step || 'brief';
  if (step === 'brief') {
    if (!project.purpose) return 'purpose';
    if (!project.style) return 'style';
    return 'length';
  }
  const hit = UI_STEPS.find((s) => s.server === step);
  if (!hit) return 'purpose';
  if (hit.id === 'breakdown' && !project.reference_id) return 'script';
  return hit.id;
}

export function nextId(project, id) {
  const list = stepsFor(project);
  const i = list.findIndex((s) => s.id === id);
  return list[Math.min(list.length - 1, i + 1)]?.id || id;
}

/**
 * Steps whose inputs changed after they were made. A server `project.stale_steps` array wins when present;
 * otherwise a shot marked stale (its scene was edited) makes the storyboard, and finished clips, need an update.
 */
export function staleIds(project, shots = []) {
  const out = new Set();
  if (Array.isArray(project?.stale_steps)) project.stale_steps.forEach((s) => out.add(s));
  if (shots.some((s) => s.stale)) {
    out.add('storyboard');
    if (shots.some((s) => s.stale && ['ready', 'queued', 'generating'].includes(s.status))) out.add('review');
  }
  return out;
}

// ---- shots

export const isGenerated = (shot) => (shot.source || 'generated') !== 'footage';

/** True when there are generated shots and every one has a still. */
export function allStillsReady(shots = []) {
  const gen = shots.filter(isGenerated);
  return gen.length > 0 && gen.every((s) => Boolean(s.still_url));
}

export function missingStills(shots = []) {
  return shots.filter(isGenerated).filter((s) => !s.still_url).length;
}

// ---- credits (every function takes the pricing from usePricing(); DEFAULTS only stand in while it loads)

const GEN_SHOT_SECONDS = 3;

export const shotCredits = (shot, pricing = DEFAULTS) =>
  pricing.perSecond[shot.quality] != null ? pricing.perSecond[shot.quality] * Math.max(3, Math.ceil(shot.seconds || 3)) : 0;

/** Estimate before a real quote exists: the project fee plus the per second rate over whole 3 second shots. */
export function estimateCredits(project, pricing = DEFAULTS) {
  if (!project) return 0;
  const seconds = project.seconds || 30;
  const generated = Math.ceil(seconds / GEN_SHOT_SECONDS) * GEN_SHOT_SECONDS;
  const rate = pricing.perSecond[project.quality || 'standard'] ?? 0;
  const fee = project.fee_charged ? 0 : pricing.projectFee;
  return fee + rate * generated;
}

/** "2 tries included, then 42 credits" for a shot. Prefers numbers from the status payload. */
export function rerollInfo(status, shot, pricing = DEFAULTS) {
  const shots = status?.shots || [];
  const included = status?.rerolls?.included ?? Math.floor(shots.length * pricing.freeRerollShare);
  const used = status?.rerolls?.used ?? status?.project?.rerolls_used ?? 0;
  const left = Math.max(0, included - used);
  const credits = status?.rerolls?.credits ?? shotCredits(shot, pricing);
  return { left, credits, text: `${left} ${left === 1 ? 'try' : 'tries'} included, then ${credits} credits` };
}

// ---- dates

/** "Dec 14, 2026" or '' when there is no date. */
export function formatDate(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ---- jobs

export const ACTIVE_JOB = new Set(['queued', 'running']);
export const anyJobActive = (jobs = []) => jobs.some((j) => ACTIVE_JOB.has(j.status));
