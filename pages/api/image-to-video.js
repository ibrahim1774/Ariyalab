import { createKlingSinglePrediction } from '../../lib/kie';
import { createSeedancePrediction } from '../../lib/seedance';
import { getUserFromRequest } from '../../lib/supabaseServer';
import { signingConfigured, signJobId } from '../../lib/jobToken';
import {
  getEntitlement,
  reserveCredits,
  refundCredits,
  trackPendingJob,
  usesLedger,
  takeHoldForJob,
} from '../../lib/entitlement';
import { sendCapiEvent } from '../../lib/meta';
import { nsEventId } from '../../lib/metaKeys';
import { costForGeneration, v2CostForGeneration, MODELS, RESOLUTIONS } from '../../lib/cost';
import { screenText, screenImage, ModerationError, moderationErrorResponse } from '../../lib/moderation';

function isHttpUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function clampDuration(d) {
  const n = Math.round(Number(d));
  if (!Number.isFinite(n)) return 5;
  return Math.max(3, Math.min(15, n));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const session = await getUserFromRequest(req, res);
  if (!session) return res.status(401).json({ error: 'Authentication required.' });

  // The returned job id is signed; refuse before charging if we can't sign.
  if (!signingConfigured()) {
    console.error('[image-to-video] CRON_SECRET missing; refusing');
    return res.status(503).json({ error: 'Generation is temporarily unavailable.' });
  }

  let entitlement;
  try {
    entitlement = await getEntitlement({ supabase: session.supabase, userId: session.user.id, user: session.user });
  } catch (err) {
    return res.status(500).json({ error: `Entitlement check failed: ${err.message}` });
  }

  const {
    imageUrl,
    prompt,
    duration,
    audio,
    model: modelRaw,
    resolution: resolutionRaw,
  } = req.body || {};
  if (!isHttpUrl(imageUrl)) {
    return res.status(400).json({ error: 'imageUrl is required (http/https URL).' });
  }
  const model = MODELS.includes(modelRaw) ? modelRaw : 'standard';
  const resolution = RESOLUTIONS.includes(resolutionRaw) ? resolutionRaw : '480p';
  const wantAudio = Boolean(audio);
  const dur = clampDuration(duration);
  const priced = { seconds: dur, model, resolution, audio: wantAudio };
  // billing_v2 charges v2 credits (lib/cost.js); the legacy path is unchanged.
  const cost = usesLedger(entitlement) ? v2CostForGeneration(priced) : costForGeneration(priced);

  // Pre-filter prompt + image before charging credits.
  try {
    if (prompt) await screenText(prompt);
    await screenImage(imageUrl);
  } catch (err) {
    if (err instanceof ModerationError) return moderationErrorResponse(res, err);
    console.error('[image-to-video] moderation threw', err);
    return res.status(500).json({ error: 'Moderation check failed.' });
  }

  try {
    await reserveCredits(entitlement, cost, { route: 'image-to-video' });
  } catch (err) {
    if (err.code === 'INSUFFICIENT' || err.code === 'NO_PLAN') {
      return res.status(402).json({
        error: 'paywall',
        tier: entitlement.tier,
        creditsRemaining: err.remaining ?? entitlement.creditsRemaining ?? 0,
        cost,
      });
    }
    return res.status(500).json({ error: err.message });
  }

  try {
    let prediction;
    if (model === 'studio-pro') {
      const klingMode = resolution === '1080p' ? 'pro' : 'std';
      prediction = await createKlingSinglePrediction({
        imageUrl,
        prompt: prompt || '',
        duration: dur,
        mode: klingMode,
        audio: wantAudio,
      });
    } else {
      prediction = await createSeedancePrediction({
        imageUrl,
        prompt: prompt || '',
        duration: dur,
        resolution,
        audio: wantAudio,
      });
    }
    trackPendingJob(entitlement, prediction.id, cost).catch(() => {});
    sendCapiEvent({
      eventName: 'Generate',
      eventId: nsEventId(`gen-${prediction.id}`),
      value: cost,
      currency: 'USD',
      email: session.user.email,
      req,
      customData: {
        feature: 'image-to-video',
        credits: cost,
        duration: dur,
        model,
        resolution,
        audio: wantAudio,
        supabase_user_id: session.user.id,
      },
    }).catch(() => {});
    return res.status(200).json({
      predictionId: signJobId(session.user.id, prediction.id, takeHoldForJob(entitlement)),
      vendor: model === 'studio-pro' ? 'kie-kling' : 'kie-seedance',
      status: 'queued',
      cost,
      model,
      resolution,
      audio: wantAudio,
    });
  } catch (err) {
    console.error('[image-to-video] failed; refunding credit', err);
    try { await refundCredits(entitlement, cost); } catch {}
    return res.status(500).json({ error: err.message || 'Image-to-video failed.' });
  }
}
