/*
 * Mock LLM responders for lib/story/* (STORY_MOCK=1). Importing this module
 * registers them with lib/providers/mock.js. Later story tasks add their own
 * responders here (one registerMock call each).
 *
 * story_script: returns a script that passes checkScriptRules for the brief's
 * seconds, mode and purpose. Tokens anywhere in the user message:
 *   [[mock:dash]]        the first attempt has a dash in a line (exercises the retry)
 *   [[mock:always-bad]]  every attempt has a dash (exercises remaining violations)
 *   [[mock:edit:<id>]]   revise changes only that scene's visual (default: the first scene)
 *   [[mock:add]]         revise appends one new scene with id ""
 *   [[mock:drop:<id>]]   revise removes that scene
 * On a retry the mock answers with the ids of the scenes it was shown (the
 * assistant turn), the way the real model is asked to.
 * There is one mention scene unless the purpose is 'story' or the brief has no offer.
 */

import { registerMock } from '../providers/mock.js';
import { ProviderError } from '../providers/errors.js';
import { parseTagged, sceneTarget, wordBudget } from './prompts/script.js';

export const MOCK_DASH = '[[mock:dash]]';
export const MOCK_ALWAYS_BAD = '[[mock:always-bad]]';
export const MOCK_ADD = '[[mock:add]]';

// Plain sentences that break no script rule. The first is the hook.
const SENTENCES = [
  'Nobody believed this would work, not even me.',
  'My family said I should quit and get a normal job.',
  'Every night I sat alone and wondered if they were right.',
  'Then one evening my phone lit up on the counter.',
  'Someone I had never met wanted what I made.',
  'The next week there were three more, then ten.',
  'My little sister started telling her friends about it.',
  'I stopped checking the clock and started enjoying the work.',
  'Dad came by one Sunday and just watched for a while.',
  'He did not say much, but he stayed for dinner.',
];
const MENTION_SENTENCE = 'My friend set it up for me and it just worked.';
const SPEAKERS = ['Maya', 'Leo'];
// The mention is the third sentence, which every length reaches whole.
const MENTION_AT = 2;

const parseJSON = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};
const textOf = (messages) => (messages || []).map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');

function sentencesFor(total, withMention) {
  const out = [];
  let count = 0;
  for (let i = 0; count < total; i += 1) {
    let s = SENTENCES[i % SENTENCES.length];
    if (i === MENTION_AT && withMention) s = MENTION_SENTENCE;
    const words = s.split(' ');
    const take = Math.min(words.length, total - count);
    const cut = words.slice(0, Math.max(take, 1)).join(' ');
    out.push(take < words.length ? `${cut.replace(/[.,]$/, '')}.` : cut);
    count += take;
  }
  return out;
}

function freshScript({ seconds = 30, mode = 'narrated', purpose = 'service', offer }) {
  const { min, max } = wordBudget(seconds, mode);
  const withMention = purpose !== 'story' && Boolean(offer);
  const sentences = sentencesFor(Math.round((min + max) / 2), withMention);
  const sceneCount = Math.min(sceneTarget(seconds), sentences.length);
  const mentionIndex = withMention ? MENTION_AT : -1;
  const scenes = Array.from({ length: sceneCount }, (_, i) => ({
    id: '',
    title: `Scene ${i + 1}`,
    visual: `Maya and Leo in the small shop, moment ${i + 1}.`,
    lines: [],
    mention: false,
  }));
  sentences.forEach((text, k) => {
    const scene = scenes[Math.floor((k * sceneCount) / sentences.length)];
    const speaker = mode === 'talking' ? SPEAKERS[k % 2] : 'narrator';
    scene.lines.push({ speaker, text });
    if (k === mentionIndex) scene.mention = true;
  });
  return scenes;
}

function revisedScript(scenes, request) {
  const copy = structuredClone(scenes);
  const target = /\[\[mock:edit:([^\]]+)\]\]/.exec(request)?.[1] || copy[0]?.id;
  const scene = copy.find((s) => s.id === target);
  if (scene) scene.visual = `${scene.visual} The light is warmer now.`;
  const drop = /\[\[mock:drop:([^\]]+)\]\]/.exec(request)?.[1];
  const dropAt = drop ? copy.findIndex((s) => s.id === drop) : -1;
  if (dropAt >= 0) copy.splice(dropAt, 1);
  if (request.includes(MOCK_ADD)) {
    copy.push({ id: '', title: 'Later', visual: 'Everyone laughs together in the shop.', lines: [], mention: false });
  }
  return copy.map((s) => ({ mention: false, ...s }));
}

function addDash(scenes) {
  const line = scenes.flatMap((s) => s.lines)[1] || scenes[0]?.lines[0];
  if (line) line.text = `${line.text.replace(/[.]$/, '')} — honestly.`;
  return scenes;
}

/** The story_script responder: ({ messages }) -> { scenes }. */
export function storyScriptMock({ messages = [] } = {}) {
  const first = textOf(messages.slice(0, 1));
  const all = textOf(messages);
  const brief = parseTagged(first, 'brief') || {};
  const current = parseTagged(first, 'current_script');
  const request = /<change_request>\n([\s\S]*?)\n<\/change_request>/.exec(first)?.[1] || '';
  const isRetry = messages.length > 1;

  let scenes = current?.scenes ? revisedScript(current.scenes, request) : freshScript(brief);
  if (all.includes(MOCK_ALWAYS_BAD) || (all.includes(MOCK_DASH) && !isRetry)) scenes = addDash(scenes);
  if (isRetry) {
    const shown = parseJSON(messages[1]?.content)?.scenes || [];
    scenes = scenes.map((scene, i) => ({ ...scene, id: shown[i]?.id ?? scene.id }));
  }
  return { scenes };
}

registerMock('story_script', storyScriptMock);

/*
 * story_cast: the characters of a script (lib/story/cast.js). The people are
 * the non narrator speakers in the script, in order of first appearance
 * (Maya and Leo when nobody but the narrator speaks). A [[mock:...]] token in
 * a scene is copied into the description of every character in that scene, so
 * a test can make one character's pictures fail:
 *   [[mock:fail]]   that character's picture jobs fail
 */
const CAST_LOOKS = [
  ['A young barber in her twenties with short dark hair, a warm smile, a grey apron and rolled up sleeves, easy to spot by her bright red scissors belt.', 'Warm and quick, mid twenties.'],
  ['A cheerful man in his thirties with a short beard, round glasses, a green knitted jumper and a tote bag full of coffee cups.', 'Friendly and relaxed, a little husky.'],
  ['An older woman with silver hair in a bun, a patterned cardigan and kind eyes, always carrying a small umbrella.', 'Calm and gentle, slow and clear.'],
  ['A tall teenager with curly hair, a yellow raincoat and bright white trainers, always grinning.', 'Bright and fast, young.'],
  ['A broad shouldered man in his fifties with a grey moustache, a checked shirt and a worn leather cap.', 'Deep and steady, unhurried.'],
];

export function storyCastMock({ messages = [] } = {}) {
  const script = parseTagged(textOf(messages.slice(0, 1)), 'script') || { scenes: [] };
  const scenes = Array.isArray(script.scenes) ? script.scenes : [];
  const names = [];
  for (const scene of scenes) {
    for (const line of scene.lines || []) {
      const speaker = String(line.speaker || '').trim();
      if (speaker && speaker.toLowerCase() !== 'narrator' && !names.includes(speaker)) names.push(speaker);
    }
  }
  const people = names.length ? names : ['Maya', 'Leo'];
  const characters = people.slice(0, 5).map((name, i) => {
    const [look, voice] = CAST_LOOKS[i % CAST_LOOKS.length];
    const tokens = new Set();
    for (const scene of scenes) {
      const text = JSON.stringify(scene);
      if (!text.includes(name)) continue;
      for (const token of text.match(/\[\[mock:[a-z-]+\]\]/g) || []) tokens.add(token);
    }
    return { name, description: [look, ...tokens].join(' '), voiceNote: voice };
  });
  return { characters };
}

registerMock('story_cast', storyCastMock);

/*
 * story_shots: the shot list of a script (lib/story/storyboard.js). One shot
 * per spoken line (a scene with no lines gets one silent shot). Everything is
 * derived from the scene alone, so an unchanged scene gives the same shots on
 * a rebuild and its pictures are kept. cast = cast names that speak in the
 * scene or appear in its visual. Seconds are the length spread over the shots.
 */
export function storyShotsMock({ messages = [] } = {}) {
  const brief = parseTagged(textOf(messages.slice(0, 1)), 'shot_brief') || {};
  const scenes = Array.isArray(brief.scenes) ? brief.scenes : [];
  const names = (brief.cast || []).map((c) => String(c.name || '')).filter(Boolean);
  const shots = [];
  for (const scene of scenes) {
    const lines = (scene.lines || []).length ? scene.lines : [{ speaker: 'narrator', text: '' }];
    const visual = String(scene.visual || '');
    const inScene = names.filter((n) => visual.includes(n) || lines.some((l) => l.speaker === n));
    lines.forEach((line, k) => {
      shots.push({
        sceneId: scene.id,
        description: `${visual} Shot ${k + 1} of ${lines.length}.`,
        line: line.text || '',
        cast: inScene,
        seconds: 0,
      });
    });
  }
  const total = Number(brief.seconds) || 30;
  shots.forEach((s, i) => {
    s.seconds = Math.min(6, Math.max(3, Math.floor(total / shots.length) + (i < total % shots.length ? 1 : 0)));
  });
  return { shots };
}

registerMock('story_shots', storyShotsMock);

/*
 * chatWithTools: the chat helper's tool loop (lib/story/chat.js). It acts like
 * the real loop in lib/providers/llm.js: it runs each tool through onToolCall
 * (a throw becomes an error result), and returns the input messages plus an
 * assistant tool_use turn, a user tool_result turn and a final assistant text.
 * Only the LAST user message is read, so tokens in the history never replay.
 *   [[mock:tool:<name> {json input}]]   call that tool (any number, in order)
 *   [[mock:say:<text>]]                 the final reply is exactly <text>
 *   [[mock:throw:<code>]]               after the tool tokens, throw ProviderError(<code>), the
 *                                       way the real loop fails (config, rate_limited, failed)
 * With no tool token the mock reads the project (get_project) and says where
 * the video stands.
 */
const lastUserText = (messages) => {
  const last = [...(messages || [])].reverse().find((m) => m.role === 'user');
  return typeof last?.content === 'string' ? last.content : textOf([last].filter(Boolean));
};

function mockReplyFor(calls) {
  if (!calls.length) return 'Mock reply: no changes made.';
  return calls
    .map(({ name, result }) => {
      if (result?.needsConfirm) return `${result.quote.label} costs ${result.quote.credits} credits. Press the button below to start it.`;
      if (result?.ok === false) return result.message || 'That change did not work.';
      if (name === 'get_project') {
        const s = result?.summary;
        return s ? `Your video has ${s.script?.scenes?.length || 0} scenes, ${s.cast.length} characters and ${s.shots.length} shots.` : 'I read your video.';
      }
      return `Done: ${name.replace(/_/g, ' ')}.`;
    })
    .join(' ');
}

export async function storyChatMock({ messages = [], onToolCall } = {}) {
  const text = lastUserText(messages);
  const wanted = [];
  for (const m of text.matchAll(/\[\[mock:tool:([a-z_]+)(?:\s+(\{.*?\}))?\]\]/g)) wanted.push({ name: m[1], input: parseJSON(m[2] || '{}') || {} });
  const throwCode = /\[\[mock:throw:([a-z_]+)\]\]/.exec(text)?.[1];
  if (!wanted.length && !text.includes('[[mock:say:') && !throwCode) wanted.push({ name: 'get_project', input: {} });

  const turns = [];
  const calls = [];
  if (wanted.length) {
    const uses = wanted.map((w, i) => ({ type: 'tool_use', id: `mock_tool_${i + 1}`, name: w.name, input: w.input }));
    const results = [];
    for (const use of uses) {
      let result;
      try {
        result = await onToolCall({ name: use.name, input: use.input, id: use.id });
        results.push({ type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(result ?? null) });
      } catch (err) {
        result = { ok: false, message: String(err?.message || err) };
        results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: result.message });
      }
      calls.push({ name: use.name, result });
    }
    turns.push({ role: 'assistant', content: uses }, { role: 'user', content: results });
  }
  if (throwCode) throw new ProviderError(throwCode, undefined, { provider: 'mock' });
  const say = /\[\[mock:say:([^\]]*)\]\]/.exec(text)?.[1];
  turns.push({ role: 'assistant', content: [{ type: 'text', text: say ?? mockReplyFor(calls) }] });
  return { messages: [...messages, ...turns] };
}

registerMock('chatWithTools', storyChatMock);
