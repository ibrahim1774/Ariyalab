import { put } from '@vercel/blob';

import { getUserFromRequest } from '../../lib/supabaseServer';
import {
  getImageEntitlement,
  reserveImageCredit,
  settleImageCredit,
  refundImageCredit,
  IMAGE_REFILL,
} from '../../lib/entitlement';
import { sendCapiEvent } from '../../lib/meta';
import { nsEventId } from '../../lib/metaKeys';
import { screenText, screenImage, ModerationError, moderationErrorResponse } from '../../lib/moderation';

/*
 * Glow-Up generation endpoint.
 *
 * Architecture choices:
 *   - Auth: Supabase via getUserFromRequest (matches every other API
 *     route in the project; no NextAuth dependency).
 *   - Entitlement: the shared image-credit entitlement in lib/entitlement.js
 *     (getImageEntitlement / reserveImageCredit / settleImageCredit /
 *     refundImageCredit). Image credits are a pool apart from video
 *     credits and the two never mix: the ledger's 'image' currency under
 *     billing_v2, `ariyalab_image_credits` in Stripe metadata otherwise.
 *   - Pool refill: 30 image credits every 30 days for any active sub
 *     (monthly OR yearly). A refill never wipes purchased image packs.
 *   - Image gen: Nano Banana Pro (Google Gemini 3 Pro Image) via kie.ai's
 *     unified jobs API (POST /api/v1/jobs/createTask, polled via
 *     /jobs/recordInfo). input.image_input accepts up to 8 reference URLs,
 *     so all 1–5 user photos are passed in unchanged — no multipart upload
 *     needed since the photos already live on Vercel Blob. (Replaced the 4o
 *     endpoint, which hung in GENERATING for minutes without completing.)
 *   - Output: kie.ai returns a CDN URL; we download it and re-upload
 *     to Vercel Blob via put() so the user gets a stable URL on our
 *     infra (and the download button keeps working long-term).
 *
 * GET returns the user's current glow-up credit status (used by the
 * page UI to show the remaining counter).
 * POST runs the full generation flow.
 */

const KIE_BASE = 'https://api.kie.ai/api/v1';
// Nano Banana Pro (Google Gemini 3 Pro Image) via kie.ai's unified jobs API.
// Replaces 4o / gpt-image-1, which accepted the task then hung in GENERATING
// for 4+ min without ever completing (confirmed in prod logs). Pro is fast,
// reliable, and purpose-built for identity-preserving edits from reference
// photos, and accepts multiple input images (our 1–5 photo flow).
const KIE_CREATE_PATH = '/jobs/createTask';
const KIE_RECORD_PATH = '/jobs/recordInfo';
const KIE_MODEL = 'nano-banana-pro';
// 2K is a strong quality/speed/cost balance; kie.ai also supports '4K'.
const KIE_RESOLUTION = '2K';

// Max time we'll block the request waiting for kie.ai to finish. Nano Banana
// Pro usually resolves in well under a minute; we keep 240s of headroom and
// leave the rest of the 300s function budget for mirroring the result to Blob.
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 240 * 1000;

// Prompt the model receives in 'edit' mode. The first image in
// image_input is the previously-generated portrait (the primary edit
// subject) and the rest are the user's original reference photos for
// identity anchoring.
const EDIT_PROMPT_PREFIX =
  "You are given the most recent AI-generated portrait of a person, followed by reference photos of the same person. CRITICAL: Keep the person's face, facial structure, skin tone, eye color, and identity absolutely identical to the references — do NOT alter the face. Apply the following user-requested edit while preserving the realism, lighting quality, and overall premium portrait look:";

// Sanitize and truncate user-provided text before injecting it into a
// prompt sent to the model. Strips control chars, collapses whitespace,
// and caps length so a hostile or runaway input can't blow out the
// total prompt size.
function safePromptFragment(s, max = 400) {
  if (typeof s !== 'string') return '';
  // Filter ASCII control chars (0-31, 127) by codepoint instead of a
  // regex literal to keep the source ASCII-clean. Collapses whitespace
  // and caps length so user input can't bloat the kie.ai prompt.
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += c < 32 || c === 127 ? ' ' : s[i];
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, max);
}

const PROMPTS = {
  professional:
    "You are given reference photos of a person. Generate an ultra-realistic 4K professional corporate headshot. CRITICAL: Keep the person's face, facial structure, skin tone, eye color, and identity absolutely identical. Apply: soft studio lighting with a 45-degree key light and subtle fill, clean neutral background slightly blurred, professional business attire, ultra-sharp focus on eyes, 85mm portrait lens perspective, eye-level shot. Must look like it was shot by a professional photographer for a Fortune 500 LinkedIn profile.",
  casual:
    "You are given reference photos of a person. Generate an ultra-realistic lifestyle portrait. CRITICAL: Keep the person's face, facial structure, skin tone, eye color, and identity absolutely identical. Apply: warm natural light or golden hour lighting, smart-casual clothing, clean blurred lifestyle background, genuine relaxed expression. Should feel authentic and approachable — perfect for social media.",
  'glow-up':
    "You are given reference photos of a person. Generate an ultra-realistic beauty portrait glow-up. CRITICAL: Keep the person's face shape, features, skin tone, eye color, and identity absolutely identical — do NOT alter the face. Apply: professional makeup artistry, radiant healthy skin (not plastic), soft butterfly beauty lighting with subtle rim light, perfectly styled hair. The person should look like the most polished and confident version of themselves.",
  soar:
    "You are given reference photos of a person. Generate an ultra-realistic cinematic editorial portrait. CRITICAL: Keep the person's face, features, skin tone, eye color, and identity absolutely identical. Apply: dramatic Rembrandt lighting with deep shadows and highlights, commanding confident expression, editorial magazine cover aesthetic, desaturated filmic color grade, 50mm lens from a slight upward angle. Should look like a Forbes or luxury brand cover shoot.",
};

export const config = {
  api: { bodyParser: { sizeLimit: '1mb' } },
  // This route blocks up to POLL_TIMEOUT_MS (120s) waiting on kie.ai. Without
  // an explicit maxDuration Vercel kills the function at the low plan default,
  // so any generation past ~the typical 15–45s returns "Generation failed"
  // even though the image is still being made. 300s matches video/render.js
  // and gives the 120s poll budget full headroom.
  maxDuration: 300,
};

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.setHeader('Allow', 'POST, GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const session = await getUserFromRequest(req, res);
  if (!session) return res.status(401).json({ error: 'Sign in first.' });

  // Shared entitlement (lib/entitlement.js): image credits are the ledger's
  // 'image' currency under billing_v2, Stripe metadata otherwise.
  let entitlement;
  try {
    entitlement = await getImageEntitlement({
      supabase: session.supabase,
      userId: session.user.id,
      user: session.user,
    });
  } catch (err) {
    console.error('[glow-up] entitlement failed', err);
    return res.status(500).json({ error: 'Entitlement check failed.' });
  }
  const isAdmin = Boolean(entitlement.isAdmin);

  if (req.method === 'GET') {
    return res.status(200).json({
      tier: entitlement.tier,
      status: entitlement.status,
      imageCreditsRemaining: entitlement.imageCreditsRemaining,
      imagePeriodStart: entitlement.imagePeriodStart,
      periodCap: IMAGE_REFILL,
    });
  }

  // POST — validate body up front. Two modes:
  //   - default ('generate'): style + 1–4 reference photos + optional extraPrompt
  //   - 'edit': editPrompt + 1–5 imageUrls (first = previously-generated, rest = originals)
  const body = req.body || {};
  const mode = body.mode === 'edit' ? 'edit' : 'generate';
  const imageUrls = Array.isArray(body.imageUrls) ? body.imageUrls : [];
  const maxRefs = mode === 'edit' ? 5 : 4;
  if (imageUrls.length === 0 || imageUrls.length > maxRefs) {
    return res.status(400).json({ error: `Provide 1–${maxRefs} imageUrls.` });
  }
  for (const u of imageUrls) {
    if (typeof u !== 'string' || !u.startsWith('https://')) {
      return res.status(400).json({ error: 'Invalid image URL.' });
    }
  }

  let kiePrompt;
  if (mode === 'edit') {
    const editFragment = safePromptFragment(body.editPrompt, 400);
    if (!editFragment) {
      return res.status(400).json({ error: 'editPrompt is required for edit mode.' });
    }
    kiePrompt = `${EDIT_PROMPT_PREFIX} ${editFragment}`;
  } else {
    if (!PROMPTS[body.style]) {
      return res.status(400).json({ error: 'Invalid style.' });
    }
    const extra = safePromptFragment(body.extraPrompt, 400);
    kiePrompt = extra
      ? `${PROMPTS[body.style]} Additional user direction (incorporate without breaking the CRITICAL identity rules above): ${extra}`
      : PROMPTS[body.style];
  }

  // Content moderation BEFORE credit gate. Screen the user-supplied
  // prompt fragment (editPrompt or extraPrompt) and every reference
  // image they uploaded. screenImage is cached so re-using the same
  // image across edit iterations short-circuits.
  try {
    const userText = mode === 'edit' ? body.editPrompt : body.extraPrompt;
    if (userText) await screenText(userText);
    for (const u of imageUrls) {
      await screenImage(u);
    }
  } catch (err) {
    if (err instanceof ModerationError) return moderationErrorResponse(res, err);
    console.error('[glow-up] moderation threw', err);
    return res.status(500).json({ error: 'Moderation check failed.' });
  }

  if (!isAdmin && (entitlement.tier === 'none' || !entitlement.activeSub)) {
    return res.status(402).json({ error: 'paywall' });
  }

  // Image credits only — no fallback to the video credit pool. Reserved
  // BEFORE calling kie.ai so concurrent calls can't double-spend; refunded on
  // every failure path below.
  let creditReserved = false;
  if (!isAdmin) {
    try {
      creditReserved = await reserveImageCredit(entitlement, { route: 'glow-up' });
    } catch (mdErr) {
      console.warn('[glow-up] credit reserve failed', mdErr.message);
      return res.status(500).json({ error: 'Could not reserve credit.' });
    }
    if (!creditReserved) {
      return res.status(402).json({ error: 'paywall', reason: 'image-credits-exhausted' });
    }
  }

  const kieKey = process.env.KIE_API_KEY;
  if (!kieKey) {
    if (creditReserved) await refundImageCredit(entitlement);
    return res.status(500).json({ error: 'KIE_API_KEY is not configured.' });
  }

  const startedAt = Date.now();
  try {
    // 1. Create the Nano Banana Pro task via kie.ai's unified jobs API.
    const createRes = await fetch(`${KIE_BASE}${KIE_CREATE_PATH}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${kieKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: KIE_MODEL,
        input: {
          prompt: kiePrompt,
          // Reference photos for identity preservation (Pro accepts up to 8).
          image_input: imageUrls.slice(0, 8),
          aspect_ratio: '1:1',
          resolution: KIE_RESOLUTION,
          output_format: 'png',
        },
      }),
    });
    const createText = await createRes.text();
    let createData;
    try {
      createData = JSON.parse(createText);
    } catch {
      createData = { code: createRes.status, msg: createText };
    }
    if (!createRes.ok || createData.code !== 200 || !createData.data?.taskId) {
      console.error('[glow-up] kie.ai create failed', createRes.status, createText.slice(0, 500));
      if (creditReserved) await refundImageCredit(entitlement);
      return res.status(502).json({ error: createData?.msg || 'Image generation failed.' });
    }
    const taskId = createData.data.taskId;
    console.log('[glow-up] task created', JSON.stringify({ taskId, mode, createMs: Date.now() - startedAt }));

    // 2. Poll recordInfo until state success, fail, or timeout.
    // Diagnostic tracking so a no-result failure is not a black box: we
    // record how many times we polled, the last state kie.ai reported, and
    // a snippet of its last raw response (which carries failCode/failMsg).
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let resultUrl = null;
    let lastErr = null;
    let pollCount = 0;
    let lastStatus = null;
    let lastRecCode = null;
    let lastRecSnippet = null;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      const recRes = await fetch(
        `${KIE_BASE}${KIE_RECORD_PATH}?taskId=${encodeURIComponent(taskId)}`,
        { headers: { Authorization: `Bearer ${kieKey}` } }
      );
      const recText = await recRes.text();
      pollCount += 1;
      lastRecSnippet = recText.slice(0, 800);
      let rec;
      try {
        rec = JSON.parse(recText);
      } catch {
        continue; // transient parse error — keep polling
      }
      lastRecCode = rec.code;
      if (rec.code !== 200) continue;
      // jobs API state: waiting | queuing | generating | success | fail
      const state = String(rec.data?.state || '').toLowerCase();
      lastStatus = state;
      if (state === 'success') {
        // resultJson is a JSON *string* -> { resultUrls: [ ... ] }
        let urls = null;
        try {
          const parsed = JSON.parse(rec.data?.resultJson || '{}');
          urls = parsed?.resultUrls;
        } catch {
          urls = null;
        }
        resultUrl = Array.isArray(urls) && urls.length > 0 ? urls[0] : null;
        break;
      }
      if (state === 'fail') {
        lastErr = rec.data?.failMsg || 'Image generation failed.';
        break;
      }
      // status is GENERATING / unknown — keep polling.
    }

    if (!resultUrl) {
      const timedOut = Date.now() >= deadline;
      // Make the no-result failure diagnosable: distinguish an actual timeout
      // (kie.ai never reached a terminal status) from kie.ai reporting a
      // failure, and log its raw last response so we can see the real reason.
      console.error(
        '[glow-up] no result',
        JSON.stringify({
          taskId,
          mode,
          elapsedMs: Date.now() - startedAt,
          pollCount,
          lastStatus,
          lastRecCode,
          timedOut,
          lastErr,
          lastRec: lastRecSnippet,
        })
      );
      if (creditReserved) await refundImageCredit(entitlement);
      const clientError = lastErr
        ? lastErr
        : timedOut
        ? 'Image generation timed out.'
        : 'Image generation failed.';
      return res.status(502).json({ error: clientError });
    }

    // The image exists: spend the held credit (billing_v2; the legacy path
    // charged at reserve). A failed settle never fails the generation.
    try {
      await settleImageCredit(entitlement, taskId);
    } catch (settleErr) {
      console.error('[glow-up] settle failed', settleErr);
    }

    // 3. Re-upload kie.ai's CDN result to our own Blob store so the
    // download URL is stable and on our infra.
    let storedUrl;
    try {
      const dlRes = await fetch(resultUrl);
      if (!dlRes.ok) throw new Error(`Could not fetch generated image (${dlRes.status}).`);
      const ab = await dlRes.arrayBuffer();
      const ct = dlRes.headers.get('content-type') || 'image/png';
      const ext = ct.includes('jpeg') || ct.includes('jpg') ? 'jpg' : 'png';
      const stored = await put(`glow-up/${Date.now()}.${ext}`, Buffer.from(ab), {
        access: 'public',
        contentType: ct,
        addRandomSuffix: true,
      });
      storedUrl = stored.url;
    } catch (mirrorErr) {
      // If mirroring fails we still have a usable kie.ai URL; serve
      // that rather than refunding the user. Log it for visibility.
      console.warn('[glow-up] mirror upload failed; serving kie.ai URL', mirrorErr.message);
      storedUrl = resultUrl;
    }

    // Server-side CAPI Generate event — same shape as
    // /api/ugc-image and /api/ugc-animate so Meta's reporting groups
    // all generation events together. Best-effort: a CAPI failure
    // never blocks returning the result.
    sendCapiEvent({
      eventName: 'Generate',
      eventId: nsEventId(`gen-glow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
      value: 1,
      currency: 'USD',
      email: session.user.email,
      req,
      customData: {
        feature: mode === 'edit' ? 'glow-up-edit' : 'glow-up',
        credits: 1,
        style: mode === 'edit' ? undefined : body.style,
        supabase_user_id: session.user.id,
      },
    }).catch(() => {});

    return res.status(200).json({
      imageUrl: storedUrl,
      imageCreditsRemaining: isAdmin ? 9999 : entitlement.imageCreditsRemaining,
    });
  } catch (err) {
    console.error('[glow-up] failed', err);
    if (creditReserved) await refundImageCredit(entitlement);
    return res.status(500).json({ error: err.message || 'Generation failed.' });
  }
}
