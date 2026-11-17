import { getPricing } from '../pricing.js';
import { storyDb } from './db.js';
import { presentCast } from './cast.js';
import { clipView } from './shots.js';
import { renderPrice } from './render.js';

/*
 * What a change of art style makes again, each part priced by the code that charges it (nothing here charges):
 *   characters  a drawn character that does not use the customer's own photo: its regeneration price (cast.js regen_credits, 0
 *               while the included ones last). On a different-people video they are cleared too but only drawn again if the
 *               customer later switches back, so their count is shown and their price is 0.
 *   pictures    a shot with a picture or a clip: its picture price (storyboard.js still_credits; a delivered picture costs a re-roll)
 *   clips       a shot with a finished clip: its clip price now (shots.js clip_price)
 *   render      the finished video made again: renderPrice (own line, never inside total); credits 0 while an included render is left
 * total = characters + pictures + clips: what the customer is charged, step by step, if nothing else changes.
 */
export async function styleRedo(project) {
  const shots = (await clipView(project.id, project)).filter((s) => s.source !== 'footage');
  const clips = shots.filter((s) => s.clip_url);
  const pictures = shots.filter((s) => s.still_url || s.clip_url);
  const sum = (list, f) => list.reduce((n, x) => n + (Number.isInteger(f(x)) ? f(x) : 0), 0);
  const rows = await storyDb().select('story_cast', { project_id: project.id });
  const drawn = rows.filter((c) => !c.asset_id && (c.image_url || (Array.isArray(c.candidates) && c.candidates.length)));
  const same = project.consistent_cast !== false;
  const characters = same ? presentCast(drawn, await getPricing()) : drawn;
  const out = {
    characters: { count: characters.length, credits: same ? sum(characters, (c) => c.regen_credits) : 0 },
    pictures: { count: pictures.length, credits: sum(pictures, (s) => s.still_credits) },
    clips: { count: clips.length, credits: sum(clips, (s) => s.clip_price) },
  };
  const price = await renderPrice(project).catch(() => ({ credits: 0 }));
  const render = { credits: Number(price.render ?? price.credits) || 0 };
  const total = out.characters.credits + out.pictures.credits + out.clips.credits;
  return {
    ...out,
    render,
    total,
    made: out.characters.count + out.pictures.count + out.clips.count > 0,
    lines: [
      { key: 'characters', label: 'Characters', count: out.characters.count, credits: out.characters.credits },
      { key: 'pictures', label: 'Storyboard pictures', count: out.pictures.count, credits: out.pictures.credits },
      { key: 'clips', label: 'Clips', count: out.clips.count, credits: out.clips.credits },
    ],
  };
}
