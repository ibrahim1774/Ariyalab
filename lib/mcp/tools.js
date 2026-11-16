import { getBalance, InsufficientCreditsError } from '../credits.js';
import { ModerationError } from '../moderation.js';
import { getPricing } from '../pricing.js';
import { ProviderError } from '../providers/errors.js';
import { storyDb } from '../story/db.js';
import { QuoteChangedError, StoryError, ValidationError } from '../story/errors.js';
import { createProject, EDITABLE_FIELDS, getProject, listProjects, ASPECTS, MAX_SECONDS, MIN_SECONDS, MODES, PURPOSES, QUALITIES, STYLES } from '../story/projects.js';
import { reviseScript, updateScene, writeScript } from '../story/script.js';
import { generateCast, pickCast } from '../story/cast.js';
import { buildShotList, generateStills, listShots } from '../story/storyboard.js';
import { priceGeneration, quoteGeneration, startGeneration } from '../story/shots.js';
import { startRender } from '../story/render.js';
import { getReference, startAnalysis } from '../story/analyze.js';
import { RIGHTS_STATEMENT } from '../story/referenceRules.js';
import { getProjectStatus } from '../story/status.js';
import { projectSummary } from '../story/chatTools.js';

/*
 * The tools of the Ariya Lab MCP connector (lib/mcp/server.js serves them at
 * /api/mcp). Each maps to one lib/story service called with the user id from
 * the verified access token, never from the arguments, so another user's
 * project is not_found exactly as on the website.
 *
 *   MCP_TOOLS                                   tool definitions (JSON Schema)
 *   runMcpTool({ userId, baseUrl, name, args }) -> { isError, data }   never throws
 *
 * Money (the price shown is the price charged): generate_cast (the project fee
 * while unpaid), generate_storyboard (pictures past the included tries) and
 * generate_video take confirm_total. Without it a priced call returns
 *   { needs_confirmation: true, quote: { total, lines }, balance, next }
 * and spends nothing; a confirm_total that is not the price now is the error
 * quote_changed with the fresh quote. The services check the confirmed amount
 * again when they hold or spend (expectedCredits / confirmTotal).
 *
 * Time: /api/mcp has maxDuration 25, under the 30 s claim recovery of
 * lib/story/shots.js and storyboard.js. Tools that start provider work only
 * claim, hold and queue (the runner and the worker routes do the work) and
 * return at once with status_text telling the model to poll get_status.
 * generate_storyboard plans the shots (a model call) and starts the pictures
 * (a hold) in separate calls.
 *
 * Errors: { error, message, ...detail } with isError, message safe to show.
 */

// ---------------------------------------------------------------- definitions

const PROJECT_ID = { type: 'string', description: 'The video project id (from create_project or get_project).' };
const CONFIRM_TOTAL = {
  type: 'integer',
  minimum: 0,
  description: 'The exact credit total the customer agreed to. Leave it out first: the tool then returns the quote and spends nothing. Show the customer that price, and only after they say yes call again with it.',
};
const obj = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const WRITES = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

const BRIEF_FIELDS = {
  title: { type: 'string', description: 'A short name for the video (at most 120 characters).' },
  purpose: { type: 'string', enum: [...PURPOSES], description: 'What the video is for.' },
  offer: { type: 'string', description: 'What is being promoted or told, in plain words (at most 1000 characters).' },
  audience: { type: 'string', description: 'Who the video is for (at most 500 characters).' },
  style: { type: 'string', enum: [...STYLES], description: 'The art style. "custom" needs style_custom.' },
  style_custom: { type: 'string', description: 'Only with style "custom": the look in plain words (at most 300 characters).' },
  seconds: { type: 'integer', minimum: MIN_SECONDS, maximum: MAX_SECONDS, description: 'Length of the finished video in seconds.' },
  aspect: { type: 'string', enum: [...ASPECTS] },
  quality: { type: 'string', enum: [...QUALITIES], description: 'Video quality. pro_talking means the characters speak with their own voices (mode talking).' },
  mode: { type: 'string', enum: [...MODES] },
};

export const MCP_TOOLS = Object.freeze([
  {
    name: 'create_project',
    title: 'Create a video project',
    description: 'Starts a new story video from a short brief. Free. Returns the project id every other tool needs. Next: write_script, or analyze_reference to base it on an existing short video.',
    inputSchema: obj(BRIEF_FIELDS),
    annotations: WRITES,
  },
  {
    name: 'analyze_reference',
    title: 'Analyze a reference video',
    description: `Breaks down an Instagram, TikTok or Facebook video so the script follows its structure (never its footage, words or characters). Free (free accounts get one a day). Before calling, the customer must agree to this statement, word for word: "${RIGHTS_STATEMENT}" Then pass rights_confirmed: true. The analysis runs in the background: poll get_status, then call write_script.`,
    inputSchema: obj({
      project_id: PROJECT_ID,
      url: { type: 'string', description: 'The video link (instagram.com, tiktok.com, facebook.com or fb.watch).' },
      rights_confirmed: { type: 'boolean', description: 'true only after the customer agreed to the rights statement in this description.' },
    }, ['project_id', 'url', 'rights_confirmed']),
    annotations: { ...WRITES, openWorldHint: true },
  },
  {
    name: 'get_project',
    title: 'Read a project',
    description: 'Without project_id: lists the customer\'s video projects. With project_id: the brief, the script scenes with their ids, the characters, the shots, the reference analysis and the options. Free.',
    inputSchema: obj({ project_id: PROJECT_ID }),
    annotations: READ_ONLY,
  },
  {
    name: 'write_script',
    title: 'Write the script',
    description: 'Writes the script from the brief (or from the analysed reference). Free; free accounts can write a project\'s script a few times a day. Writing again replaces the current script with a new version.',
    inputSchema: obj({ project_id: PROJECT_ID }, ['project_id']),
    annotations: WRITES,
  },
  {
    name: 'set_script',
    title: 'Change the script',
    description: 'Changes the script. Either pass instruction for a change in plain words ("make the opening funnier"; counted like a chat message), or scene_id with patch to edit one scene exactly. Free.',
    inputSchema: obj({
      project_id: PROJECT_ID,
      instruction: { type: 'string', description: 'The change in the customer\'s words, at most 1000 characters.' },
      scene_id: { type: 'string', description: 'The scene to edit, like s2 (from get_project).' },
      patch: {
        type: 'object',
        description: 'With scene_id: the new title, visual or lines (lines replaces all of the scene\'s lines), or mention: true to move the one offer mention to this scene.',
        properties: {
          title: { type: 'string' },
          visual: { type: 'string' },
          lines: {
            type: 'array',
            items: obj({ speaker: { type: 'string', description: '"narrator" or a character\'s name.' }, text: { type: 'string' } }, ['speaker', 'text']),
          },
          mention: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    }, ['project_id']),
    annotations: WRITES,
  },
  {
    name: 'generate_cast',
    title: 'Make the characters',
    description: 'Writes the characters from the script and starts three pictures of each. The first time it charges the one-off project fee: call without confirm_total to get the price, show it, and call again with confirm_total once the customer agrees. Pictures are made in the background: poll get_status, then pick_cast.',
    inputSchema: obj({ project_id: PROJECT_ID, confirm_total: CONFIRM_TOTAL }, ['project_id']),
    annotations: WRITES,
  },
  {
    name: 'pick_cast',
    title: 'Pick a character picture',
    description: 'Chooses one of a character\'s finished pictures (index from get_status) and starts its character sheet in the background. Free.',
    inputSchema: obj({
      project_id: PROJECT_ID,
      cast_id: { type: 'string', description: 'The character id from get_status or get_project.' },
      candidate_index: { type: 'integer', minimum: 0, description: 'The picture index from get_status.' },
    }, ['project_id', 'cast_id', 'candidate_index']),
    annotations: WRITES,
  },
  {
    name: 'generate_storyboard',
    title: 'Make the storyboard',
    description: 'Two steps. While the shot list is missing or out of date, it plans the shots from the script and returns them with the price of their pictures; nothing is started. Called again, it starts the pictures: they are included up to a few tries per shot, otherwise pass the confirmed confirm_total. Pictures are made in the background: poll get_status. If a rebuild would remove finished clips it is refused with a rebuild_token; pass it back only after the customer agrees.',
    inputSchema: obj({
      project_id: PROJECT_ID,
      confirm_total: CONFIRM_TOTAL,
      rebuild_token: { type: 'string', description: 'Only after the customer agreed to lose the clips named in a rebuild_loses_clips answer.' },
    }, ['project_id']),
    annotations: WRITES,
  },
  {
    name: 'get_quote',
    title: 'Price the video clips',
    description: 'What making the video clips costs now (the project fee if unpaid, plus each shot by length and quality) and the customer\'s balance. Charges nothing.',
    inputSchema: obj({ project_id: PROJECT_ID, shot_ids: { type: 'array', items: { type: 'string' }, description: 'Only these shots. Leave it out for every shot that wants a clip.' } }, ['project_id']),
    annotations: READ_ONLY,
  },
  {
    name: 'generate_video',
    title: 'Make the video clips',
    description: 'Makes the video clip of every shot that wants one, for exactly confirm_total credits. Always get the price first (get_quote, or call this without confirm_total, which returns the quote and spends nothing), show it to the customer, and only pass confirm_total after they agree. Clips are made in the background: poll get_status, then call render.',
    inputSchema: obj({
      project_id: PROJECT_ID,
      confirm_total: CONFIRM_TOTAL,
      shot_ids: { type: 'array', items: { type: 'string' }, description: 'Only these shots. Leave it out for every shot that wants a clip.' },
    }, ['project_id', 'confirm_total']),
    annotations: WRITES,
  },
  {
    name: 'get_status',
    title: 'Check progress',
    description: 'Where the project stands: the step, the characters and their pictures, how many shots have pictures and clips, work still running, the render and the current price of the clips. Poll it every 10 to 20 seconds while work is running. Free.',
    inputSchema: obj({ project_id: PROJECT_ID }, ['project_id']),
    annotations: READ_ONLY,
  },
  {
    name: 'render',
    title: 'Put the video together',
    description: 'Puts the finished clips, narration, music and captions together into the final video. No credits. Runs in the background: poll get_status, then call get_result.',
    inputSchema: obj({ project_id: PROJECT_ID }, ['project_id']),
    annotations: WRITES,
  },
  {
    name: 'get_result',
    title: 'Get the finished video',
    description: 'The link to the newest finished video, with its length and any quality warnings. Free.',
    inputSchema: obj({ project_id: PROJECT_ID }, ['project_id']),
    annotations: READ_ONLY,
  },
]);

export const MCP_TOOL_NAMES = Object.freeze(MCP_TOOLS.map((t) => t.name));
const SCHEMAS = new Map(MCP_TOOLS.map((t) => [t.name, t.inputSchema]));

// ---------------------------------------------------------------- views

const POLL = 'Poll get_status every 10 to 20 seconds until it is done.';
const absolute = (url, base) => (typeof url === 'string' && url.startsWith('/') && !url.startsWith('//') ? `${base}${url}` : url ?? null);

const projectBrief = (p) => ({
  id: p.id, title: p.title, step: p.step, status: p.status, purpose: p.purpose, offer: p.offer, audience: p.audience,
  style: p.style, style_custom: p.style_custom, seconds: p.seconds, aspect: p.aspect, quality: p.quality, mode: p.mode,
  project_fee_paid: Boolean(p.fee_charged), updated_at: p.updated_at ?? null,
});

const scriptView = (s) => (s ? {
  version: s.version,
  scenes: s.scenes.map((sc) => ({ id: sc.id, title: sc.title, visual: sc.visual, lines: sc.lines, ...(sc.mention === true ? { mention: true } : {}) })),
  problems: (s.violations || []).map((v) => ({ scene_id: v.sceneId, message: v.message })),
} : null);

const castBrief = (c, base) => ({
  id: c.id,
  name: c.name,
  status: c.status,
  pictures: (Array.isArray(c.candidates) ? c.candidates : []).map((pic, index) => ({ index, url: absolute(pic?.url, base) })).filter((p) => p.url),
  picked_index: Number.isInteger(c.chosen_index) ? c.chosen_index : null,
  sheet_ready: Boolean(c.sheet?.url),
});

const shotBrief = (s, base) => ({
  id: s.id, ord: s.ord, scene_id: s.scene_id, description: s.description, line: s.line, seconds: s.seconds, quality: s.quality,
  status: s.status, picture_url: absolute(s.still_url, base), has_clip: Boolean(s.clip_url),
});

const renderBrief = (r, base) => (r ? {
  version: r.version,
  status: r.status,
  ...(r.status === 'done' ? { url: absolute(r.file_url, base), duration_seconds: r.duration_seconds, warnings: Array.isArray(r.warnings) ? r.warnings : [] } : {}),
  ...(r.error ? { error: r.error } : {}),
  created_at: r.created_at,
} : null);

const referenceBrief = (ref) => (ref ? { status: ref.status, error: ref.error, platform: ref.platform, hook: ref.hook, structure: ref.structure, mood: ref.mood, beats: ref.beats?.length ?? 0 } : null);

async function balanceOf(userId) {
  const { available } = await getBalance(userId, 'video');
  return { available };
}

/** The answer of a priced call that was not confirmed: nothing is spent. */
async function quoteAnswer({ userId, tool, projectId, total, lines, extra = {} }) {
  return {
    needs_confirmation: true,
    project_id: projectId,
    quote: { total, lines },
    balance: await balanceOf(userId),
    ...extra,
    next: `Nothing has been charged. Show the customer this price (${total} credits). If they agree, call ${tool} again with confirm_total: ${total}.`,
  };
}

class ToolError extends StoryError {}

const RESULT_EXTRA = ['total', 'credits', 'count', 'token', 'field', 'shotIds', 'needed', 'available'];

function toolError(err) {
  if (err instanceof StoryError) {
    const detail = {};
    for (const k of RESULT_EXTRA) if (err.extra?.[k] !== undefined) detail[k === 'token' ? 'rebuild_token' : k === 'shotIds' ? 'shot_ids' : k] = err.extra[k];
    if (err.extra?.quote) detail.quote = err.extra.quote;
    return { error: err.code, message: err.message, ...detail };
  }
  if (err instanceof ModerationError) {
    return err.code === 'MODERATION_UNAVAILABLE'
      ? { error: 'moderation_unavailable', message: err.message }
      : { error: 'blocked', message: 'That wording is not allowed here. Try different words.' };
  }
  if (err instanceof InsufficientCreditsError) {
    return { error: 'insufficient_credits', message: 'There are not enough credits for that. The customer can top up on the website.', needed: err.needed, available: err.available };
  }
  if (err instanceof ProviderError) {
    return { error: `provider_${err.code}`, message: err.code === 'config' ? 'This service is not available right now. Please try again later.' : err.message };
  }
  console.error('[mcp] tool failed', err);
  return { error: 'server_error', message: 'Something went wrong. Please try again.' };
}

// ---------------------------------------------------------------- arguments

function checkArgs(name, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new ValidationError('The arguments must be an object.');
  const schema = SCHEMAS.get(name);
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(schema.properties, key)) throw new ValidationError(`${name} does not take ${String(key).slice(0, 40)}.`, { field: key });
  }
  // confirm_total is required in generate_video's schema so the model always sees it; left out, the tool answers with the quote.
  for (const key of schema.required.filter((k) => k !== 'confirm_total')) {
    if (args[key] === undefined || args[key] === null) throw new ValidationError(`${key} is required.`, { field: key });
  }
  if (args.project_id !== undefined && (typeof args.project_id !== 'string' || !args.project_id)) {
    throw new ValidationError('project_id must be a project id.', { field: 'project_id' });
  }
}

function confirmOf(args) {
  const v = args.confirm_total;
  if (v === undefined || v === null) return undefined;
  if (!Number.isInteger(v) || v < 0) throw new ValidationError('confirm_total must be a whole number of credits.', { field: 'confirm_total' });
  return v;
}

function shotIdsOf(args) {
  if (args.shot_ids === undefined) return undefined;
  if (!Array.isArray(args.shot_ids) || !args.shot_ids.every((id) => typeof id === 'string')) {
    throw new ValidationError('shot_ids must be a list of shot ids.', { field: 'shot_ids' });
  }
  return args.shot_ids;
}

// ---------------------------------------------------------------- tools

// Shots generate_storyboard starts a picture for: the same default as generateStills (no picture yet, not blocked, not busy).
const STILL_STARTABLE = ['draft', 'still_ready', 'failed', 'ready'];
const wantsPicture = (s) => s.source !== 'footage' && !s.still_url && STILL_STARTABLE.includes(s.status);

const TOOLS = {
  async create_project({ userId, args }) {
    const input = {};
    for (const k of EDITABLE_FIELDS) if (args[k] !== undefined) input[k] = args[k];
    const project = await createProject({ userId, input });
    return { project: projectBrief(project), next: 'Call write_script with this project_id, or analyze_reference first to follow an existing video.' };
  },

  async analyze_reference({ userId, project, args }) {
    if (args.rights_confirmed !== true) {
      throw new ValidationError(`The customer must agree to this first: "${RIGHTS_STATEMENT}" Then pass rights_confirmed: true.`, { field: 'rights_confirmed' });
    }
    if (typeof args.url !== 'string') throw new ValidationError('url must be a link.', { field: 'url' });
    const ref = await startAnalysis({ userId, projectId: project.id, source: { type: 'link', url: args.url }, rights: true });
    return { project_id: project.id, reference: referenceBrief(ref), status_text: `The video is being analysed in the background. ${POLL} Then call write_script.` };
  },

  async get_project({ userId, project }) {
    if (!project) {
      const projects = await listProjects({ userId });
      return { projects: projects.slice(0, 50).map((p) => ({ id: p.id, title: p.title, step: p.step, status: p.status, updated_at: p.updated_at })) };
    }
    const [summary, reference] = await Promise.all([projectSummary({ userId, project }), getReference({ userId, projectId: project.id })]);
    return { summary: { ...summary, reference: referenceBrief(reference) } };
  },

  async write_script({ userId, project }) {
    const script = await writeScript({ userId, projectId: project.id });
    return { project_id: project.id, script: scriptView(script), next: 'Review the script with the customer (set_script to change it), then call generate_cast.' };
  },

  async set_script({ userId, project, args }) {
    const hasInstruction = args.instruction !== undefined;
    const hasPatch = args.scene_id !== undefined || args.patch !== undefined;
    if (hasInstruction === hasPatch) {
      throw new ValidationError('Pass either instruction, or scene_id with patch.', { field: hasInstruction ? 'scene_id' : 'instruction' });
    }
    if (hasInstruction) {
      const out = await reviseScript({ userId, projectId: project.id, instruction: args.instruction });
      return { project_id: project.id, script: scriptView(out.script), changed_scene_ids: out.changedSceneIds };
    }
    if (typeof args.scene_id !== 'string' || !args.scene_id) throw new ValidationError('Say which scene.', { field: 'scene_id' });
    const out = await updateScene({ userId, projectId: project.id, sceneId: args.scene_id, patch: args.patch });
    return { project_id: project.id, script: scriptView(out.script), changed_scene_ids: out.changedSceneIds };
  },

  async generate_cast({ userId, project, args, base }) {
    const confirm = confirmOf(args);
    const { projectFee } = await getPricing();
    const existing = await storyDb().select('story_cast', { project_id: project.id }, { columns: ['id'], limit: 1 });
    const due = existing.length || project.fee_charged ? 0 : Math.max(0, projectFee);
    const lines = due ? [{ label: 'Project fee (once per video)', credits: due }] : [];
    if (confirm === undefined && due > 0) return quoteAnswer({ userId, tool: 'generate_cast', projectId: project.id, total: due, lines });
    if (confirm !== undefined && confirm !== due) {
      throw new ToolError(`The price is now ${due} credits. Check it with the customer and confirm again.`, { status: 409, code: 'quote_changed', total: due, quote: { total: due, lines } });
    }
    let out;
    try {
      out = await generateCast({ userId, projectId: project.id, expectedCredits: due });
    } catch (err) {
      if (err instanceof QuoteChangedError) err.extra.quote = { total: err.extra.total, lines: err.extra.total ? [{ label: 'Project fee (once per video)', credits: err.extra.total }] : [] };
      throw err;
    }
    return {
      project_id: project.id,
      credits: due,
      cast: out.cast.map((c) => castBrief(c, base)),
      status_text: `The character pictures are being made. ${POLL} Then show the customer the pictures and call pick_cast for each character.`,
    };
  },

  async pick_cast({ userId, project, args, base }) {
    if (typeof args.cast_id !== 'string') throw new ValidationError('Say which character.', { field: 'cast_id' });
    const out = await pickCast({ userId, projectId: project.id, castId: args.cast_id, candidateIndex: args.candidate_index });
    return { project_id: project.id, cast: castBrief(out.cast, base), status_text: 'The pick is saved and the character sheet is being drawn. When every character is picked, call generate_storyboard.' };
  },

  async generate_storyboard({ userId, project, args, base }) {
    const confirm = confirmOf(args);
    if (args.rebuild_token !== undefined && typeof args.rebuild_token !== 'string') throw new ValidationError('rebuild_token must be text.', { field: 'rebuild_token' });
    const { shots } = await listShots({ userId, projectId: project.id });
    if (!shots.length || shots.some((s) => s.needs_rebuild)) {
      // Step one: plan the shots (a model call for changed scenes). Nothing is held or queued in this request.
      const built = await buildShotList({ userId, projectId: project.id, confirm: args.rebuild_token ?? null });
      const targets = built.shots.filter(wantsPicture);
      const total = targets.reduce((n, s) => n + (s.still_credits || 0), 0);
      return {
        project_id: project.id,
        planned: true,
        shots: built.shots.map((s) => shotBrief(s, base)),
        ...(built.length_note ? { length_note: { total_seconds: built.length_note.totalSeconds, target_seconds: built.length_note.targetSeconds } } : {}),
        quote: { total, lines: total ? [{ label: `${targets.length} pictures`, credits: total }] : [], shot_ids: targets.map((s) => s.id) },
        next: total
          ? `The shots are planned. Making their pictures costs ${total} credits: show the customer, then call generate_storyboard again with confirm_total: ${total}.`
          : 'The shots are planned. Their pictures are included: call generate_storyboard again with confirm_total: 0 to start them.',
      };
    }
    // Step two: start the pictures that are missing.
    const targets = shots.filter(wantsPicture);
    if (!targets.length) {
      const making = shots.some((s) => ['still_pending', 'queued', 'generating'].includes(s.status));
      return {
        project_id: project.id,
        shots: shots.map((s) => shotBrief(s, base)),
        status_text: making ? `Pictures are still being made. ${POLL}` : 'Every shot has its picture. Next: get_quote, then generate_video.',
      };
    }
    const total = targets.reduce((n, s) => n + (s.still_credits || 0), 0);
    const lines = total ? [{ label: `${targets.length} pictures`, credits: total }] : [];
    if (confirm === undefined && total > 0) {
      return quoteAnswer({ userId, tool: 'generate_storyboard', projectId: project.id, total, lines, extra: { shot_ids: targets.map((s) => s.id) } });
    }
    if (confirm !== undefined && confirm !== total) {
      throw new ToolError(`Making these pictures now costs ${total} credits. Check it with the customer and confirm again.`, { status: 409, code: 'quote_changed', total, quote: { total, lines } });
    }
    const out = await generateStills({ userId, projectId: project.id, shotIds: targets.map((s) => s.id), expectedCredits: total });
    return {
      project_id: project.id,
      credits: out.charged ?? total,
      started: out.queued?.length ?? 0,
      ...(out.refused?.length ? { not_started: out.refused.map((r) => ({ shot_id: r.shotId, reason: r.reason })) } : {}),
      status_text: `The pictures are being made. ${POLL} Then get_quote and generate_video.`,
    };
  },

  async get_quote({ userId, project, args }) {
    const q = await quoteGeneration({ userId, projectId: project.id, shotIds: shotIdsOf(args) });
    return {
      project_id: project.id,
      quote: { total: q.total, lines: q.lines, shot_ids: q.shotIds },
      balance: await balanceOf(userId),
      next: q.shotIds.length
        ? `Nothing has been charged. If the customer agrees to ${q.total} credits, call generate_video with confirm_total: ${q.total}.`
        : 'There are no clips to make right now.',
    };
  },

  async generate_video({ userId, project, args }) {
    const shotIds = shotIdsOf(args);
    const confirm = confirmOf(args);
    const fresh = async () => {
      const q = await quoteGeneration({ userId, projectId: project.id, shotIds });
      return { total: q.total, lines: q.lines, shot_ids: q.shotIds };
    };
    if (confirm === undefined) {
      const q = await fresh();
      return quoteAnswer({ userId, tool: 'generate_video', projectId: project.id, total: q.total, lines: q.lines, extra: { shot_ids: q.shot_ids } });
    }
    let out;
    try {
      out = await startGeneration({ userId, projectId: project.id, shotIds, confirmTotal: confirm });
    } catch (err) {
      if (err instanceof QuoteChangedError) err.extra.quote = await fresh().catch(() => ({ total: err.extra.total }));
      throw err;
    }
    return {
      project_id: project.id,
      started: true,
      credits: out.charged,
      clips: Array.isArray(out.queued) ? out.queued.length : out.queued,
      status_text: `The video clips are being made. ${POLL} When every shot has its clip, call render.`,
    };
  },

  async get_status({ userId, project, base }) {
    const s = await getProjectStatus({ userId, projectId: project.id });
    const shots = s.shots || [];
    const pending = (s.jobs || []).filter((j) => j.status === 'queued' || j.status === 'running');
    const byKind = {};
    for (const j of pending) byKind[j.kind] = (byKind[j.kind] || 0) + 1;
    let price = null;
    try {
      const p = await priceGeneration(s.project, undefined);
      price = { generate_video: { total: p.total, clips: p.shotIds.length } };
    } catch (err) {
      if (!(err instanceof StoryError)) throw err;
    }
    const reference = await getReference({ userId, projectId: project.id }).catch(() => null);
    const render = renderBrief(s.render, base);
    const counts = {
      total: shots.length,
      with_picture: shots.filter((x) => x.still_url).length,
      with_clip: shots.filter((x) => x.clip_url && x.status === 'ready').length,
      in_progress: shots.filter((x) => ['still_pending', 'queued', 'generating'].includes(x.status)).length,
      failed: shots.filter((x) => x.status === 'failed' || x.status === 'blocked').length,
      needs_rebuild: shots.some((x) => x.needs_rebuild),
    };
    let statusText;
    if (pending.length || render?.status === 'queued' || render?.status === 'running' || reference?.status === 'pending') {
      statusText = `Work is still running (${pending.length} ${pending.length === 1 ? 'job' : 'jobs'}). ${POLL}`;
    } else if (render?.status === 'done') statusText = 'The video is finished. Call get_result for the link.';
    else statusText = `Nothing is running. The project is on the ${s.project.step} step.`;
    return {
      project_id: project.id,
      title: s.project.title,
      step: s.project.step,
      reference: reference ? { status: reference.status, ...(reference.error ? { error: reference.error } : {}) } : null,
      cast: (s.cast || []).map((c) => castBrief(c, base)),
      shots: counts,
      jobs: { pending: pending.length, pending_by_kind: byKind, failed: (s.jobs || []).filter((j) => j.status === 'failed' || j.status === 'blocked').length },
      render: render ? { version: render.version, status: render.status, ...(render.error ? { error: render.error } : {}) } : null,
      price,
      balance: { available: s.balance?.available ?? null },
      status_text: statusText,
    };
  },

  async render({ userId, project }) {
    // startRender returns { render }: the story_renders row.
    const { render } = await startRender({ userId, projectId: project.id });
    return {
      project_id: project.id,
      render: { version: render.version, status: render.status },
      status_text: `The video is being put together. ${POLL} When its render is done, call get_result.`,
    };
  },

  async get_result({ project, base }) {
    const rows = await storyDb().select('story_renders', { project_id: project.id }, { order: '-version', limit: 10 });
    const done = rows.find((r) => r.status === 'done') || null;
    const latest = rows[0] || null;
    return {
      project_id: project.id,
      render: renderBrief(done, base),
      ...(latest && latest !== done ? { newer: { version: latest.version, status: latest.status, ...(latest.error ? { error: latest.error } : {}) } } : {}),
      status_text: done ? 'Share this link with the customer.' : latest ? 'No finished video yet. Poll get_status.' : 'No video has been made yet. Call render when every shot has its clip.',
    };
  },
};

// ---------------------------------------------------------------- runner

/** Runs one tool for the token's user. -> { isError, data }; never throws. */
export async function runMcpTool({ userId, baseUrl = '', name, args }) {
  if (!Object.hasOwn(TOOLS, name)) {
    return { isError: true, data: { error: 'unknown_tool', message: `There is no tool called ${String(name).slice(0, 40)}.` } };
  }
  try {
    const input = args ?? {};
    checkArgs(name, input);
    const project = input.project_id ? await getProject({ userId, id: input.project_id }) : null;
    const data = await TOOLS[name]({ userId, project, args: input, base: baseUrl });
    return { isError: false, data };
  } catch (err) {
    return { isError: true, data: toolError(err) };
  }
}

