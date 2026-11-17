import { creditsForShot, getPricing } from '../pricing.js';
import { StoryError } from './errors.js';
import { storyDb } from './db.js';
import { presentCast } from './cast.js';
import { clipView } from './shots.js';
import { clipMatchesAgain } from './storyboard.js';
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
export async function styleRedo(project, patched = {}) {
  // Priced on the project as it will be after the same update: the new quality for the clips, the new cast setting for the characters.
  const next = { ...project, ...patched };
  const pricing = await getPricing();
  const shots = (await clipView(project.id, project)).filter((s) => s.source !== 'footage');
  const clips = shots.filter((s) => s.clip_url);
  const pictures = shots.filter((s) => s.still_url || s.clip_url);
  const sum = (list, f) => list.reduce((n, x) => n + (Number.isInteger(f(x)) ? f(x) : 0), 0);
  const rows = await storyDb().select('story_cast', { project_id: project.id });
  // Drawn pictures or a drawn sheet. A character using the customer's own photo has neither (the photo stays as it is).
  const drawn = rows.filter((c) => !c.asset_id && (c.image_url || c.sheet?.url || (Array.isArray(c.candidates) && c.candidates.length)));
  const same = next.consistent_cast !== false;
  const characters = presentCast(drawn, pricing);
  const out = {
    characters: { count: characters.length, credits: same ? sum(characters, (c) => c.regen_credits) : 0 },
    pictures: { count: pictures.length, credits: sum(pictures, (s) => s.still_credits) },
    clips: { count: clips.length, credits: sum(clips, (s) => creditsForShot(pricing, next.quality, s.seconds)) },
  };
  const render = await renderLine(project);
  const total = out.characters.credits + out.pictures.credits + out.clips.credits;
  return {
    ...out,
    render,
    total,
    made: out.characters.count + out.pictures.count + out.clips.count > 0,
    // Old character pictures are only cleared (nothing is remade now): same-people is off and nothing else was made.
    only_cleared: !same && out.characters.count > 0 && !out.pictures.count && !out.clips.count,
    lines: [
      { key: 'characters', label: 'Characters', count: out.characters.count, credits: out.characters.credits },
      { key: 'pictures', label: 'Storyboard pictures', count: out.pictures.count, credits: out.pictures.credits },
      { key: 'clips', label: 'Clips', count: out.clips.count, credits: out.clips.credits },
    ],
  };
}

/** The finished video made again, as its own line. A price that cannot be read is an error, never 0. */
async function renderLine(project) {
  try {
    const price = await renderPrice(project);
    return { credits: Number(price.render ?? price.credits) || 0 };
  } catch (err) {
    console.error('[story] could not price the finished video', project.id, err?.message);
    throw new StoryError('We could not work out the price. Try again.', { status: 503, code: 'price_unavailable' });
  }
}

/**
 * What a quality change alone makes again: the finished clips that will not be current again, at the new quality's price (the
 * customer's own footage stays).
 * -> { count, credits, total, lines, render }
 */
export async function qualityRedo(project, quality) {
  const pricing = await getPricing();
  const made = (await clipView(project.id, project)).filter((s) => s.source !== 'footage' && s.clip_url);
  // A clip made at this quality from the same description and still is current again (storyboard.js clipMatchesAgain): Generate
  // charges nothing for it, so it is not in the total. One that went out of date for another reason is still remade.
  const clips = [];
  for (const shot of made) {
    const back = await clipMatchesAgain(project.id, shot, quality);
    if (!back || back.stale) clips.push(shot);
  }
  const credits = clips.reduce((n, s) => n + creditsForShot(pricing, quality, s.seconds), 0);
  return { count: clips.length, credits, total: credits, lines: [{ key: 'clips', label: 'Clips', count: clips.length, credits }], render: await renderLine(project) };
}
