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

const squash = (text) => String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

/** The script line a shot's text is, in its scene. An exact match first, then a line that holds the shot's text (or the reverse). */
export function lineOfShot(scenes, shot) {
  const wanted = squash(shot?.line);
  if (!wanted) return null;
  const scene = (Array.isArray(scenes) ? scenes : []).find((s) => s.id === (shot.scene_id ?? shot.sceneId));
  const lines = (scene?.lines || []).filter((l) => squash(l?.text));
  return lines.find((l) => squash(l.text) === wanted)
    || lines.find((l) => squash(l.text).includes(wanted) || wanted.includes(squash(l.text)))
    || null;
}

export function speakerOfShot(scenes, shot) {
  if (!squash(shot?.line)) return { kind: 'none' };
  const line = lineOfShot(scenes, shot);
  const speaker = String(line?.speaker ?? '').trim();
  if (!line || !speaker) return { kind: 'unknown' };
  if (speaker.toLowerCase() === 'narrator') return { kind: 'narrator' };
  return { kind: 'character', name: speaker };
}

/**
 * The cast row a character speaker is, by name. Null when the project's cast has rows and the speaker is not one of
 * them; { row: null } when there is nothing to check against (different people in every scene, or no cast made yet),
 * so only a speaker with no name at all is unresolved there.
 */
export function resolveSpeaker({ speaker, cast = [], consistentCast = true }) {
  const name = String(speaker?.name ?? '').trim();
  if (speaker?.kind !== 'character' || !name) return null;
  const row = cast.find((c) => String(c.name ?? '').trim().toLowerCase() === name.toLowerCase()) || null;
  if (row) return { name, row };
  return consistentCast === false || !cast.length ? { name, row: null } : null;
}

export const UNRESOLVED_SPEAKER = 'We could not tell who says the line in this shot. Rebuild the storyboard, or check the speaker names in the script.';

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
  const who = resolveSpeaker({ speaker, cast, consistentCast });
  if (!who) throw new ValidationError(UNRESOLVED_SPEAKER, { field: 'line', code: 'speaker_unresolved', ...(shotId ? { shotId } : {}) });
  const element = elements.find((e) => String(e.description || '').toLowerCase().startsWith(`${who.name.toLowerCase()}:`));
  const note = String(who.row?.voice_note ?? '').replace(/[\s.,;:]+$/, '').trim();
  return `${element ? `@${element.name}` : who.name} says${note ? `, in a ${note} voice` : ''}: "${String(line).trim()}" Nobody else speaks. No music.`;
}
