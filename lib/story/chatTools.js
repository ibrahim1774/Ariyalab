import { getBalance, InsufficientCreditsError } from '../credits.js';
import { ModerationError } from '../moderation.js';
import { getPricing, quoteProject } from '../pricing.js';
import { ProviderError } from '../providers/errors.js';
import { storyDb } from './db.js';
import { StoryError, ValidationError } from './errors.js';
import { getProject, updateProject, MAX_SECONDS, MIN_SECONDS, QUALITIES, STYLES } from './projects.js';
import { STYLES as STYLE_PRESETS } from './prompts/styles.js';
import { getScript, reviseScript, updateScene } from './script.js';
import { presentCast, regenerateCharacter } from './cast.js';
import { listShots, updateShot } from './storyboard.js';

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
 * Money rule: no tool spends credits. The only tool that can lead to a spend
 * is regenerate_character, and it acts only when the server's price
 * (regen_credits) is 0, pinning that price with expectedCredits: 0.
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
    description: 'Makes new pictures of one character, optionally shaped by a short note ("give her a red cap"). Each character has a few included regenerations. When the next one is included it starts at once; when it costs credits nothing happens and the customer gets a button to confirm the price.',
    input_schema: schema({
      cast_id: { type: 'string', description: 'The character id from get_project.' },
      note: { type: 'string', description: 'What to change in the look, in a few words.' },
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
    description: 'Reads what making the video clips would cost now (the project fee if it is not paid yet, plus each shot by length and quality) and the customer\'s balance. Charges nothing; the video is started from the Generate step.',
    input_schema: schema({ shot_ids: { type: 'array', items: { type: 'string' }, description: 'Only these shots. Leave it out for every shot that has no clip yet.' } }),
  },
]);

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
  };
}

const sceneView = (s) => ({ id: s.id, title: s.title, visual: s.visual, lines: s.lines, ...(s.mention === true ? { mention: true } : {}) });

const castView = (c) => ({
  id: c.id,
  name: c.name,
  look: cap(c.description, 240),
  status: c.status,
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
    return { changed: 'script', changedSceneIds: out.changedSceneIds, scene: scene ? sceneView(scene) : null };
  },

  async regenerate_character({ userId, user, project, input }) {
    const castId = text(input.cast_id, 'cast_id', 'Say which character.');
    const note = optionalText(input.note, 'note');
    const row = await findCast(project.id, castId);
    const price = presentCast(row, await getPricing()).regen_credits;
    if (price > 0) {
      return {
        needsConfirm: true,
        quote: { label: `New pictures of ${row.name}`, credits: price },
        confirm: { action: 'cast-regen', method: 'POST', body: { castId: row.id, note: note ?? '', expected_credits: price } },
      };
    }
    // An included regeneration. expectedCredits: 0 means a price that moved in the meantime is refused, never charged.
    const out = await regenerateCharacter({ userId, projectId: project.id, castId: row.id, note, expectedCredits: 0, user });
    return { changed: 'cast', charged: out.charged, character: castView(out.cast) };
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

  async get_quote({ userId, project, input }) {
    const { shots } = await listShots({ userId, projectId: project.id });
    let chosen;
    if (input.shot_ids !== undefined) {
      if (!Array.isArray(input.shot_ids) || !input.shot_ids.every((id) => typeof id === 'string')) {
        throw new ValidationError('shot_ids must be a list of shot ids.', { field: 'shot_ids' });
      }
      chosen = shots.filter((s) => input.shot_ids.includes(s.id));
    } else {
      chosen = shots.filter((s) => s.source !== 'footage' && !s.clip_url);
    }
    const quote = await quoteProject({ shots: chosen, feeAlreadyCharged: Boolean(project.fee_charged) });
    const balance = await getBalance(userId, 'video');
    return {
      quote: { ...quote, shotIds: chosen.map((s) => s.id) },
      balance: { available: balance.available },
      note: 'Nothing has been charged. The video is started from the Generate step.',
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
