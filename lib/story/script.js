import { completeJSON } from '../providers/llm.js';
import { ProviderError } from '../providers/errors.js';
import { screenText } from '../moderation.js';
import { storyDb } from './db.js';
import { ConflictError, NotFoundError, StoryError, ValidationError } from './errors.js';
import { getProject, STEPS } from './projects.js';
import { assertAllowed } from './limits.js';
import { registerAction } from './actions.js';
import { styleFragment } from './prompts/styles.js';
import {
  buildBriefMessage, buildReviseMessage, buildRetryMessage, buildScriptSystem,
  MAX_HOOK_WORDS, MAX_LINE_WORDS, SCRIPT_SCHEMA, wordBudget,
} from './prompts/script.js';
import './mocks.js';

/*
 * The script writer (spec 7.3 step 6, 7.5).
 *
 * A script is a list of scenes, stored as a new story_scripts row for every
 * change (version 1, 2, ...); old versions are never changed.
 *   Scene = { id, title, visual, lines:[{ speaker, text }], mention? }
 *   speaker is 'narrator' or a character's first name. `mention: true` marks
 *   the one scene that mentions the offer; other scenes have no mention key.
 *   Ids ('s1', 's2', ...) are assigned here, never by the model. A revise or
 *   an edit keeps the id of every scene that is still there, so later steps
 *   can tell what changed; a new scene gets an id no earlier version used.
 *
 * Every function returns the script row with `violations` attached
 * ([{ sceneId, rule, message }] from checkScriptRules). story_scripts has no
 * violations column, so they are not stored; call checkScriptRules on a
 * stored script to get them again.
 */

const MAX_SCENES = 20;
const MAX_LINES_PER_SCENE = 8;
const MAX = { title: 80, visual: 600, speaker: 40, text: 400, instruction: 1000 };
// Purposes whose story needs the offer described in the brief.
const NEEDS_OFFER = ['product', 'app', 'coaching', 'service'];

// ---------------------------------------------------------------- scenes changed hook

const listeners = new Set();

/**
 * Registers fn({ projectId, sceneIds }) to run after a save that changed
 * scenes (the storyboard marks those scenes' shots stale). sceneIds lists
 * every scene that was added, edited or removed. Returns an unsubscribe
 * function. Listeners are awaited; a listener that throws fails the call
 * after the new version is saved.
 */
export function onScenesChanged(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function notifyChanged(projectId, sceneIds) {
  if (!sceneIds.length) return;
  for (const fn of [...listeners]) await fn({ projectId, sceneIds: [...sceneIds] });
}

// ---------------------------------------------------------------- rule checker

/**
 * Studio, film, character and celebrity names that must never appear in a
 * script (global constraint). Matched as whole words, case-insensitive.
 * This list lives in code only; never copy a name into a prompt or UI text.
 */
export const FORBIDDEN_NAMES = Object.freeze([
  'pixar', 'disney', 'dreamworks', 'ghibli', 'marvel', 'dc comics', 'warner bros', 'nickelodeon',
  'cartoon network', 'aardman', 'illumination entertainment', 'sony pictures animation', 'toei',
  'mickey mouse', 'minnie mouse', 'donald duck', 'shrek', 'minions', 'spongebob', 'spider man', 'spiderman',
  'batman', 'superman', 'harry potter', 'pikachu', 'pokemon', 'buzz lightyear', 'lightning mcqueen',
  'goku', 'naruto', 'hello kitty', 'peppa pig', 'bluey', 'barbie', 'lego',
  'taylor swift', 'beyonce', 'kim kardashian', 'elon musk', 'mrbeast', 'mr beast', 'dwayne johnson',
  'oprah', 'kanye', 'rihanna', 'lebron', 'messi', 'cristiano ronaldo', 'tom cruise', 'keanu reeves',
  'zendaya', 'ariana grande', 'justin bieber', 'snoop dogg', 'gordon ramsay',
]);

// Words that make "free" a named thing rather than "free" on its own.
const FREE_AFTER = new Set([
  'trial', 'trials', 'consultation', 'consult', 'call', 'demo', 'quote', 'estimate', 'class', 'lesson',
  'session', 'sample', 'samples', 'shipping', 'delivery', 'plan', 'version', 'tier', 'month', 'week',
  'workshop', 'webinar', 'guide', 'checklist', 'audit', 'assessment', 'time', 'refill', 'refills',
]);
const FREE_BEFORE = new Set(['feel', 'gluten', 'sugar', 'dairy', 'caffeine', 'alcohol', 'nut', 'fat', 'hands', 'cruelty', 'duty']);

const DASH = /[-‐-―−]/;
const GUARANTEE = /\bguarant(?:ee|ees|eed|eeing)\b/i;
const CTA_PHRASES = [
  /\blink in (?:my |the )?bio\b/i,
  /\bcheck (?:it|them|us|this) out below\b/i,
  /\blink below\b/i,
  /\b(?:click|tap) (?:the|that|this) (?:link|button)\b/i,
  /\b(?:download|get) (?:it|the app) (?:now|today)\b/i,
  /\bdownload now\b/i,
  /\bsign up (?:now|today)\b/i,
  /\b(?:book|order|shop|buy) (?:now|today)\b/i,
  /\bfollow (?:me |us )?for more\b/i,
  /\bvisit (?:our|my) (?:website|site|page)\b/i,
  /\bdm me\b/i,
  /\bcomment below\b/i,
];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Whole-term match; spaces in a term match any run of spaces or hyphens.
function termRegex(term) {
  const body = escapeRe(term.trim().toLowerCase()).replace(/\s+/g, '[\\s\\-]+');
  const start = /^\w/.test(term.trim()) ? '\\b' : '';
  const end = /\w$/.test(term.trim()) ? '\\b' : '';
  return new RegExp(`${start}${body}${end}`, 'i');
}
const FORBIDDEN_RES = FORBIDDEN_NAMES.map(termRegex);

const wordsIn = (text) => String(text || '').trim().split(/\s+/).filter(Boolean);

function hasLoneFree(text) {
  const tokens = String(text).toLowerCase().match(/[a-z']+/g) || [];
  return tokens.some((t, i) => t === 'free' && !FREE_AFTER.has(tokens[i + 1]) && !FREE_BEFORE.has(tokens[i - 1]));
}

const sceneTexts = (scene) => [scene.title, scene.visual, ...(scene.lines || []).map((l) => l.text)].filter(Boolean);

/**
 * Deterministic script rules (no model). Options default so the one argument
 * call works; without `seconds` the word budget is not checked.
 * Returns [{ sceneId, rule, message }]; sceneId is null for whole-script rules.
 *
 * Rules: empty_script, visual_missing, hook_length, line_length, dash,
 * free_alone, guarantee, call_to_action, forbidden_name, avoid_word,
 * narrator_only, narrator_placement, no_dialogue, mention_count,
 * mention_in_story, word_budget.
 */
export function checkScriptRules(scenes, { seconds, mode = 'narrated', purpose, avoid = [], cta = false } = {}) {
  const out = [];
  const add = (sceneId, rule, message) => out.push({ sceneId: sceneId ?? null, rule, message });
  const list = Array.isArray(scenes) ? scenes : [];
  if (!list.length) {
    add(null, 'empty_script', 'The script has no scenes yet.');
    return out;
  }
  const avoidRes = (avoid || []).filter((w) => typeof w === 'string' && w.trim()).map((w) => [w.trim(), termRegex(w)]);
  const firstLineScene = list.find((s) => (s.lines || []).length);
  let mentions = 0;
  let characterLines = 0;

  list.forEach((scene, index) => {
    const id = scene.id ?? null;
    const lines = scene.lines || [];
    if (!String(scene.visual || '').trim()) add(id, 'visual_missing', 'Describe what we see in this scene.');

    lines.forEach((line, lineIndex) => {
      const text = String(line.text || '');
      const count = wordsIn(text).length;
      if (scene === firstLineScene && lineIndex === 0 && count > MAX_HOOK_WORDS) {
        add(id, 'hook_length', `The first line has ${count} words. Keep the hook to ${MAX_HOOK_WORDS} words or fewer so it lands in the first two seconds.`);
      } else if (count > MAX_LINE_WORDS) {
        add(id, 'line_length', `A line has ${count} words. Keep each line to ${MAX_LINE_WORDS} words or fewer.`);
      }
      if (DASH.test(text)) add(id, 'dash', 'A line has a dash or hyphen. Use a full stop or a comma instead, and write hyphenated words as two words.');
      if (hasLoneFree(text)) add(id, 'free_alone', 'A line says "free" on its own. Say what is free, like "free trial", or leave it out.');
      if (GUARANTEE.test(text)) add(id, 'guarantee', 'A line makes a guarantee. Show what happened in the story instead of promising results.');
      if (!cta && CTA_PHRASES.some((re) => re.test(text))) {
        add(id, 'call_to_action', 'A line asks viewers to act, like "check it out below". Leave that to the caption and button.');
      }
      const speaker = String(line.speaker || '').trim().toLowerCase();
      if (speaker !== 'narrator') characterLines += 1;
      if (mode === 'narrated' && speaker !== 'narrator') {
        add(id, 'narrator_only', 'This is a narrated video, so only the narrator speaks. Give this line to the narrator.');
      }
      if (mode === 'talking' && speaker === 'narrator' && index !== 0 && index !== list.length - 1) {
        add(id, 'narrator_placement', 'In a talking video the narrator can only open or close the story. Give this line to a character.');
      }
    });

    const texts = sceneTexts(scene);
    if (texts.some((t) => FORBIDDEN_RES.some((re) => re.test(t)))) {
      add(id, 'forbidden_name', 'This scene names a studio, a famous character or a celebrity. Describe the look in plain words instead.');
    }
    const found = avoidRes.filter(([, re]) => texts.some((t) => re.test(t))).map(([w]) => w);
    if (found.length) {
      add(id, 'avoid_word', `This scene uses ${found.map((w) => `"${w}"`).join(', ')}, which is on your list of words to avoid.`);
    }

    if (scene.mention === true) {
      mentions += 1;
      if (purpose === 'story') add(id, 'mention_in_story', 'This video is just a story, so nothing should be mentioned or offered. Remove the mention.');
      else if (mentions > 1) add(id, 'mention_count', 'The offer is mentioned in more than one scene. Keep one natural mention.');
    }
  });

  if (mode === 'talking' && characterLines === 0) {
    add(null, 'no_dialogue', 'This is a talking video, but no character speaks. Give the characters some lines.');
  }
  if (Number.isFinite(seconds) && seconds > 0) {
    const { min, max } = wordBudget(seconds, mode);
    const total = list.reduce((n, s) => n + (s.lines || []).reduce((m, l) => m + wordsIn(l.text).length, 0), 0);
    if (total < min || total > max) {
      add(null, 'word_budget', `The script has ${total} spoken words. A ${seconds} second video needs ${min} to ${max}, so ${total < min ? 'add a little more' : 'trim it down'}.`);
    }
  }
  return out;
}

// ---------------------------------------------------------------- scene helpers

const clean = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function normalizeScene(raw) {
  const lines = (Array.isArray(raw?.lines) ? raw.lines : [])
    .map((l) => {
      const speaker = clean(l?.speaker, MAX.speaker);
      return { speaker: /^narrator$/i.test(speaker) ? 'narrator' : speaker || 'narrator', text: clean(l?.text, MAX.text) };
    })
    .filter((l) => l.text)
    .slice(0, MAX_LINES_PER_SCENE);
  const scene = { id: typeof raw?.id === 'string' ? raw.id.trim() : '', title: clean(raw?.title, MAX.title), visual: clean(raw?.visual, MAX.visual), lines };
  if (raw?.mention === true) scene.mention = true;
  return scene;
}

const idNumber = (id) => (/^s(\d+)$/.exec(id || '') ? Number(/^s(\d+)$/.exec(id)[1]) : 0);

/**
 * Gives every scene a server id. `keep` holds the ids of the version being
 * revised: a model-given id is kept only if it is in `keep` and not used twice.
 * New ids start after every id seen so far (`seen`), so an id is never reused
 * for a different scene.
 */
function assignIds(scenes, { keep = new Set(), seen = [] } = {}) {
  let next = Math.max(0, ...seen.map(idNumber), ...[...keep].map(idNumber));
  const used = new Set();
  return scenes.map((scene) => {
    let id = scene.id;
    if (!keep.has(id) || used.has(id)) id = `s${++next}`;
    used.add(id);
    return { ...scene, id };
  });
}

function scenesFromModel(raw, idOptions) {
  const list = Array.isArray(raw?.scenes) ? raw.scenes.slice(0, MAX_SCENES).map(normalizeScene) : [];
  return assignIds(list, idOptions);
}

// Compared by value; jsonb does not keep object key order, so no object keys here.
const sceneKey = ({ title, visual, lines, mention }) =>
  JSON.stringify([title, visual, (lines || []).map((l) => [l.speaker, l.text]), mention === true]);

/** Ids added, edited or removed between two scene lists. */
export function changedSceneIds(before = [], after = []) {
  const old = new Map(before.map((s) => [s.id, sceneKey(s)]));
  const now = new Set(after.map((s) => s.id));
  const changed = after.filter((s) => old.get(s.id) !== sceneKey(s)).map((s) => s.id);
  const removed = before.filter((s) => !now.has(s.id)).map((s) => s.id);
  return [...changed, ...removed];
}

// ---------------------------------------------------------------- data

async function latestScript(projectId) {
  const [row] = await storyDb().select('story_scripts', { project_id: projectId }, { order: '-version', limit: 1 });
  return row || null;
}

async function saveVersion(projectId, previous, { scenes, source, instruction = null }) {
  try {
    const [row] = await storyDb().insert('story_scripts', {
      project_id: projectId,
      version: (previous?.version || 0) + 1,
      scenes,
      source,
      instruction,
    });
    return row;
  } catch (err) {
    if (err?.code === '23505' || /duplicate key/i.test(err?.message || '')) {
      throw new ConflictError('Another change to this script was saved at the same moment. Reload and try again.');
    }
    throw err;
  }
}

async function loadContext(userId, projectId) {
  const project = await getProject({ userId, id: projectId });
  const db = storyDb();
  const [[brand], [reference]] = await Promise.all([
    db.select('story_brand', { user_id: userId }),
    project.reference_id ? db.select('story_references', { id: project.reference_id, project_id: project.id }) : Promise.resolve([]),
  ]);
  const beats = reference?.status === 'ready' && Array.isArray(reference.beat_sheet) && reference.beat_sheet.length ? reference.beat_sheet : null;
  const brief = {
    purpose: project.purpose,
    offer: project.offer,
    audience: project.audience,
    avoid: brand?.avoid || [],
    tone: brand?.tone || null,
    style: styleFragment(project),
    seconds: project.seconds,
    mode: project.mode,
    beats,
  };
  const rules = { seconds: project.seconds, mode: project.mode, purpose: project.purpose, avoid: brief.avoid, cta: false };
  return { project, brief, rules };
}

function requireBrief({ purpose, offer }) {
  if (!purpose) throw new ValidationError('Choose what this video is for before writing the script.', { field: 'purpose' });
  if (NEEDS_OFFER.includes(purpose) && !String(offer || '').trim()) {
    throw new ValidationError('Describe the offer in a sentence or two before writing the script.', { field: 'offer' });
  }
}

// The customer's own text that goes into the prompt. Avoid words are not screened:
// a list of words to keep out of the video can fairly contain words moderation blocks.
const briefTexts = (brief, project) => [brief.offer, brief.audience, brief.tone, project.style_custom];

/**
 * One model call, checked, and retried once with the problems fed back.
 * Returns { scenes, violations }. A failed retry keeps the first answer.
 */
async function draft({ system, userMessage, rules, idOptions }) {
  const messages = [{ role: 'user', content: userMessage }];
  const ask = (msgs) => completeJSON({ name: 'story_script', tier: 'smart', system, messages: msgs, schema: SCRIPT_SCHEMA, maxTokens: 8000 });

  const first = await ask(messages);
  let scenes = scenesFromModel(first, idOptions);
  let violations = checkScriptRules(scenes, rules);
  if (violations.length) {
    try {
      const retry = await ask([
        ...messages,
        { role: 'assistant', content: JSON.stringify(first) },
        { role: 'user', content: buildRetryMessage(violations) },
      ]);
      const retried = scenesFromModel(retry, idOptions);
      const retriedViolations = checkScriptRules(retried, rules);
      if (retried.length && retriedViolations.length <= violations.length) {
        scenes = retried;
        violations = retriedViolations;
      }
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
    }
  }
  if (!scenes.length) throw new StoryError("We couldn't write a script this time. Please try again.", { status: 502, code: 'script_failed' });
  return { scenes, violations };
}

async function advanceStep(project) {
  if (STEPS.indexOf(project.step) < STEPS.indexOf('script')) {
    await storyDb().update('story_projects', { id: project.id, user_id: project.user_id }, { step: 'script' });
  }
}

// ---------------------------------------------------------------- services

/** The latest script version (with violations), or null when none is written yet. */
export async function getScript({ userId, projectId }) {
  const { rules } = await loadContext(userId, projectId);
  const row = await latestScript(projectId);
  return row ? { ...row, violations: checkScriptRules(row.scenes, rules) } : null;
}

/**
 * Writes a script from the brief (or from the reference's beat sheet when the
 * project has an analysed reference) and saves it as the next version.
 * Moves the project to the script step unless it is already further on.
 */
export async function writeScript({ userId, projectId, user }) {
  const { project, brief, rules } = await loadContext(userId, projectId);
  requireBrief(brief);
  await screenText(briefTexts(brief, project));
  await assertAllowed({ userId, action: 'script_write', projectId, user });

  const previous = await latestScript(projectId);
  const { scenes, violations } = await draft({
    system: buildScriptSystem({ purpose: brief.purpose, mode: brief.mode, seconds: brief.seconds, cta: rules.cta, beats: brief.beats }),
    userMessage: buildBriefMessage(brief),
    rules,
    idOptions: { seen: (previous?.scenes || []).map((s) => s.id) },
  });
  const row = await saveVersion(projectId, previous, { scenes, source: brief.beats ? 'reference' : 'brief' });
  await advanceStep(project);
  if (previous) await notifyChanged(projectId, changedSceneIds(previous.scenes, scenes));
  return { ...row, violations };
}

/**
 * Applies a customer's instruction ("make the opening funnier") to the
 * current script with the same rules. Unchanged scenes keep their ids.
 * -> { script, changedSceneIds }
 */
export async function reviseScript({ userId, projectId, instruction, user }) {
  const text = typeof instruction === 'string' ? instruction.trim() : '';
  if (!text) throw new ValidationError('Say what you would like to change.', { field: 'instruction' });
  if (text.length > MAX.instruction) {
    throw new ValidationError(`Keep the request to ${MAX.instruction} characters or fewer.`, { field: 'instruction' });
  }
  const { project, brief, rules } = await loadContext(userId, projectId);
  const previous = await latestScript(projectId);
  if (!previous) throw new ValidationError('Write the script first, then ask for changes.', { field: 'instruction' });
  await screenText([text]);
  await assertAllowed({ userId, action: 'script_write', projectId, user });

  const { scenes, violations } = await draft({
    system: buildScriptSystem({ purpose: project.purpose, mode: project.mode, seconds: project.seconds, cta: rules.cta, beats: brief.beats, revise: true }),
    userMessage: buildReviseMessage(brief, previous.scenes, text),
    rules,
    idOptions: { keep: new Set(previous.scenes.map((s) => s.id)) },
  });
  const row = await saveVersion(projectId, previous, { scenes, source: 'revision', instruction: text });
  const changed = changedSceneIds(previous.scenes, scenes);
  await notifyChanged(projectId, changed);
  return { script: { ...row, violations }, changedSceneIds: changed };
}

const PATCH_FIELDS = ['title', 'visual', 'lines', 'mention'];

function cleanPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new ValidationError('Expected a JSON object.', { field: 'patch' });
  const out = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!PATCH_FIELDS.includes(key)) throw new ValidationError(`${key} cannot be changed.`, { field: key });
    if (key === 'mention') {
      if (typeof value !== 'boolean') throw new ValidationError('mention must be true or false.', { field: key });
      out.mention = value;
    } else if (key === 'lines') {
      if (!Array.isArray(value) || value.length > MAX_LINES_PER_SCENE) {
        throw new ValidationError(`A scene has at most ${MAX_LINES_PER_SCENE} lines.`, { field: key });
      }
      out.lines = value.map((l) => {
        if (!l || typeof l.speaker !== 'string' || typeof l.text !== 'string' || !l.speaker.trim() || !l.text.trim()) {
          throw new ValidationError('Each line needs a speaker and some text.', { field: key });
        }
        if (l.speaker.length > MAX.speaker || l.text.length > MAX.text) throw new ValidationError('That line is too long.', { field: key });
        const speaker = clean(l.speaker, MAX.speaker);
        return { speaker: /^narrator$/i.test(speaker) ? 'narrator' : speaker, text: clean(l.text, MAX.text) };
      });
    } else {
      if (typeof value !== 'string') throw new ValidationError(`${key} must be text.`, { field: key });
      if (value.length > MAX[key]) throw new ValidationError(`${key} must be at most ${MAX[key]} characters.`, { field: key });
      out[key] = clean(value, MAX[key]);
    }
  }
  if (!Object.keys(out).length) throw new ValidationError('Nothing to change.', { field: 'patch' });
  return out;
}

/**
 * A direct customer edit of one scene: { title?, visual?, lines?, mention? }.
 * Setting mention moves the one mention to this scene. Saves a new version
 * (unless nothing changed) and re-checks the rules.
 * -> { script, changedSceneIds }
 */
export async function updateScene({ userId, projectId, sceneId, patch }) {
  const fields = cleanPatch(patch);
  const { rules } = await loadContext(userId, projectId);
  const previous = await latestScript(projectId);
  const index = previous ? previous.scenes.findIndex((s) => s.id === sceneId) : -1;
  if (index < 0) throw new NotFoundError('Scene not found.');
  await screenText([fields.title, fields.visual, ...(fields.lines || []).flatMap((l) => [l.speaker, l.text])]);

  const scenes = previous.scenes.map((scene, i) => {
    let next = i === index ? { ...scene, ...fields } : { ...scene };
    if (fields.mention === true && i !== index) delete next.mention;
    if (next.mention !== true) {
      const { mention, ...rest } = next;
      next = rest;
    }
    return next;
  });
  const changed = changedSceneIds(previous.scenes, scenes);
  if (!changed.length) return { script: { ...previous, violations: checkScriptRules(previous.scenes, rules) }, changedSceneIds: [] };

  const row = await saveVersion(projectId, previous, { scenes, source: 'edit' });
  await notifyChanged(projectId, changed);
  return { script: { ...row, violations: checkScriptRules(scenes, rules) }, changedSceneIds: changed };
}

// ---------------------------------------------------------------- HTTP actions

// GET   /api/story/projects/[id]/script  -> { script }   (null before the first write)
// POST  /api/story/projects/[id]/script  -> { script }
// POST  /api/story/projects/[id]/revise  { instruction }        -> { script, changedSceneIds }
// PATCH /api/story/projects/[id]/scene   { sceneId, patch }     -> { script, changedSceneIds }
registerAction('script', {
  method: 'GET',
  handler: async ({ userId, projectId }) => ({ script: await getScript({ userId, projectId }) }),
});
registerAction('script', {
  method: 'POST',
  handler: async ({ userId, user, projectId }) => ({ script: await writeScript({ userId, projectId, user }) }),
});
registerAction('revise', {
  method: 'POST',
  handler: async ({ userId, user, projectId, body }) => reviseScript({ userId, projectId, instruction: body.instruction, user }),
});
registerAction('scene', {
  method: 'PATCH',
  handler: async ({ userId, projectId, body }) => {
    if (typeof body.sceneId !== 'string' || !body.sceneId) throw new ValidationError('Say which scene to change.', { field: 'sceneId' });
    return updateScene({ userId, projectId, sceneId: body.sceneId, patch: body.patch });
  },
});
