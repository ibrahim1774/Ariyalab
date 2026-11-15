import { createCharacterFramePrediction } from '../../lib/replicate';
import { getUserFromRequest } from '../../lib/supabaseServer';
import {
  getEntitlement,
  reserveCredits,
  refundCredits,
  settleReservation,
  attachReservation,
  usesLedger,
} from '../../lib/entitlement';
import { sendCapiEvent } from '../../lib/meta';
import { nsEventId } from '../../lib/metaKeys';
import { FACE_SWAP_COST, legacyCreditsToV2 } from '../../lib/cost';
import { signingConfigured, signJobId, signSwapToken } from '../../lib/jobToken';

function isHttpUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

// Face swap = 1 stage-1 character frame on Replicate (~$0.025 nano-banana)
// + 1 stage-2 motion-control video (~$0.10-0.20 Kling v3). At Ariya Lab's
// inflated credit rate (~$0.0013/credit cost), 100 credits ≈ $0.13 of
// underlying cost — covers stage-1 + stage-2 with modest margin.
const COST = FACE_SWAP_COST;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const session = await getUserFromRequest(req, res);
  if (!session) return res.status(401).json({ error: 'Authentication required.' });

  // The job id and swap token are signed; refuse before charging if we can't sign.
  if (!signingConfigured()) {
    console.error('[character-frame] CRON_SECRET missing; refusing');
    return res.status(503).json({ error: 'Face swap is temporarily unavailable.' });
  }

  let entitlement;
  try {
    entitlement = await getEntitlement({
      supabase: session.supabase,
      userId: session.user.id,
      user: session.user,
    });
  } catch (err) {
    return res.status(500).json({ error: `Entitlement check failed: ${err.message}` });
  }
  // billing_v2 charges v2 credits (100 -> 21); the legacy path is unchanged.
  const cost = usesLedger(entitlement) ? legacyCreditsToV2(COST) : COST;

  const { firstFrameUrl, referenceImageUrl, sourceVideoUrl, swapMode, mode: motionModeRaw } = req.body || {};
  // Motion quality for the later /api/swap; bound into the swap token.
  const motionMode = motionModeRaw === 'pro' ? 'pro' : 'std';
  if (!isHttpUrl(firstFrameUrl) || !isHttpUrl(referenceImageUrl) || !isHttpUrl(sourceVideoUrl)) {
    return res.status(400).json({
      error: 'firstFrameUrl, referenceImageUrl and sourceVideoUrl are required (http/https URLs).',
    });
  }
  const mode = swapMode === 'body' ? 'body' : swapMode === 'face' ? 'face' : null;
  if (!mode) {
    return res.status(400).json({ error: "swapMode must be 'face' or 'body'." });
  }

  // Reserve the credit BEFORE creating the prediction. If Replicate
  // refuses to accept the job we refund. After acceptance we hand back
  // the predictionId and let the client poll /api/status — survives
  // tab close because Replicate keeps running on its own.
  try {
    await reserveCredits(entitlement, cost, { route: 'character-frame' });
  } catch (err) {
    if (err.code === 'MIGRATED') return res.status(409).json({ error: err.message, code: 'MIGRATED' });
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

  console.log('[character-frame] creating prediction', { userId: session.user.id, mode });

  try {
    const prediction = await createCharacterFramePrediction({
      firstFrameUrl,
      referenceImageUrl,
      swapMode: mode,
    });
    console.log('[character-frame] prediction created', { id: prediction.id });
    // billing_v2: the provider took the job, so the hold is spent now (the
    // legacy path charged at reserve). A failed settle never fails the job.
    try {
      await attachReservation(entitlement, { provider: 'replicate', jobId: prediction.id });
      await settleReservation(entitlement, prediction.id);
    } catch (settleErr) {
      console.error('[character-frame] settle failed', settleErr);
    }
    sendCapiEvent({
      eventName: 'Generate',
      eventId: nsEventId(`gen-${prediction.id}`),
      value: cost,
      currency: 'USD',
      email: session.user.email,
      req,
      customData: {
        feature: 'face-swap-stage-1',
        credits: cost,
        swap_mode: mode,
        supabase_user_id: session.user.id,
      },
    }).catch(() => {});
    // This is the one place the face-swap flow is charged. The swap
    // token lets /api/swap run (and retry) on this frame for 30 minutes.
    return res.status(200).json({
      predictionId: signJobId(session.user.id, prediction.id),
      status: prediction.status,
      swapToken: signSwapToken({
        userId: session.user.id,
        videoUrl: sourceVideoUrl,
        framePredictionId: prediction.id,
        mode: motionMode,
      }),
    });
  } catch (err) {
    console.error('[character-frame] failed; refunding credit', err);
    try {
      await refundCredits(entitlement, cost);
    } catch (e) {
      console.warn('[character-frame] refund failed', e?.message);
    }
    return res.status(500).json({ error: err.message || 'Image generation failed.' });
  }
}
