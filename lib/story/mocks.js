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
