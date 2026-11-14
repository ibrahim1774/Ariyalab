/*
 * kie.ai API client for Kling 3.0 video generation.
 *
 * Endpoints discovered from probing + docs:
 *   POST https://api.kie.ai/api/v1/jobs/createTask
 *     body: { model, input, callBackUrl? }
 *     response: { code: 200, msg, data: { taskId, recordId } }
 *   GET  https://api.kie.ai/api/v1/jobs/recordInfo?taskId=...
 *     response: { code: 200, msg, data: {
 *       taskId, model, state, resultJson, failCode, failMsg, completeTime
 *     }}
 *
 * Observed `state` values: "waiting" | "generating" | "success" | "fail"
 * (polled live during development — worth confirming all four on real jobs).
 */

// Legacy tools read these constants. The story pipeline reads the same values
// from lib/providers/config.js (PROVIDER_CONFIG.kie, MODEL_IDS.video); keep
// the two in step.
const KIE_BASE = 'https://api.kie.ai/api/v1';
const KLING_MODEL = 'kling-3.0/video';

function apiKey() {
  const k = process.env.KIE_API_KEY;
  if (!k) throw new Error('KIE_API_KEY is not set. Add it to .env.local.');
  return k;
}

async function kiePost(path, body) {
  const res = await fetch(`${KIE_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { code: res.status, msg: text }; }
  if (!res.ok || data.code !== 200) {
    const msg = data?.msg || `kie.ai request failed (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    err.kieCode = data?.code;
    throw err;
  }
  return data.data;
}

async function kieGet(path) {
  const res = await fetch(`${KIE_BASE}${path}`, {
    headers: { 'Authorization': `Bearer ${apiKey()}` },
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { code: res.status, msg: text }; }
  if (!res.ok || data.code !== 200) {
    const err = new Error(data?.msg || `kie.ai request failed (${res.status})`);
    err.status = res.status;
    err.kieCode = data?.code;
    throw err;
  }
  return data.data;
}

function clampKlingDuration(d, min = 3, max = 15) {
  const n = Math.round(Number(d));
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

/**
 * Build the `input` object for a single-shot Kling 3.0 task.
 *
 *   mode      'std' (720p) | 'pro' (1080p)
 *   sound     native audio on/off (priced differently by kie.ai)
 *   elements  optional character elements, each
 *             { name, description, imageUrls: [2-4 image urls] }, sent as
 *             kling_elements (max 3) and referenced in the prompt as @name.
 *
 * `duration` is passed through as a string; callers clamp it (3-15).
 */
export function buildKlingInput({
  imageUrl,
  prompt = '',
  duration = 5,
  mode = 'std',
  sound = true,
  aspectRatio = '9:16',
  elements,
}) {
  const input = {
    prompt: (prompt || '').trim() || 'natural motion',
    image_urls: imageUrl ? [imageUrl] : [],
    duration: String(duration),
    aspect_ratio: aspectRatio,
    mode: mode === 'pro' ? 'pro' : 'std',
    sound: Boolean(sound),
    multi_shots: false,
  };
  if (Array.isArray(elements) && elements.length > 0) {
    input.kling_elements = elements.map((e) => ({
      name: e.name,
      description: e.description || e.name,
      element_input_urls: e.imageUrls,
    }));
  }
  return input;
}

/** Create any kie.ai jobs task. callBackUrl is optional. -> { taskId, raw } */
export async function createKieTask({ model, input, callBackUrl }) {
  const body = { model, input };
  if (callBackUrl) body.callBackUrl = callBackUrl;
  const data = await kiePost('/jobs/createTask', body);
  return { taskId: data?.taskId, raw: data };
}

/** Fetch a kie.ai jobs task record (same as getKiePrediction). */
export async function getKieTask(taskId) {
  return kieGet(`/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`);
}

/**
 * Kick off a single-scene Kling 3.0 generation.
 * Returns { id } matching the shape /api/status expects.
 * callBackUrl and elements are optional additions for the story pipeline.
 */
export async function createKlingSinglePrediction({
  imageUrl,
  prompt = '',
  duration = 5,
  mode = 'std',
  audio = true,
  aspectRatio = '9:16',
  callBackUrl,
  elements,
}) {
  const input = buildKlingInput({
    imageUrl,
    prompt,
    duration: clampKlingDuration(duration),
    mode,
    sound: audio,
    aspectRatio,
    elements,
  });
  const body = { model: KLING_MODEL, input };
  if (callBackUrl) body.callBackUrl = callBackUrl;
  const data = await kiePost('/jobs/createTask', body);
  return { id: data.taskId, raw: data };
}

/**
 * Kick off a multi-shot storyboard Kling 3.0 generation.
 * scenes = [{ prompt, duration }, ...] with up to 5 shots per kie.ai's limit.
 * Per-shot duration is an integer 1-12 seconds.
 */
export async function createKlingStoryboardPrediction({
  imageUrl,
  scenes,
  mode = 'std',
  audio = true,
  aspectRatio = '9:16',
  callBackUrl,
}) {
  if (!Array.isArray(scenes) || scenes.length === 0) {
    throw new Error('At least one scene is required.');
  }
  if (scenes.length > 5) {
    throw new Error('Storyboard supports up to 5 scenes.');
  }
  const multi = scenes.map((s) => ({
    prompt: (s.prompt || '').trim().slice(0, 500) || 'moves naturally',
    duration: Math.max(1, Math.min(12, Math.round(Number(s.duration) || 3))),
  }));
  const totalDur = multi.reduce((a, s) => a + s.duration, 0);
  const input = {
    // Top-level prompt is still required by kie.ai even in multi-shot mode;
    // use the concatenated scene prompts as a reasonable summary.
    prompt: multi.map((m) => m.prompt).join(' '),
    image_urls: imageUrl ? [imageUrl] : [],
    duration: String(clampKlingDuration(totalDur)),
    aspect_ratio: aspectRatio,
    mode: mode === 'pro' ? 'pro' : 'std',
    sound: Boolean(audio),
    multi_shots: true,
    multi_prompt: multi,
  };
  const body = { model: KLING_MODEL, input };
  if (callBackUrl) body.callBackUrl = callBackUrl;
  const data = await kiePost('/jobs/createTask', body);
  return { id: data.taskId, raw: data };
}

/** Fetch the current state of a kie.ai task by id. */
export async function getKiePrediction(taskId) {
  return kieGet(`/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`);
}

/**
 * First result URL from a kie.ai `resultJson` (a JSON string or object).
 * Seen shapes across kie.ai models: { videoUrl }, { video_url },
 * { resultUrls: [] }, { videos: [{ url }] | [url] }, { url }. Shared with
 * lib/providers/kieTasks.js. Returns null when none is found or unparseable.
 */
export function kieResultUrl(resultJson) {
  if (!resultJson) return null;
  try {
    const parsed = typeof resultJson === 'string' ? JSON.parse(resultJson) : resultJson;
    return (
      parsed?.videoUrl ||
      parsed?.video_url ||
      (Array.isArray(parsed?.resultUrls) ? parsed.resultUrls[0] : null) ||
      (Array.isArray(parsed?.videos) ? parsed.videos[0]?.url || parsed.videos[0] : null) ||
      parsed?.url ||
      null
    );
  } catch {
    // unparseable: status stays 'complete' but resultUrl is null, which the
    // client treats as an error surfaced in the UI.
    return null;
  }
}

/**
 * Map a kie.ai recordInfo payload onto the app's internal shape
 *   { status: 'queued'|'processing'|'complete'|'error', resultUrl, error }
 * — matching normalizeStatus in lib/replicate.js so clients are agnostic.
 */
export function normalizeKieStatus(record) {
  if (!record) return { status: 'queued', resultUrl: null, error: null };
  const state = String(record.state || '').toLowerCase();

  let status = 'processing';
  if (state === 'waiting' || state === 'queued' || state === 'pending') status = 'queued';
  else if (state === 'success' || state === 'succeed' || state === 'completed') status = 'complete';
  else if (state === 'fail' || state === 'failed' || state === 'error') status = 'error';

  const resultUrl = status === 'complete' ? kieResultUrl(record.resultJson) : null;

  let error = null;
  if (status === 'error') {
    const raw = `${record.failMsg || ''} ${record.failCode || ''}`.toLowerCase();
    // Map Kling moderation rejections to a clear, user-friendly
    // message. Covers the variants we've seen across kie.ai/Kling:
    // "sensitive", "nsfw", "explicit", "porn", "sexual", "minor",
    // "child", "kid", "underage", and the generic "moderation"/
    // "policy"/"prohibited" buckets — all of which are content-safety
    // refusals from the model and not retryable.
    const isModeration =
      /sensitive|nsfw|explicit|porn|sexual|moderation|policy|prohibit|forbidden|inappropriate/.test(raw);
    const isMinor = /minor|child|kid|underage|teen|toddler|baby|infant/.test(raw);
    if (isModeration || isMinor) {
      error = "AI model doesn't allow sexual content or anything related to kids.";
    } else {
      error = record.failMsg || record.failCode || 'Generation failed.';
    }
  }

  return { status, resultUrl, error };
}
