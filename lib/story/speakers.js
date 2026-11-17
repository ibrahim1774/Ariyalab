import { ValidationError } from './errors.js';

/*
 * Who says a shot's line. A shot keeps the line it was planned with (story_shots.line, copied word for word from its
 * scene in the script); the speaker is the speaker of that script line, so it is read from the scene and cannot drift
 * from the script. Narrator lines are read by the narration voice laid over the video (lib/story/audio.js) and are never
 * sent to a clip or spoken by a character. Character lines (a talking video) are spoken inside the clip.
 *
 *   speakerOfShot(scenes, shot) -> { kind: 'none' | 'narrator' | 'character' | 'unknown', name? }
 *     none       the shot has no line
 *     narrator   the line is a narrator line
 *     character  the line is a character's; name is the speaker as the script spells it
 *     unknown    the line is in no line of its scene (the script changed, or the plan did not copy it), or its speaker is empty
 */

/**
 * Text as compared between a script line and a shot's line: quotes, apostrophes and dashes made plain, punctuation dropped,
 * whitespace collapsed, lower case. Used on both sides, so a curly apostrophe or a dropped full stop still matches.
 */
export const normText = (text) => String(text ?? '')
  .toLowerCase()
  .replace(/[\u2018\u2019\u201a\u201b\u02bc`\u00b4]/g, "'")
  .replace(/[\u201c\u201d\u201e\u201f]/g, '"')
  .replace(/[\u2010-\u2015\u2212]/g, '-')
  .replace(/[^\p{L}\p{N}]+/gu, ' ')
  .trim();

const sceneOf = (scenes, shot) => (Array.isArray(scenes) ? scenes : []).find((s) => s.id === (shot?.scene_id ?? shot?.sceneId));

/** The text a shot shows is the whole of a script line, or a piece of it (a long line may span two shots). */
export const sameOrFragment = (lineText, shotText) => {
  const line = normText(lineText);
  const shot = normText(shotText);
  // Whole words: "no" is not a piece of "i know".
  return Boolean(shot) && (line === shot || ` ${line} `.includes(` ${shot} `));
};

/**
 * Which line of its scene a shot carries: the stored index (story_shots.line_index) when it is there and the line it names
 * is the shot's text; for rows planned before the index existed, the n-th occurrence of the text among the scene's shots
 * (allShots, in order) is the n-th script line with that text. -> a line index, or -1
 */
export function lineIndexOfShot(scenes, shot, allShots = []) {
  const scene = sceneOf(scenes, shot);
  const lines = scene?.lines || [];
  if (!normText(shot?.line)) return -1;
  if (Number.isInteger(shot.line_index)) {
    return lines[shot.line_index] && sameOrFragment(lines[shot.line_index].text, shot.line) ? shot.line_index : -1;
  }
  const want = normText(shot.line);
  const exact = lines.map((l, i) => (normText(l?.text) === want ? i : -1)).filter((i) => i >= 0);
  if (!exact.length) {
    const part = lines.map((l, i) => (sameOrFragment(l?.text, shot.line) ? i : -1)).filter((i) => i >= 0);
    return part.length === 1 ? part[0] : -1;
  }
  const before = (Array.isArray(allShots) ? allShots : [])
    .filter((o) => o.id !== shot.id && sceneOf(scenes, o) === scene && normText(o.line) === want && Number(o.ord) < Number(shot.ord)).length;
  return exact[Math.min(before, exact.length - 1)];
}

export function speakerOfShot(scenes, shot, allShots = []) {
  if (!normText(shot?.line)) return { kind: 'none' };
  const index = lineIndexOfShot(scenes, shot, allShots);
  const line = sceneOf(scenes, shot)?.lines?.[index];
  const speaker = String(line?.speaker ?? '').trim();
  if (index < 0 || !line || !speaker) return { kind: 'unknown' };
  if (speaker.toLowerCase() === 'narrator') return { kind: 'narrator', lineIndex: index };
  return { kind: 'character', name: speaker, lineIndex: index };
}

/**
 * The cast row a character speaker is, by name, with `row: null` when they are in the script but not in the cast (the
 * clip names them without a voice note, and the shot says they have no picture). Null only when there is no speaker.
 */
export function resolveSpeaker({ speaker, cast = [] }) {
  const name = String(speaker?.name ?? '').trim();
  if (speaker?.kind !== 'character' || !name) return null;
  const row = cast.find((c) => String(c.name ?? '').trim().toLowerCase() === name.toLowerCase()) || null;
  return { name, row };
}

/** Is a character speaker one the project's cast has no row for (a plain warning, not an error)? */
export const isUncast = ({ speaker, cast = [], consistentCast = true }) => {
  const who = resolveSpeaker({ speaker, cast });
  return Boolean(who && !who.row && consistentCast !== false && cast.length > 0);
};

export const uncastWarning = (name) => ({ code: 'speaker_not_in_cast', message: `${name} has no character picture, so their look and voice may change.` });

export const UNRESOLVED_SPEAKER = 'We could not tell who says a line in this shot. Ask the chat to fix who says this line.';

export const AMBIENCE_ONLY = 'Sound: ambience and sound effects only. Nobody speaks. No music.';

/**
 * The sound sentence of a clip prompt.
 *   a character line (talking mode)   Name says, in a <voice note> voice: "line" ... Nobody else speaks. No music.
 *   anything else                     ambience and sound effects only, nobody speaks, no music
 * element: the Kling element of the speaker in this shot, when there is one (the prompt refers to it as @name).
 * Throws ValidationError(speaker_unresolved) for a character line whose speaker cannot be resolved.
 */
export function clipSound({ mode, speaker, cast = [], consistentCast = true, line, elements = [], shotId }) {
  if (mode !== 'talking' || speaker?.kind === 'narrator' || speaker?.kind === 'none') return AMBIENCE_ONLY;
  const who = resolveSpeaker({ speaker, cast });
  if (!who) throw new ValidationError(UNRESOLVED_SPEAKER, { field: 'line', code: 'speaker_unresolved', ...(shotId ? { shotId } : {}) });
  const element = elements.find((e) => String(e.description || '').toLowerCase().startsWith(`${who.name.toLowerCase()}:`));
  const note = String(who.row?.voice_note ?? '').replace(/[\s.,;:]+$/, '').trim();
  return `${element ? `@${element.name}` : who.name} says${note ? `, in a ${note} voice` : ''}: "${String(line).trim()}" Nobody else speaks. No music.`;
}
