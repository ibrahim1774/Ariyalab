import { getPricing } from '../pricing.js';
import { storyDb } from './db.js';
import { ConflictError } from './errors.js';
import { getProject, assertNotExpired } from './projects.js';
import { registerAction } from './actions.js';
import { castFeeDue } from './cast.js';
import { shotsView } from './storyboard.js';
import { getAudio } from './audio.js';

/*
 * The price of "Looks good, design my video" in the simple maker: everything the plan pipeline starts, read only.
 *
 *   POST /api/story/projects/[id]/quote-plan {}
 *     -> { total, castFee, stills, lines:[{ key, label, credits, included }] }
 *
 * It only adds up numbers the charging code already works out, so it cannot drift from them:
 *   fee       castFeeDue (cast.js): the project fee while it is unpaid and the project has a cast to make; 0 when it is paid
 *             or when every scene has different people (that fee is charged with the clips instead)
 *   pictures  the still_credits (storyboard.js shotsView) of the shots generateStills would start by default; the first
 *             pictures of a shot are included, so before the storyboard exists this is 0
 *   voice     the narration's normal make price (audio.js getAudio), while it is not made; only for a narrated project
 *   music     the music's normal make price, while it is not made and music is on
 * included: true marks a part that costs nothing now (nothing to pay, or an included try), so the screen can list it.
 * Nothing here charges, holds or starts anything.
 */

// The statuses generateStills starts by default (storyboard.js STILL_STARTABLE without blocked, which needs a new description first).
const PICTURE_STARTABLE = ['draft', 'still_ready', 'failed', 'ready'];

async function hasScript(projectId) {
  const [row] = await storyDb().select('story_scripts', { project_id: projectId }, { order: '-version', limit: 1 });
  return Boolean(row && Array.isArray(row.scenes) && row.scenes.length);
}

export async function quotePlan({ userId, projectId }) {
  const project = await getProject({ userId, id: projectId });
  assertNotExpired(project);
  if (!(await hasScript(projectId))) {
    throw new ConflictError('Write the script first, then design your video.', { code: 'script_missing' });
  }
  const pricing = await getPricing();
  const castFee = await castFeeDue(project, pricing);
  const shots = await shotsView(projectId);
  const stills = shots
    .filter((s) => s.source !== 'footage' && !s.still_url && PICTURE_STARTABLE.includes(s.status))
    .reduce((n, s) => n + (Number(s.still_credits) || 0), 0);

  const lines = [
    { key: 'fee', label: 'Project fee', credits: castFee, included: castFee === 0 },
    { key: 'pictures', label: 'Storyboard pictures', credits: stills, included: stills === 0 },
  ];
  let audio = null;
  try {
    audio = await getAudio({ userId, projectId });
  } catch (err) {
    console.error('[story] quote-plan: audio view failed', err?.message || err);
  }
  if (audio) {
    const narration = audio.narration;
    if (audio.applicable?.narration && audio.applicable.narrationLines > 0 && narration.status !== 'ready' && narration.status !== 'pending') {
      const credits = Number(narration.credits) || 0;
      lines.push({ key: 'voice', label: 'Narration', credits, included: credits === 0 });
    }
    const music = audio.music;
    if (music.type === 'generated' && music.status !== 'ready' && music.status !== 'pending') {
      const credits = Number(music.credits) || 0;
      lines.push({ key: 'music', label: 'Music', credits, included: credits === 0 });
    }
  }
  return { total: lines.reduce((n, l) => n + l.credits, 0), castFee, stills, lines };
}

// POST /api/story/projects/[id]/quote-plan -> the quote above. 409 script_missing before a script exists.
registerAction('quote-plan', { method: 'POST', handler: async ({ userId, projectId }) => quotePlan({ userId, projectId }) });
