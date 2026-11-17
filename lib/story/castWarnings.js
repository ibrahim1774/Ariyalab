/*
 * Characters a shot names but cannot fully use, said in plain words (the shot view's `warnings`), and the cast names found
 * in a shot description. Nothing here is an error: the picture or clip still gets made.
 */
import { MAX_CAST_REFS } from './prompts/shot.js';
import { PROVIDER_CONFIG, QUALITY_MAP } from '../providers/config.js';

const pictureOf = (c) => c?.sheet?.url || c?.image_url || null;
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The ids of the cast whose names appear in the text, in the order they appear: the name exactly as the cast has it (same
 * capitals), as a whole word ("Maya's" counts, "Leonard" is not "Leo", "may" is not "May"). Add-only use: an edit can add a
 * character it names, it never removes one.
 */
export function castIdsInText(text, cast = []) {
  const found = [];
  for (const c of cast) {
    const name = String(c?.name ?? '').trim();
    if (!name) continue;
    const m = new RegExp(`(^|[^\\p{L}\\p{N}])${escape(name)}(?![\\p{L}\\p{N}])`, 'u').exec(String(text ?? ''));
    if (m) found.push({ id: c.id, at: m.index });
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.id);
}

/** -> [{ code, message }] for the characters of this shot that are left without a picture, out of the picture, or out of the clip. */
// making: ids of characters whose pictures or sheet are being drawn right now (no warning for a normal wait).
export function castWarnings({ shot, cast = [], consistentCast = true, quality, making = new Set() }) {
  if (consistentCast === false || shot?.source === 'footage') return [];
  const byId = new Map(cast.map((c) => [c.id, c]));
  const people = (shot.cast_ids || []).map((id) => byId.get(id)).filter(Boolean);
  const out = [];
  const withPicture = [];
  for (const c of people) {
    if (pictureOf(c)) withPicture.push(c);
    else if (making.has(c.id) || c.status === 'pending' || c.status === 'draft') continue;
    else out.push({ code: 'character_no_picture', message: `${c.name} has no picture yet, so ${c.name} may look different in this shot.` });
  }
  for (const c of withPicture.slice(MAX_CAST_REFS)) {
    out.push({ code: 'character_left_out_of_picture', message: `${c.name} is left out of this picture: it can use up to ${MAX_CAST_REFS} characters.` });
  }
  if (QUALITY_MAP[quality ?? shot?.quality]?.family === 'kling') {
    const lim = PROVIDER_CONFIG.kling;
    let kept = 0;
    for (const c of withPicture) {
      const n = new Set([c.image_url, c.sheet?.url].filter(Boolean)).size;
      if (n < lim.minElementImages) {
        if (making.has(c.id)) continue;
        out.push({ code: 'character_not_in_clip', message: `${c.name} has no character sheet yet, so ${c.name} is not held steady in this clip.` });
      } else if (kept >= lim.maxElements) {
        out.push({ code: 'character_left_out_of_clip', message: `${c.name} is left out of this clip: it can hold up to ${lim.maxElements} characters steady.` });
      } else kept += 1;
    }
  }
  return out;
}
