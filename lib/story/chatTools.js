import { getBalance, InsufficientCreditsError } from '../credits.js';
import { ModerationError } from '../moderation.js';
import { getPricing, quoteProject } from '../pricing.js';
import { qualityPatch } from '../qualityInfo.js';
import { ProviderError } from '../providers/errors.js';
import { storyDb } from './db.js';
import { StoryError, ValidationError } from './errors.js';
import { assertNoShotBeingMade, getProject, updateProject, MAX_SECONDS, MIN_SECONDS, MODES, QUALITIES, STYLES } from './projects.js';
import { STYLES as STYLE_PRESETS } from './prompts/styles.js';
import { assertNotDrafting, getScript, reviseScript, updateScene } from './script.js';
import { assertAllowed, releaseAllowance } from './limits.js';
import { enqueue } from './runner.js';
import { DRAFT_WORKER_PATH, kickWorker } from './workers.js';
import { pickCast, presentCast, regenerateCharacter } from './cast.js';
import { generateStills, listShots, updateShot } from './storyboard.js';
import { clipView, priceGeneration, quoteGeneration, rerollShot, startGeneration } from './shots.js';

const MAKING = ['still_pending', 'queued', 'generating'];

/*
 * The project tools the chat helper's model can call (lib/story/chat.js), in
 * the shape Task 26's MCP server reuses: CHAT_TOOLS are Anthropic tool
 * definitions ({ name, description, input_schema }) and runTool runs one.
 *
 *   runTool({ userId, user?, chatProjectId?, name, input, chatCounted? }) -> result
 *
 * Every tool takes project_id (optional when chatProjectId is given). The
 * project is resolved through getProject({ userId, id }), the same owner check
 * the routes use, so another user's project is { ok:false, error:'not_found' }.
 * In a chat (chatProjectId set) a project_id that is not the chat's project is
 * refused with 'wrong_project', even when the customer owns it.
 *
 * runTool never throws. A result is either
 *   { ok: true, ...data }                         data per tool, see below
 *   { ok: true, needsConfirm: true, quote, confirm }
 *       a priced action that was NOT done. quote { label, credits } uses the
 *       server's own price field; confirm { action, method, body } is the
 *       normal project route the screen calls when the customer presses the
 *       button (body carries expected_credits, so a price that moved is a 409
 *       quote_changed and nothing is charged).
 *   { ok: false, error, message }                 message is safe to show
 * and data may carry changed: 'script' | 'cast' | 'shots' | 'project' when
 * the tool changed something the screen should reload.
 *
 * Money and time rule (round 3): no tool spends credits and no tool starts
 * provider work. Every start (regenerate_character, make_picture, remake_clip,
 * get_quote's Generate) is a confirm card, included ones at 0 credits, and runs
 * only when pressed, through runConfirm on /api/story/chat/confirm (maxDuration
 * 25). Task 26's MCP server reuses runTool, so the same rule holds there: a
 * card runs only through a route of 25 s or less.
 */

// ---------------------------------------------------------------- definitions

const PROJECT_ID = { type: 'string', description: 'The video project id. Leave it out to use the project this chat belongs to.' };
const schema = (properties = {}, required = []) => ({
  type: 'object',
  properties: { project_id: PROJECT_ID, ...properties },
  required,
  additionalProperties: false,
});

export const CHAT_TOOLS = Object.freeze([
  {
    name: 'get_project',
    description: 'Reads the video project: the brief, the script scenes with their ids, the characters with the price of new pictures, the shots, the style, the length and the options. Call it when you need ids or the latest state.',
    input_schema: schema(),
  },
  {
    name: 'revise_script',
    description: 'Rewrites the script to follow a change request in plain words, for changes that touch the story or several scenes ("make the opening funnier"). Scenes the request does not touch stay as they are. No credits.',
    input_schema: schema({ instruction: { type: 'string', description: 'The change, in the customer\'s words. At most 1000 characters.' } }, ['instruction']),
  },
  {
    name: 'update_scene',
    description: 'Changes one scene directly: its title, what is seen (visual), its lines, or moves the one offer mention to it. Use it for exact edits to a single scene. lines replaces all the scene\'s lines. No credits.',
    input_schema: schema({
      scene_id: { type: 'string', description: 'The scene id, like s2.' },
      patch: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          visual: { type: 'string' },
          lines: {
            type: 'array',
            items: {
              type: 'object',
              properties: { speaker: { type: 'string', description: '"narrator" or a character\'s first name.' }, text: { type: 'string' } },
              required: ['speaker', 'text'],
              additionalProperties: false,
            },
          },
          mention: { type: 'boolean', description: 'true moves the one offer mention to this scene.' },
        },
        additionalProperties: false,
      },
    }, ['scene_id', 'patch']),
  },
  {
    name: 'regenerate_character',
    description: 'Makes new pictures of one character, optionally shaped by a short note ("give her a red cap"), or tries a failed set again. Each character has a few included regenerations. Nothing starts here: the customer gets a button to start it, showing the price (or that it is included).',
    input_schema: schema({
      cast_id: { type: 'string', description: 'The character id from get_project.' },
      note: { type: 'string', description: 'What to change in the look, in a few words.' },
      retry: { type: 'boolean', description: 'true to try the last failed pictures again as they were. A failed character with no note is tried again too.' },
    }, ['cast_id']),
  },
  {
    name: 'update_shot',
    description: 'Changes one storyboard shot: its description (what the picture shows, which clears the picture so it is made again) or its quality. No credits; making the new picture is done on the Storyboard step.',
    input_schema: schema({
      shot_id: { type: 'string', description: 'The shot id from get_project.' },
      description: { type: 'string' },
      quality: { type: 'string', enum: [...QUALITIES] },
    }, ['shot_id']),
  },
  {
    name: 'set_style',
    description: 'Sets the art style of the video. Use style "custom" with style_custom for the customer\'s own description. No credits; pictures already made keep their look until they are made again.',
    input_schema: schema({
      style: { type: 'string', enum: [...STYLES] },
      style_custom: { type: 'string', description: 'Only with style "custom": the look in plain words, at most 300 characters.' },
    }, ['style']),
  },
  {
    name: 'set_length',
    description: `Sets the length of the video in seconds (${MIN_SECONDS} to ${MAX_SECONDS}). No credits; the shot list is rebuilt on the Storyboard step.`,
    input_schema: schema({ seconds: { type: 'integer', minimum: MIN_SECONDS, maximum: MAX_SECONDS } }, ['seconds']),
  },
  {
    name: 'get_quote',
    description: 'Reads what making the video clips would cost now (the project fee if it is not paid yet, plus each shot by length and quality) and the customer\'s balance. Charges nothing. When there are clips to make, the customer gets a button to start them at that price.',
    input_schema: schema({ shot_ids: { type: 'array', items: { type: 'string' }, description: 'Only these shots. Leave it out for every shot that wants a clip.' } }),
  },
  {
    name: 'make_picture',
    description: 'Makes the storyboard picture of one shot (after its description changed, or to get a new one). Nothing starts here: the customer gets a button to start it, showing the price (or that it is included).',
    input_schema: schema({ shot_id: { type: 'string', description: 'The shot id from get_project.' } }, ['shot_id']),
  },
  {
    name: 'remake_clip',
    description: 'Makes the video clip of one finished shot again. Nothing starts here: the customer gets a button to start it, showing the price (or that it is included). A shot whose clip is out of date is made on the Generate step instead (get_quote).',
    input_schema: schema({ shot_id: { type: 'string', description: 'The shot id from get_project.' } }, ['shot_id']),
  },
  {
    name: 'set_quality',
    description: 'Sets the video quality: economy (the card Budget), standard (the card Standard), pro_narrated (the card Pro) or pro_talking (the card Pro Max). Every level makes sound with the video; the quality does not change who speaks (that is set_mode). Shots that have no clip yet follow the new quality; clips already made keep theirs. No credits: it returns the new price of the video, and nothing is charged.',
    input_schema: schema({ quality: { type: 'string', enum: [...QUALITIES], description: 'economy, standard, pro_narrated or pro_talking.' } }, ['quality']),
  },
  {
    name: 'pick_character',
    description: 'Picks one of the three looks (option 1, 2 or 3) for a character, by the character\'s id or first name. No credits. Use it when the customer prefers another look than the one picked for them.',
    input_schema: schema({
      cast_id: { type: 'string', description: 'The character id from get_project. Use this or name.' },
      name: { type: 'string', description: 'The character\'s first name, when you have no id.' },
      option: { type: 'integer', minimum: 1, maximum: 3, description: 'Which of the three pictures, counting from 1.' },
    }, ['option']),
  },
  {
    name: 'set_consistent_cast',
    description: 'true keeps the same characters in every scene. false is for a video where each scene shows different people: no characters are used and each shot is pictured on its own. Shots that already have a picture or a clip with a character in them are marked as out of date. No credits. When clips are already made it only returns a button that says how many clips would need making again and what that costs; the change happens when the customer presses it.',
    input_schema: schema({ consistent_cast: { type: 'boolean' } }, ['consistent_cast']),
  },
  {
    name: 'set_mode',
    description: 'Sets how the story is told: "narrated" is a narrator tells the story, "talking" is the characters speak. Either way every clip has its own sound, and narrator lines are read by one narrator voice over the video. Nothing changes here: it returns a button that says the script will be rewritten for the new style (counted like any script rewrite), and how many finished clips would need making again with what that costs. The change happens when the customer presses it. No credits.',
    input_schema: schema({ mode: { type: 'string', enum: [...MODES], description: 'narrated (a narrator tells the story) or talking (the characters speak).' } }, ['mode']),
  },
  {
    name: 'make_scene',
    description: 'Makes the video clips of one scene (scene 1 is the first scene of the script). Nothing starts here: the customer gets a button to start it, showing the price of that scene (the project fee is in the first one). The shots need their pictures first.',
    input_schema: schema({ scene_number: { type: 'integer', minimum: 1, description: 'The scene number, counting from 1 in script order.' } }, ['scene_number']),
  },
]);

const MODE_WORDS = { narrated: 'A narrator tells the story', talking: 'The characters speak' };
const MODE_REWRITE = { narrated: 'This rewrites your script so a narrator tells the story', talking: 'This rewrites your script so the characters speak' };
const MODE_INSTRUCTION = {
  narrated: 'Rewrite the script so a narrator tells the story: every line is spoken by the narrator and the characters do not speak. Keep the same story, scenes and offer mention.',
  talking: 'Rewrite the script so the characters speak: give the story\'s lines to the characters by name, in short back and forth lines. Keep the same story, scenes and offer mention.',
};

/**
 * The confirm of set_mode: queues the rewrite on the drafting job (a worker with the long limit; this route has 25 s and no model
 * call belongs in it). The job rewrites the script for the new style and sets the mode together; when it cannot, nothing is changed,
 * the count is given back and the card works again (lib/story/draftJobs.js). Refused here, before anything is counted or queued,
 * while a shot is being made or another drafting job runs.
 */
async function changeMode({ userId, user, projectId, mode, chat }) {
  await assertNoShotBeingMade(projectId);
  await assertNotDrafting(projectId);
  const receipt = await assertAllowed({ userId, action: 'script_revise', projectId, user });
  try {
    await enqueue({
      projectId, kind: 'script',
      payload: { task: 'mode', mode, instruction: MODE_INSTRUCTION[mode], receipt, ...(chat ? { chatId: chat.chatId, confirmId: chat.confirmId } : {}) },
    });
  } catch (err) {
    await releaseAllowance(receipt).catch(() => {});
    throw new StoryError('We could not start the rewrite. Try again.', { status: 503, code: 'queue_failed' });
  }
  await kickWorker(DRAFT_WORKER_PATH);
  return { queued: true, drafting: { task: 'mode', status: 'queued' }, message: 'Your script is being rewritten. This takes a minute.' };
}

// ---------------------------------------------------------------- views

const cap = (text, n) => (typeof text === 'string' && text.length > n ? `${text.slice(0, n)}…` : text ?? null);

function projectView(p) {
  return {
    id: p.id,
    title: p.title,
    step: p.step,
    purpose: p.purpose,
    offer: p.offer,
    audience: p.audience,
    style: p.style,
    style_custom: p.style_custom,
    seconds: p.seconds,
    mode: p.mode,
    quality: p.quality,
    aspect: p.aspect,
    project_fee_paid: Boolean(p.fee_charged),
    consistent_cast: p.consistent_cast !== false,
  };
}

const sceneView = (s) => ({ id: s.id, title: s.title, visual: s.visual, lines: s.lines, ...(s.mention === true ? { mention: true } : {}) });

const castView = (c) => ({
  id: c.id,
  name: c.name,
  look: cap(c.description, 240),
  status: c.status,
  picked_option: Number.isInteger(c.chosen_index) ? c.chosen_index + 1 : null,
  regenerations_used: c.regens_used,
  next_regeneration_credits: c.regen_credits,
});

const shotView = (s) => ({
  id: s.id,
  ord: s.ord,
  scene_id: s.scene_id,
  description: cap(s.description, 240),
  line: cap(s.line, 200),
  seconds: s.seconds,
  quality: s.quality,
  status: s.status,
  source: s.source,
  has_picture: Boolean(s.still_url),
  has_clip: Boolean(s.clip_url),
});

/** Everything the model needs to know about one project (the system prompt and get_project). */
export async function projectSummary({ userId, project }) {
  const [script, castRows, { shots }, pricing] = await Promise.all([
    getScript({ userId, projectId: project.id }),
    storyDb().select('story_cast', { project_id: project.id }, { order: ['ord', 'created_at'] }),
    listShots({ userId, projectId: project.id }),
    getPricing(),
  ]);
  return {
    project: projectView(project),
    script: script
      ? { version: script.version, scenes: script.scenes.map(sceneView), problems: (script.violations || []).map((v) => ({ scene_id: v.sceneId, message: v.message })) }
      : null,
    cast: presentCast(castRows, pricing).map(castView),
    shots: shots.map(shotView),
    options: {
      styles: STYLES.map((key) => ({ key, label: STYLE_PRESETS[key]?.label || key })),
      seconds: { min: MIN_SECONDS, max: MAX_SECONDS },
      qualities: [...QUALITIES],
    },
    allowances: {
      included_regenerations_per_character: pricing.included.castRegenPerCharacter,
      regeneration_credits_after_that: pricing.castRegen,
    },
  };
}

// ---------------------------------------------------------------- tools

const text = (value, field, message) => {
  if (typeof value !== 'string' || !value.trim()) throw new ValidationError(message, { field });
  return value;
};
const optionalText = (value, field) => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new ValidationError(`${field} must be text.`, { field });
  return value;
};

async function findCast(projectId, castId) {
  const rows = await storyDb().select('story_cast', { project_id: projectId }, { order: ['ord', 'created_at'] });
  const row = rows.find((r) => r.id === castId);
  if (!row) throw new StoryError('There is no character with that id in this video.', { status: 404, code: 'not_found' });
  return row;
}

/**
 * What the video costs now: the Generate step's own quote when there are shots to make, else the estimate for the length
 * (the project fee unless paid, plus whole 3 second shots at the quality), the same one the quote bar shows.
 */
async function priceNow({ userId, project }) {
  try {
    const q = await quoteGeneration({ userId, projectId: project.id });
    if (q.shotIds?.length || q.total > 0) return { total: q.total, lines: q.lines, shotIds: q.shotIds, estimate: false };
  } catch (err) {
    if (!(err instanceof StoryError)) throw err;
  }
  const { shots: made } = await listShots({ userId, projectId: project.id });
  if (made.length) return { total: 0, lines: [], shotIds: [], estimate: false };
  const shots = Array.from({ length: Math.ceil(project.seconds / 3) }, () => ({ quality: project.quality, seconds: 3 }));
  return { ...(await quoteProject({ shots, feeAlreadyCharged: Boolean(project.fee_charged), seconds: project.seconds })), estimate: true };
}

const TOOLS = {
  async get_project({ userId, project }) {
    return { summary: await projectSummary({ userId, project }) };
  },

  async revise_script({ userId, user, project, input, chatCounted }) {
    const out = await reviseScript({ userId, projectId: project.id, instruction: input.instruction, user, chatCounted });
    return { changed: 'script', changedSceneIds: out.changedSceneIds, script: { version: out.script.version, scenes: out.script.scenes.map(sceneView) } };
  },

  async update_scene({ userId, project, input }) {
    const sceneId = text(input.scene_id, 'scene_id', 'Say which scene to change.');
    const out = await updateScene({ userId, projectId: project.id, sceneId, patch: input.patch });
    const scene = out.script.scenes.find((s) => s.id === sceneId);
    // The edit is saved either way; lines that repeat the reference video go back to the chat model to fix.
    const copies = (out.script.violations || []).filter((v) => v.rule === 'reference_copy')
      .map((v) => ({ sceneId: v.sceneId, matched: v.matched, message: v.message }));
    return {
      changed: 'script',
      changedSceneIds: out.changedSceneIds,
      scene: scene ? sceneView(scene) : null,
      ...(copies.length ? { reference_copies: copies, note: 'These lines repeat words from the reference video. Rewrite them in new words with update_scene.' } : {}),
    };
  },

  async regenerate_character({ project, input }) {
    const castId = text(input.cast_id, 'cast_id', 'Say which character.');
    const note = optionalText(input.note, 'note');
    const row = await findCast(project.id, castId);
    const view = presentCast(row, await getPricing());
    // A failed set is tried again (its own price, retry_credits) when asked, or when no new look is described.
    if (row.status === 'pending' || row.status === 'draft') {
      throw new StoryError(`The pictures for ${row.name} are still being made. Wait for them to finish.`, { status: 409, code: 'conflict' });
    }
    const retry = row.status === 'failed' && (input.retry === true || !note);
    const price = retry ? view.retry_credits : view.regen_credits;
    return {
      needsConfirm: true,
      quote: { label: retry ? `Try again: pictures of ${row.name}` : `New pictures of ${row.name}`, credits: price },
      confirm: {
        action: 'cast-regen',
        method: 'POST',
        body: retry ? { castId: row.id, retry: true, expected_credits: price } : { castId: row.id, note: note ?? '', expected_credits: price },
      },
    };
  },

  async update_shot({ userId, project, input }) {
    const shotId = text(input.shot_id, 'shot_id', 'Say which shot.');
    const patch = {};
    if (input.description !== undefined) patch.description = input.description;
    if (input.quality !== undefined) patch.quality = input.quality;
    const { shot } = await updateShot({ userId, projectId: project.id, shotId, patch });
    return {
      changed: 'shots',
      shot: shotView(shot),
      ...('description' in patch && !shot.still_url ? { note: 'The picture for this shot is made again from the Storyboard step.' } : {}),
    };
  },

  async set_style({ userId, project, input }) {
    const patch = { style: input.style };
    if (input.style_custom !== undefined) patch.style_custom = input.style_custom;
    const saved = await updateProject({ userId, id: project.id, patch });
    return { changed: 'project', project: projectView(saved) };
  },

  async set_length({ userId, project, input }) {
    const saved = await updateProject({ userId, id: project.id, patch: { seconds: input.seconds } });
    return { changed: 'project', project: projectView(saved) };
  },

  async set_quality({ userId, project, input }) {
    if (!QUALITIES.includes(input.quality)) throw new ValidationError('Choose one of the quality levels.', { field: 'quality' });
    const saved = await updateProject({ userId, id: project.id, patch: qualityPatch(input.quality) });
    // Shots without a clip follow the new quality, so the price below is the price Generate will ask. A shot being made
    // right now, one with its own footage and one whose clip exists keep what they have.
    const { shots } = await listShots({ userId, projectId: project.id });
    for (const shot of shots) {
      if (shot.quality === input.quality || shot.clip_url || shot.source === 'footage' || MAKING.includes(shot.status)) continue;
      await updateShot({ userId, projectId: project.id, shotId: shot.id, patch: { quality: input.quality } });
    }
    return { changed: 'project', project: projectView(saved), quote: await priceNow({ userId, project: saved }), note: 'Nothing has been charged.' };
  },

  async pick_character({ userId, project, input }) {
    if (project.consistent_cast === false) {
      throw new StoryError('This video has different people in every scene, so there are no characters to pick. Turn that off with set_consistent_cast to use a cast.', { status: 409, code: 'no_cast' });
    }
    const option = input.option;
    if (!Number.isInteger(option) || option < 1 || option > 3) throw new ValidationError('Choose option 1, 2 or 3.', { field: 'option' });
    const rows = await storyDb().select('story_cast', { project_id: project.id }, { order: ['ord', 'created_at'] });
    let row;
    if (typeof input.cast_id === 'string' && input.cast_id) {
      row = rows.find((r) => r.id === input.cast_id);
    } else if (typeof input.name === 'string' && input.name.trim()) {
      const wanted = input.name.trim().toLowerCase();
      const hits = rows.filter((r) => r.name.toLowerCase() === wanted);
      if (hits.length > 1) throw new ValidationError('More than one character has that name. Use the character id.', { field: 'name' });
      [row] = hits;
    } else {
      throw new ValidationError('Say which character, by id or name.', { field: 'cast_id' });
    }
    if (!row) throw new StoryError('There is no character like that in this video.', { status: 404, code: 'not_found' });
    // The same service as the Pick button (free: the first three pictures are covered by the project fee).
    const out = await pickCast({ userId, projectId: project.id, castId: row.id, candidateIndex: option - 1 });
    return { changed: 'cast', cast: castView(presentCast(out.cast, await getPricing())) };
  },

  async set_consistent_cast({ userId, project, input }) {
    if (typeof input.consistent_cast !== 'boolean') throw new ValidationError('consistent_cast must be true or false.', { field: 'consistent_cast' });
    if (input.consistent_cast === (project.consistent_cast !== false)) return { changed: 'project', project: projectView(project), note: 'It was already set that way.' };
    // Clips already made would all need making again, and that has a price: nothing changes until the customer confirms.
    const made = (await clipView(project.id, project)).filter((s) => s.clip_url);
    if (made.length) {
      const remake = made.reduce((n, s) => n + (Number.isInteger(s.clip_price) ? s.clip_price : 0), 0);
      const count = made.length;
      return {
        needsConfirm: true,
        quote: {
          label: `${input.consistent_cast ? 'Use the same characters' : 'Use different people'} in every scene: ${count} ${count === 1 ? 'clip' : 'clips'} will need making again (${remake} credits)`,
          credits: 0, clips: count, remake_credits: remake,
        },
        confirm: { action: 'consistent-cast', method: 'POST', body: { consistent_cast: input.consistent_cast, clips: count, remake_credits: remake } },
      };
    }
    // updateProject marks the affected shots stale the same way a cast change does.
    const saved = await updateProject({ userId, id: project.id, patch: { consistent_cast: input.consistent_cast } });
    return { changed: 'project', project: projectView(saved) };
  },

  async set_mode({ userId, project, input }) {
    if (!MODES.includes(input.mode)) throw new ValidationError('mode must be narrated or talking.', { field: 'mode' });
    if (input.mode === project.mode) return { changed: 'project', project: projectView(project), note: 'It was already set that way.' };
    await assertNotDrafting(project.id);
    // The script has to fit the style, so the change always rewrites it (a script rewrite, counted like any other), and clips already made
    // would need making again (their sound changes): nothing changes until the customer confirms, and the card says both.
    const made = (await clipView(project.id, project)).filter((s) => s.clip_url);
    const remake = made.reduce((n, s) => n + (Number.isInteger(s.clip_price) ? s.clip_price : 0), 0);
    const count = made.length;
    const again = count ? ` ${count} ${count === 1 ? 'clip' : 'clips'} will need making again (${remake} credits).` : '';
    return {
      needsConfirm: true,
      quote: { label: `${MODE_WORDS[input.mode]}: ${MODE_REWRITE[input.mode]}.${again}`, credits: 0, clips: count, remake_credits: remake },
      confirm: { action: 'mode', method: 'POST', body: { mode: input.mode, clips: count, remake_credits: remake } },
    };
  },

  async make_scene({ userId, project, input }) {
    const n = input.scene_number;
    if (!Number.isInteger(n) || n < 1) throw new ValidationError('Say which scene, counting from 1.', { field: 'scene_number' });
    const script = await getScript({ userId, projectId: project.id });
    const scene = script?.scenes?.[n - 1];
    if (!scene) throw new StoryError(`There is no scene ${n} in this video.`, { status: 404, code: 'not_found' });
    // What the Generate step would start by default, narrowed to this scene: the same rules, so nothing odd is quoted.
    const all = await priceGeneration(project);
    const ids = all.items.filter((it) => it.shot.scene_id === scene.id).map((it) => it.shot.id);
    if (!ids.length) {
      const shots = (await listShots({ userId, projectId: project.id })).shots.filter((s) => s.scene_id === scene.id);
      const making = shots.some((s) => MAKING.includes(s.status));
      throw new StoryError(
        making ? `Scene ${n} is already being made. Wait for it to finish.` : `Scene ${n} has nothing left to make.`,
        { status: 409, code: making ? 'conflict' : 'nothing_to_make' }
      );
    }
    const quote = await quoteGeneration({ userId, projectId: project.id, shotIds: ids });
    const missing = (await clipView(project.id, project)).filter((s) => ids.includes(s.id) && !s.still_url);
    if (missing.length) {
      throw new StoryError(`The pictures for scene ${n} are not ready yet. Make the storyboard pictures first.`, { status: 422, code: 'still_missing' });
    }
    return {
      needsConfirm: true,
      quote: { label: `Make scene ${n}`, credits: quote.total, lines: quote.lines, shotIds: quote.shotIds },
      confirm: { action: 'generate', method: 'POST', body: { shotIds: quote.shotIds, confirmTotal: quote.total } },
    };
  },

  async get_quote({ userId, project, input }) {
    if (input.shot_ids !== undefined && (!Array.isArray(input.shot_ids) || !input.shot_ids.every((id) => typeof id === 'string'))) {
      throw new ValidationError('shot_ids must be a list of shot ids.', { field: 'shot_ids' });
    }
    // The Generate step's own quote (lib/story/shots.js): the price the generate action checks confirmTotal against.
    const quote = await quoteGeneration({ userId, projectId: project.id, shotIds: input.shot_ids });
    const balance = await getBalance(userId, 'video');
    const out = {
      quote: { total: quote.total, lines: quote.lines, shotIds: quote.shotIds },
      balance: { available: balance.available },
      note: 'Nothing has been charged.',
    };
    if (!quote.shotIds?.length) return out;
    const count = quote.shotIds.length;
    return {
      ...out,
      needsConfirm: true,
      quote: { ...out.quote, label: `Make ${count} video ${count === 1 ? 'clip' : 'clips'}`, credits: quote.total },
      confirm: { action: 'generate', method: 'POST', body: { shotIds: quote.shotIds, confirmTotal: quote.total } },
    };
  },

  async make_picture({ userId, project, input }) {
    const shotId = text(input.shot_id, 'shot_id', 'Say which shot.');
    const { shots } = await listShots({ userId, projectId: project.id });
    const shot = shots.find((s) => s.id === shotId);
    if (!shot) throw new StoryError('There is no shot with that id in this video.', { status: 404, code: 'not_found' });
    if (shot.still_credits === null || shot.still_credits === undefined) {
      throw new StoryError('This shot uses your own footage, so it has no picture to make.', { status: 422, code: 'footage' });
    }
    if (['still_pending', 'queued', 'generating'].includes(shot.status)) {
      throw new StoryError('This shot is still being made. Wait for it to finish.', { status: 409, code: 'conflict' });
    }
    return {
      needsConfirm: true,
      quote: { label: `New picture for shot ${shot.ord + 1}`, credits: shot.still_credits },
      confirm: { action: 'stills', method: 'POST', body: { shotIds: [shot.id], expected_credits: shot.still_credits } },
    };
  },

  async remake_clip({ project, input }) {
    const shotId = text(input.shot_id, 'shot_id', 'Say which shot.');
    const shot = (await clipView(project.id, project)).find((s) => s.id === shotId);
    if (!shot) throw new StoryError('There is no shot with that id in this video.', { status: 404, code: 'not_found' });
    if (shot.reroll_credits === null || shot.reroll_credits === undefined) {
      throw new StoryError('This clip cannot be made again right now. A shot that changed is made on the Generate step.', { status: 409, code: 'reroll_not_available' });
    }
    return {
      needsConfirm: true,
      quote: { label: `Make the clip of shot ${shot.ord + 1} again`, credits: shot.reroll_credits },
      confirm: { action: 'reroll', method: 'POST', body: { shotId: shot.id, expected_credits: shot.reroll_credits } },
    };
  },
};

// ---------------------------------------------------------------- runner

const SAFE = {
  blocked: 'That wording is not allowed here. Try different words.',
  server: 'Something went wrong with that change. Please try again.',
};

function toolError(err) {
  if (err instanceof StoryError) {
    const extra = Number.isInteger(err.extra?.credits) ? { credits: err.extra.credits } : {};
    return { ok: false, error: err.code, message: err.message, ...extra };
  }
  if (err instanceof ModerationError) return { ok: false, error: 'blocked', message: SAFE.blocked };
  if (err instanceof InsufficientCreditsError) {
    return { ok: false, error: 'insufficient_credits', message: 'There are not enough credits for that.', needed: err.needed, available: err.available };
  }
  if (err instanceof ProviderError) return { ok: false, error: `provider_${err.code}`, message: err.code === 'config' ? SAFE.server : err.message };
  console.error('[story chat] tool failed', err);
  return { ok: false, error: 'server_error', message: SAFE.server };
}

export async function runTool({ userId, user, chatProjectId, name, input, chatCounted = false }) {
  const run = Object.hasOwn(TOOLS, name) ? TOOLS[name] : null;
  if (!run) return { ok: false, error: 'unknown_tool', message: `There is no tool called ${String(name).slice(0, 40)}.` };
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'validation_failed', message: 'The tool input must be an object.' };
  }
  const projectId = input.project_id ?? chatProjectId;
  if (typeof projectId !== 'string' || !projectId) return { ok: false, error: 'validation_failed', message: 'Say which project.' };
  if (chatProjectId && projectId !== chatProjectId) {
    return { ok: false, error: 'wrong_project', message: 'This chat can only change the video it belongs to.' };
  }
  try {
    const project = await getProject({ userId, id: projectId });
    return { ok: true, ...(await run({ userId, user, project, input, chatCounted })) };
  } catch (err) {
    return toolError(err);
  }
}

// ---------------------------------------------------------------- confirm cards

/** The actions a confirm card may run, and the route each one stands for. */
export const CONFIRM_ACTIONS = Object.freeze(['cast-regen', 'generate', 'reroll', 'stills', 'consistent-cast']);

/**
 * What the action behind a confirm card costs right now, from the same server
 * fields the card was priced from; null when the card can no longer run.
 */
export async function currentConfirmPrice({ userId, projectId, confirm }) {
  const body = confirm?.body || {};
  switch (confirm?.action) {
    case 'cast-regen': {
      if (!body.castId) return null;
      const rows = await storyDb().select('story_cast', { project_id: projectId }, { order: ['ord', 'created_at'] });
      const row = rows.find((r) => r.id === body.castId);
      if (!row || row.status === 'pending' || row.status === 'draft') return null;
      const view = presentCast(row, await getPricing());
      if (body.retry === true) return row.status === 'failed' ? view.retry_credits : null;
      return view.regen_credits;
    }
    case 'generate': {
      // Read only (no stall recovery): shots.js priceGeneration, the price startGeneration checks confirmTotal against.
      const ids = body.shotIds;
      if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some((id) => typeof id !== 'string')) return null;
      const [project] = await storyDb().select('story_projects', { id: projectId });
      if (!project) return null;
      let price;
      try {
        price = await priceGeneration(project, [...new Set(ids)]);
      } catch (err) {
        if (err instanceof StoryError) return null;
        throw err;
      }
      const same = price.shotIds.length === ids.length && price.shotIds.every((id) => ids.includes(id));
      return same ? price.total : null;
    }
    case 'reroll': {
      const [project] = await storyDb().select('story_projects', { id: projectId });
      if (!project) return null;
      const shot = (await clipView(projectId, project)).find((s) => s.id === body.shotId);
      return shot?.reroll_credits ?? null;
    }
    case 'consistent-cast': {
      // No credits. The card is open only while the flag still differs from what it would set.
      const [project] = await storyDb().select('story_projects', { id: projectId });
      if (!project || typeof body.consistent_cast !== 'boolean') return null;
      if ((project.consistent_cast !== false) === body.consistent_cast) return null;
      // The card said how many clips would need making again and what that costs: if that moved, it is out of date.
      const made = (await clipView(projectId, project)).filter((s) => s.clip_url);
      const remake = made.reduce((n, s) => n + (Number.isInteger(s.clip_price) ? s.clip_price : 0), 0);
      return made.length === body.clips && remake === body.remake_credits ? 0 : null;
    }
    case 'mode': {
      // No credits. The card is open only while the mode still differs, and the clips it counted are still the clips.
      const [project] = await storyDb().select('story_projects', { id: projectId });
      if (!project || !MODES.includes(body.mode) || project.mode === body.mode) return null;
      const made = (await clipView(projectId, project)).filter((s) => s.clip_url);
      const remake = made.reduce((n, s) => n + (Number.isInteger(s.clip_price) ? s.clip_price : 0), 0);
      return made.length === body.clips && remake === body.remake_credits ? 0 : null;
    }
    case 'stills': {
      const [project] = await storyDb().select('story_projects', { id: projectId });
      if (!project || !Array.isArray(body.shotIds)) return null;
      const shots = await clipView(projectId, project);
      const ids = body.shotIds;
      const chosen = shots.filter((s) => ids.includes(s.id));
      // The shot statuses a picture can start from (lib/story/storyboard.js STILL_STARTABLE).
      const startable = ['draft', 'still_ready', 'failed', 'blocked', 'ready'];
      if (chosen.length !== ids.length || chosen.some((s) => s.still_credits === null || !startable.includes(s.status))) return null;
      return chosen.reduce((n, s) => n + s.still_credits, 0);
    }
    default:
      return null;
  }
}

/** Runs a stored confirm card's action through its normal service, at the card's price. */
export async function runConfirm({ userId, user, projectId, confirm, chat = null }) {
  const body = confirm?.body || {};
  switch (confirm?.action) {
    case 'cast-regen':
      return regenerateCharacter({
        userId,
        projectId,
        castId: body.castId,
        note: body.retry === true ? undefined : body.note || undefined,
        retry: body.retry === true,
        expectedCredits: body.expected_credits,
        user,
      });
    case 'generate':
      return startGeneration({ userId, projectId, shotIds: body.shotIds, confirmTotal: body.confirmTotal, user });
    case 'reroll':
      return rerollShot({ userId, projectId, shotId: body.shotId, expectedCredits: body.expected_credits, user });
    case 'consistent-cast':
      if (typeof body.consistent_cast !== 'boolean') throw new ValidationError('This button is out of date. Ask the chat again.', { field: 'confirmId' });
      return { project: await updateProject({ userId, id: projectId, patch: { consistent_cast: body.consistent_cast } }) };
    case 'mode':
      if (!MODES.includes(body.mode)) throw new ValidationError('This button is out of date. Ask the chat again.', { field: 'confirmId' });
      return changeMode({ userId, user, projectId, mode: body.mode, chat });
    case 'stills':
      return generateStills({ userId, projectId, shotIds: body.shotIds, expectedCredits: body.expected_credits, user });
    default:
      throw new ValidationError('This button is out of date. Ask the chat again.', { field: 'confirmId' });
  }
}
