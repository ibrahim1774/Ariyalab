import { completeJSON } from '../providers/llm.js';
import { ProviderError } from '../providers/errors.js';
import { ModerationError, screenText, screenTextRegex } from '../moderation.js';
import { storyDb } from './db.js';
import { ConflictError, NotFoundError, StoryError, ValidationError } from './errors.js';
import { getProject, STEPS } from './projects.js';
import { assertAllowed, releaseAllowance } from './limits.js';
import { registerAction } from './actions.js';
import { styleFragment } from './prompts/styles.js';
import {
  buildBriefMessage, buildReviseMessage, buildRetryMessage, buildScriptSystem,
  cleanAvoid, FAMILY_FRIENDLY_GUIDANCE, MAX_HOOK_WORDS, SHORT_SCRIPT_SECONDS, maxLineWords, SCRIPT_SCHEMA, wordBudget,
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
  'pixar', 'disney', 'dreamworks', 'ghibli', 'marvel studios', 'marvel comics', 'dc comics', 'warner bros', 'nickelodeon',
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

// Every Unicode dash (hyphen-minus, en and em dashes, small and fullwidth
// forms, two and three em dashes), the minus sign and the soft hyphen.
const DASH = /[\p{Pd}\u2212\u00AD]/u;
const GUARANTEE = /\bguarant(?:y|ee\w*)\b/i;
// Promises of results. A bare percentage is flagged too: violations are
// warnings, and a percentage in an ad reads as a claim far more often than not.
const PROMISES = [
  /\bpromis(?:e|es|ing)\b/i, // "promised" is past and usually part of the story
  /\bmoney back\b/i,
  /\d+(?:\.\d+)?\s?%/,
  /\b(?:\d+|a hundred|one hundred) percent\b/i,
  /\b(?:double|triple|quadruple|\d+x)\s+your\b/i,
  /\bresults? in (?:\d+|a|one|two|three|four|five|six|seven|ten|a few) (?:days?|weeks?|months?)\b/i,
  /\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|twenty|fifty|a hundred)\s+(?:new\s+)?(?:clients|customers|bookings|sales|leads|patients|students)\s+(?:a|per|every)\s+(?:day|week|month)\b/i,
  /\b(?:make|earn|making|earning)\s+(?:over\s+|up to\s+)?[$\u00a3\u20ac]\s?\d/i,
  /[$\u00a3\u20ac]\s?\d[\d,.]*k?\s*(?:a|per|every)\s+(?:day|week|month|year)\b/i,
];
// Imperative closers checked in the last scene when the project has no call to action.
const CLOSER = /\b(?:tap|click|check it out|link in bio|sign up|download|get started|book now|visit)\b/i;
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
// Accents off ("Beyonc\u00e9" becomes "Beyonce"), for names and avoid words.
const fold = (s) => String(s || '').normalize('NFD').replace(/\p{M}/gu, '');
/**
 * A whole-word matcher for a name or avoid word, on folded text. Spaces,
 * hyphens and full stops are optional separators on both sides, so
 * "pay-day", "pay day", "pay.day" and "payday" all match each other, and
 * "mr beast" matches "Mr. Beast". The text is split into words and runs of
 * consecutive words are joined and compared with the term's letters.
 * A term with other symbols ("c++") falls back to a plain whole-term regex.
 */
function termMatcher(term) {
  const t = fold(term).trim().toLowerCase();
  if (/^[\p{L}\p{N}\s.'\u2019-]+$/u.test(t)) {
    const key = t.replace(/[^\p{L}\p{N}]+/gu, '');
    return {
      test(text) {
        if (!key) return false;
        const words = fold(text).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
        for (let i = 0; i < words.length; i += 1) {
          let joined = '';
          for (let j = i; j < words.length && joined.length < key.length; j += 1) {
            joined += words[j];
            if (joined === key) return true;
          }
        }
        return false;
      },
    };
  }
  const start = /^\w/.test(t) ? '\\b' : '';
  const end = /\w$/.test(t) ? '\\b' : '';
  return new RegExp(`${start}${escapeRe(t)}${end}`, 'i');
}
const FORBIDDEN_RES = FORBIDDEN_NAMES.map(termMatcher);

const wordsIn = (text) => String(text || '').trim().split(/\s+/).filter(Boolean);

function hasLoneFree(text) {
  const tokens = String(text).toLowerCase().match(/[a-z']+/g) || [];
  return tokens.some((t, i) => t === 'free' && !FREE_AFTER.has(tokens[i + 1]) && !FREE_BEFORE.has(tokens[i - 1]));
}

const sceneTexts = (scene) => [scene.title, scene.visual, ...(scene.lines || []).map((l) => l.text)].filter(Boolean).map(fold);

// ---- reference copies (Task 22)
// A reference sentence counts as copied only when it has at least 4 words, 2 of them outside COMMON_WORDS
// ("Thank you.", "Let me tell you." are too common to call a copy).
export const MIN_COPY_SENTENCE_WORDS = 4;
// Runs shared with a line. A transcript with no sentence breaks at all is one long "sentence": there a run of at
// least 6 words, 2 of them outside COMMON_WORDS, is a copy. A punctuated transcript also gets run matching (so a
// long sentence copied in part is caught) at a stricter threshold: 8 words, 3 of them uncommon.
export const MIN_COPY_RUN_WORDS = 6;
export const MIN_COPY_RARE_WORDS = 2;
export const MIN_COPY_RUN_WORDS_PUNCTUATED = 8;
export const MIN_COPY_RARE_WORDS_PUNCTUATED = 3;
const SENTENCE_BREAK = /[.!?\u2026]/;
/** Lower case, accents folded, punctuation as spaces, single spaces. */
export const normaliseForCopy = (s) => fold(s).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

// Words too common to make a shared phrase a copy ("at the end of", "a lot of people").
const COMMON_WORDS = new Set((
  'i me my mine you your we our us he him his she her it its they them their a an the and or but so to of in on at for '
  + 'with from by as is are was were be been being am do does did have has had not no yes that this these those there here '
  + 'what when where who why how all just can will would could should want get got go going gone know like out up down '
  + 'about if then than now very really too one some any more much t s re ll ve m d don didn can won isn it s let'
).split(' '));
const rareCount = (words) => words.filter((w) => !COMMON_WORDS.has(w)).length;

/** The reference transcript's sentences (normalised) that count as copied when a line contains one. */
export function referenceSentences(text) {
  return String(text || '')
    .split(/(?<=[.!?\u2026])\s+|\n+/)
    .map(normaliseForCopy)
    .filter((s) => {
      const words = wordsIn(s);
      return words.length >= MIN_COPY_SENTENCE_WORDS && rareCount(words) >= MIN_COPY_RARE_WORDS;
    });
}

/** What the checker needs from a transcript: its sentences, and the whole text when run matching applies. */
function referenceMatcher(reference) {
  const text = String(reference || '');
  if (!text.trim()) return null;
  const punctuated = SENTENCE_BREAK.test(text);
  return {
    sentences: referenceSentences(text),
    whole: ` ${normaliseForCopy(text)} `,
    runWords: punctuated ? MIN_COPY_RUN_WORDS_PUNCTUATED : MIN_COPY_RUN_WORDS,
    rareWords: punctuated ? MIN_COPY_RARE_WORDS_PUNCTUATED : MIN_COPY_RARE_WORDS,
  };
}

/** The words of the line copied from the reference (normalised), or null. */
function copiedFromReference(text, matcher) {
  const line = normaliseForCopy(text);
  if (!line || !matcher) return null;
  const padded = ` ${line} `;
  const sentence = matcher.sentences.find((s) => padded.includes(` ${s} `));
  if (sentence) return sentence;
  const words = wordsIn(line);
  const inRef = (from, to) => matcher.whole.includes(` ${words.slice(from, to).join(' ')} `);
  for (let i = 0; i + matcher.runWords <= words.length; i += 1) {
    if (!inRef(i, i + matcher.runWords)) continue;
    let end = i + matcher.runWords;
    while (end < words.length && inRef(i, end + 1)) end += 1;
    const run = words.slice(i, end);
    if (rareCount(run) >= matcher.rareWords) return run.join(' ');
  }
  return null;
}

/**
 * Deterministic script rules (no model). Options default so the one argument
 * call works; without `seconds` the word budget is not checked.
 * Returns [{ sceneId, rule, message }]; sceneId is null for whole-script rules.
 *
 * Rules: empty_script, visual_missing, hook_late, hook_length, line_length,
 * dash, free_alone, guarantee, promise, call_to_action, cta, forbidden_name,
 * avoid_word, narrator_only, narrator_placement, no_dialogue, mention_count,
 * mention_in_story, mention_without_offer, word_budget, reference_copy.
 * `reference`: the reference video's transcript text (Task 22). After
 * normalising case, accents and punctuation, a line that contains one of its
 * sentences (4 words or more, 2 of them uncommon) is flagged reference_copy,
 * with the copied words in `matched`. Runs shared with the line count too: 6
 * words or more (2 uncommon) for a transcript with no sentence breaks at all,
 * 8 words or more (3 uncommon) for a punctuated one. `referenceKeep`: line texts already in the previous version
 * (the customer's own), which are not flagged again. A model-written script
 * that still copies after the retry is not saved (422 script_blocked); a
 * customer's own edit is only warned.
 * `offer`: when given (the project's offer text, possibly empty), a mention
 * on a project with no offer is flagged; when omitted it is not checked.
 */
export function checkScriptRules(scenes, { seconds, mode = 'narrated', purpose, avoid = [], cta = false, offer, reference = '', referenceKeep = [] } = {}) {
  const out = [];
  const add = (sceneId, rule, message, extra) => out.push({ sceneId: sceneId ?? null, rule, message, ...extra });
  const list = Array.isArray(scenes) ? scenes : [];
  if (!list.length) {
    add(null, 'empty_script', 'The script has no scenes yet.');
    return out;
  }
  const avoidRes = cleanAvoid(avoid).map((w) => [w, termMatcher(w)]);
  const firstLineScene = list.find((s) => (s.lines || []).length);
  const maxLine = maxLineWords(mode);
  const noOffer = offer !== undefined && !String(offer || '').trim();
  const refMatcher = referenceMatcher(reference);
  const keepLines = new Set([...(referenceKeep || [])].map(normaliseForCopy));
  if (!(list[0].lines || []).length) {
    add(list[0].id, 'hook_late', 'Nothing is said in the first scene, so the hook comes too late. Open with a spoken line in the first two seconds.');
  }
  let mentions = 0;
  let characterLines = 0;

  list.forEach((scene, index) => {
    const id = scene.id ?? null;
    const lines = scene.lines || [];
    if (!String(scene.visual || '').trim()) add(id, 'visual_missing', 'Describe what we see in this scene.');

    lines.forEach((line, lineIndex) => {
      const text = String(line.text || '');
      const count = wordsIn(text).length;
      // A video of 10 seconds or less is one or two lines: the line is the whole story, so no separate hook limit.
      if (!(Number.isFinite(seconds) && seconds <= SHORT_SCRIPT_SECONDS) && scene === firstLineScene && lineIndex === 0 && count > MAX_HOOK_WORDS) {
        add(id, 'hook_length', `The first line has ${count} words. Keep the hook to ${MAX_HOOK_WORDS} words or fewer so it lands in the first two seconds.`);
      } else if (count > maxLine) {
        add(id, 'line_length', `A line has ${count} words. Keep each line to ${maxLine} words or fewer${mode === 'talking' ? ' so it fits one shot' : ''}.`);
      }
      const copied = refMatcher && !keepLines.has(normaliseForCopy(text)) ? copiedFromReference(text, refMatcher) : null;
      if (copied) {
        add(id, 'reference_copy', 'A line repeats words from the reference video. Say it in new words that fit your story.', { matched: copied });
      }
      if (DASH.test(text)) add(id, 'dash', 'A line has a dash or hyphen. Use a full stop or a comma instead, and write hyphenated words as two words.');
      if (hasLoneFree(text)) add(id, 'free_alone', 'A line says "free" on its own. Say what is free, like "free trial", or leave it out.');
      if (GUARANTEE.test(text)) add(id, 'guarantee', 'A line makes a guarantee. Show what happened in the story instead of promising results.');
      else if (PROMISES.some((re) => re.test(text))) {
        add(id, 'promise', 'A line promises results, like a number, a percentage or money. Show what happened to the hero instead of promising it to viewers.');
      }
      const listedCta = !cta && CTA_PHRASES.some((re) => re.test(text));
      if (listedCta) {
        add(id, 'call_to_action', 'A line asks viewers to act, like "check it out below". Leave that to the caption and button.');
      } else if (!cta && index === list.length - 1 && CLOSER.test(text)) {
        add(id, 'cta', 'The last line sounds like it tells viewers to do something. End on the story and let the caption and button do that.');
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
      else if (noOffer) add(id, 'mention_without_offer', 'This scene is marked as the mention, but the project has no offer to mention. Remove the mention or add the offer to the brief.');
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

/** Every scene id any version of this project ever used, so no id is reissued. */
async function idsEverUsed(projectId) {
  const rows = await storyDb().select('story_scripts', { project_id: projectId }, { columns: ['scenes'], order: '-version', limit: 1000 });
  return rows.flatMap((r) => (Array.isArray(r.scenes) ? r.scenes : []).map((s) => s.id));
}

async function saveVersion(projectId, previous, { scenes, source, instruction = null, draftJobId = null }) {
  try {
    const [row] = await storyDb().insert('story_scripts', {
      project_id: projectId,
      version: (previous?.version || 0) + 1,
      scenes,
      source,
      instruction,
      // The MCP drafting job that wrote this version (lib/story/draftJobs.js), so its retry knows it was saved.
      ...(draftJobId ? { draft_job_id: draftJobId } : {}),
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
    avoid: cleanAvoid(brand?.avoid),
    tone: brand?.tone || null,
    style: styleFragment(project),
    seconds: project.seconds,
    mode: project.mode,
    beats,
  };
  // The ready reference's transcript: a line that repeats one of its sentences is flagged (and retried once).
  const referenceText = beats ? String(reference.transcript?.text || '') : '';
  const rules = { seconds: project.seconds, mode: project.mode, purpose: project.purpose, avoid: brief.avoid, cta: false, offer: project.offer || '', reference: referenceText };
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
const COPY_MESSAGE = 'We could not write a script that is different enough from your reference video. Try again, or start from another video.';
const copiesRef = (violations) => violations.some((v) => v.rule === 'reference_copy');

async function draft({ system, userMessage, rules, idOptions }) {
  const messages = [{ role: 'user', content: userMessage }];
  const ask = (msgs) => completeJSON({ name: 'story_script', tier: 'smart', system, messages: msgs, schema: SCRIPT_SCHEMA, maxTokens: 8000 });

  const first = await ask(messages);
  let scenes = scenesFromModel(first, idOptions);
  let violations = checkScriptRules(scenes, rules);
  if (violations.length) {
    try {
      // The model sees its answer with the ids the problems refer to, and keeps them.
      const retry = await ask([
        ...messages,
        { role: 'assistant', content: JSON.stringify({ scenes }) },
        { role: 'user', content: buildRetryMessage(violations, scenes) },
      ]);
      const keep = new Set([...(idOptions.keep || []), ...scenes.map((s) => s.id)]);
      const retried = scenesFromModel(retry, { ...idOptions, keep });
      const retriedViolations = checkScriptRules(retried, rules);
      // With a reference, an attempt that copies none of its sentences always wins; otherwise the one with fewer warnings.
      const fixesCopy = rules.reference && copiesRef(violations) !== copiesRef(retriedViolations);
      const better = fixesCopy ? !copiesRef(retriedViolations) : retriedViolations.length <= violations.length;
      if (retried.length && better) {
        scenes = retried;
        violations = retriedViolations;
      }
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
    }
  }
  if (!scenes.length) throw new StoryError("We couldn't write a script this time. Please try again.", { status: 502, code: 'script_failed' });
  // The model's script never repeats the reference (spec: structure only). Nothing is saved; the count comes back.
  if (rules.reference && copiesRef(violations)) throw new StoryError(COPY_MESSAGE, { status: 422, code: 'script_blocked' });
  return { scenes, violations };
}

const BLOCKED_MESSAGE = 'We could not write a script we were happy with. Try wording the brief a little differently.';

/** The regex moderation layer, one scene at a time, so words in different scenes never combine. */
function screenScenes(scenes) {
  for (const s of scenes) screenTextRegex([s.title, s.visual, ...s.lines.map((l) => l.text)]);
}

/**
 * draft(), then the written words go through the regex moderation layer
 * before anything is saved. On a trip the draft runs once more with a
 * family friendly instruction; a second trip is StoryError 422
 * 'script_blocked' (the customer did not write those words, so the message
 * does not ask them to change "their" text).
 */
async function draftScript(args) {
  for (const extra of [null, FAMILY_FRIENDLY_GUIDANCE]) {
    const result = await draft(extra ? { ...args, system: `${args.system}\n\n${extra}` } : args);
    try {
      screenScenes(result.scenes);
      return result;
    } catch (err) {
      if (!(err instanceof ModerationError)) throw err;
    }
  }
  throw new StoryError(BLOCKED_MESSAGE, { status: 422, code: 'script_blocked' });
}

/** Runs the model work and the save; gives the counts back if either fails. */
async function withAllowance(allowance, work) {
  try {
    return await work();
  } catch (err) {
    await releaseAllowance(allowance).catch(() => {});
    throw err;
  }
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
export async function writeScript({ userId, projectId, user, allowance: taken, draftJobId = null }) {
  const { project, brief, rules } = await loadContext(userId, projectId);
  requireBrief(brief);
  await screenText(briefTexts(brief, project));
  // taken: a receipt for this write's count, already taken by the caller (a queued MCP draft, lib/story/draftJobs.js),
  // which also gives it back when the write fails; nothing is counted or given back here then.
  const allowance = taken ? null : await assertAllowed({ userId, action: 'script_write', projectId, user });

  const previous = await latestScript(projectId);
  const { scenes, violations, row } = await withAllowance(allowance, async () => {
    const drafted = await draftScript({
      system: buildScriptSystem({ purpose: brief.purpose, offer: brief.offer, mode: brief.mode, seconds: brief.seconds, cta: rules.cta, beats: brief.beats }),
      userMessage: buildBriefMessage(brief),
      rules,
      idOptions: { seen: await idsEverUsed(projectId) },
    });
    const saved = await saveVersion(projectId, previous, { scenes: drafted.scenes, source: brief.beats ? 'reference' : 'brief', draftJobId });
    return { ...drafted, row: saved };
  });
  await advanceStep(project);
  if (previous) await notifyChanged(projectId, changedSceneIds(previous.scenes, scenes));
  return { ...row, violations };
}

/**
 * Applies a customer's instruction ("make the opening funnier") to the
 * current script with the same rules. Unchanged scenes keep their ids.
 * chatCounted: true when the chat helper calls this for a message it has
 * already counted (lib/story/chat.js), so one chat message is one count.
 * Not reachable from the revise route.
 * -> { script, changedSceneIds }
 */
export async function reviseScript({ userId, projectId, instruction, user, chatCounted = false, draftJobId = null }) {
  const text = typeof instruction === 'string' ? instruction.trim() : '';
  if (!text) throw new ValidationError('Say what you would like to change.', { field: 'instruction' });
  if (text.length > MAX.instruction) {
    throw new ValidationError(`Keep the request to ${MAX.instruction} characters or fewer.`, { field: 'instruction' });
  }
  const { project, brief, rules } = await loadContext(userId, projectId);
  const previous = await latestScript(projectId);
  if (!previous) throw new ValidationError('Write the script first, then ask for changes.', { field: 'instruction' });
  await screenText([text]);
  const allowance = chatCounted === true ? null : await assertAllowed({ userId, action: 'script_revise', projectId, user });

  // A line already in the script (the customer may have written it themselves) never makes a revise fail.
  const reviseRules = { ...rules, referenceKeep: previous.scenes.flatMap((sc) => (sc.lines || []).map((l) => l.text)) };
  const { scenes, violations, row } = await withAllowance(allowance, async () => {
    const drafted = await draftScript({
      system: buildScriptSystem({ purpose: project.purpose, offer: project.offer, mode: project.mode, seconds: project.seconds, cta: rules.cta, beats: brief.beats, revise: true }),
      userMessage: buildReviseMessage(brief, previous.scenes, text),
      rules: reviseRules,
      idOptions: { keep: new Set(previous.scenes.map((s) => s.id)), seen: await idsEverUsed(projectId) },
    });
    const saved = await saveVersion(projectId, previous, { scenes: drafted.scenes, source: 'revision', instruction: text, draftJobId });
    return { ...drafted, row: saved };
  });
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
// script and revise call the model, so they are served by their own route
// files (pages/api/story/projects/[id]/script.js and revise.js) with a longer
// maxDuration; the handlers are exported so a job can run them too.
export const getScriptAction = async ({ userId, projectId }) => ({ script: await getScript({ userId, projectId }) });
export const writeScriptAction = async ({ userId, user, projectId }) => ({ script: await writeScript({ userId, projectId, user }) });
export const reviseScriptAction = async ({ userId, user, projectId, body = {} }) =>
  reviseScript({ userId, projectId, instruction: body.instruction, user });
export const updateSceneAction = async ({ userId, projectId, body = {} }) => {
  if (typeof body.sceneId !== 'string' || !body.sceneId) throw new ValidationError('Say which scene to change.', { field: 'sceneId' });
  return updateScene({ userId, projectId, sceneId: body.sceneId, patch: body.patch });
};

registerAction('script', { method: 'GET', handler: getScriptAction });
registerAction('script', { method: 'POST', handler: writeScriptAction });
registerAction('revise', { method: 'POST', handler: reviseScriptAction });
registerAction('scene', { method: 'PATCH', handler: updateSceneAction });
