import { createHash } from 'node:crypto';
import { speakerOfShot } from './speakers.js';

/*
 * What a finished clip was made from besides its quality, description, still and seconds: the project's mode (ambience only, or
 * a character speaks), the same-characters setting, the picture and sheet of every character in the shot, and in talking mode
 * the spoken line and who says it. clipJobs record this when the clip is started (shots.js startClips) and clipMatchesAgain
 * (storyboard.js) computes it again from the current data with this one function, so the two cannot drift.
 * -> a short hex string.
 */
export function clipMadeFromSignature({ project, shot, castRows = [], scenes = [], allShots = [] }) {
  const consistent = project.consistent_cast !== false;
  const castById = new Map(castRows.map((c) => [c.id, c]));
  const people = consistent
    ? (shot.cast_ids || []).map((id) => {
      const c = castById.get(id);
      return [id, c?.image_key || c?.image_url || null, c?.sheet?.key || c?.sheet?.url || null];
    })
    : [];
  const talking = project.mode === 'talking';
  const speaker = talking ? speakerOfShot(scenes, shot, allShots) : null;
  const made = { mode: project.mode ?? null, consistent, people, line: talking ? (shot.line ?? null) : null, speaker: speaker ? [speaker.kind, speaker.name ?? null] : null };
  return createHash('sha1').update(JSON.stringify(made)).digest('hex').slice(0, 16);
}
