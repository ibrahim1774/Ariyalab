/*
 * Story flow: what every still and clip prompt of a shot carries besides the shot's own description, so places, clothes,
 * props and time of day stay the same from shot to shot and scene to scene.
 *
 *   Setting:        the scene's stored setting line (story_shots.setting, the same on every shot of a scene)
 *   Look, <name>:   a short line from each cast member's written description, for the people in this shot
 *   Just before this: the previous shot's description, in story order across scene borders (none for the first shot)
 *
 * A prompt has a size limit (PROVIDER_CONFIG, 2500 characters for Kling and Gemini Omni). When the context does not fit,
 * the context is cut, never the shot's own description or the spoken line: the previous-shot line goes first, then the
 * look lines (last first), then the setting is shortened. A project planned before settings existed has no setting line
 * and its prompts carry only the look lines and the previous shot.
 */

import { isMock } from '../providers/mock.js';

export const SETTING_MAX = 400;
export const LOOK_MAX = 160;
export const PREVIOUS_MAX = 300;
/** The most characters a prompt (still or clip) may have when no provider limit is known. */
export const PROMPT_MAX = 2500;
const MIN_SETTING_KEPT = 40;

const oneLine = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

/** At most max characters, cut at a word end. */
export function shorten(text, max) {
  const t = [...oneLine(text)];
  if (t.length <= max) return t.join('');
  const cut = t.slice(0, max).join('');
  const at = cut.lastIndexOf(' ');
  return (at > cut.length * 0.5 ? cut.slice(0, at) : cut).replace(/[\s,;:.-]+$/, '');
}

/** The first sentence or two of a written description, short enough to sit in a prompt. */
export function lookLine(name, description) {
  const look = shorten(description, LOOK_MAX);
  return look ? `Look, ${oneLine(name)}: ${look}.` : '';
}

/**
 * The context of one shot. shot: the story_shots row; allShots: every shot of the project (any order);
 * castById: Map of cast rows; consistentCast false (different people in every scene) gives no look lines.
 * -> { setting, looks: [line], previous }
 */
export function flowOf({ shot, allShots = [], castById = new Map(), consistentCast = true }) {
  const ordered = [...allShots].sort((a, b) => Number(a.ord) - Number(b.ord));
  const at = ordered.findIndex((s) => s.id === shot.id);
  const before = at > 0 ? ordered[at - 1] : null;
  const looks = [];
  for (const id of consistentCast === false ? [] : shot.cast_ids || []) {
    const c = castById.get(id);
    const line = c ? lookLine(c.name, c.description) : '';
    if (line) looks.push(line);
  }
  const setting = shorten(shot.setting, SETTING_MAX);
  // Mock mode only: a [[mock:...]] marker (the mock providers read them from a shot's own prompt) does not travel to the next shot.
  const was = String(before?.description ?? '');
  const previous = shorten(isMock() ? was.replace(/\[\[mock:[^\]]*\]\]/g, ' ') : was, PREVIOUS_MAX);
  return { setting: setting ? `Setting: ${setting}${/[.!?]$/.test(setting) ? '' : '.'}` : '', looks, previous: previous ? `Just before this: ${previous}${/[.!?]$/.test(previous) ? '' : '.'}` : '' };
}

/**
 * before + context + after, joined by spaces, within max characters. before and after (the shot's description, the spoken
 * line, the style and the rest) are never cut; only the context lines are.
 */
export function fitPrompt({ before = [], after = [], flow = {}, max = PROMPT_MAX }) {
  const join = (lines) => [...before, ...lines, ...after].filter(Boolean).join(' ');
  let looks = [...(flow.looks || [])];
  let previous = flow.previous || '';
  let setting = flow.setting || '';
  const lines = () => [setting, ...looks, previous].filter(Boolean);
  if (join(lines()).length > max) previous = '';
  while (join(lines()).length > max && looks.length) looks = looks.slice(0, -1);
  if (join(lines()).length > max && setting) {
    const room = max - join([]).length - 1;
    setting = room >= MIN_SETTING_KEPT ? shorten(setting, room) : '';
  }
  return join(lines());
}
