import { v4 as uuidv4 } from 'uuid';

import { createJob, updateJob } from '../../lib/jobs';
import { createMotionTransferPrediction, getPrediction, normalizeStatus } from '../../lib/replicate';
import { getUserFromRequest } from '../../lib/supabaseServer';
import { screenImage, ModerationError, moderationErrorResponse } from '../../lib/moderation';
import { signingConfigured, verifySwapToken, signJobId } from '../../lib/jobToken';
import { getEntitlement, getSwapUse, recordSwapUse } from '../../lib/entitlement';

// One character-frame charge covers at most this many motion-transfer
// jobs, and a new one only starts after the previous one failed.
const MAX_SWAPS_PER_FRAME = 3;

function isHttpUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

// Returns the verified token ({ framePredictionId, mode }) or null.
async function verifySwapCharge({ swapToken, userId, videoUrl, imageUrl }) {
  const token = verifySwapToken(swapToken, { userId, videoUrl });
  if (!token) return null;
  try {
    const frame = normalizeStatus(await getPrediction(token.framePredictionId));
    return frame.status === 'complete' && frame.resultUrl === imageUrl ? token : null;
  } catch (err) {
    console.warn('[swap] frame lookup failed', err.message);
    return null;
  }
}

// Has the previous swap for this frame ended in failure? Any doubt
// (still running, succeeded, lookup failed) counts as "no".
async function previousSwapFailed(swapId) {
  try {
    return normalizeStatus(await getPrediction(swapId)).status === 'error';
  } catch (err) {
    console.warn('[swap] previous swap lookup failed', err.message);
    return false;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const jobId = uuidv4();

  const session = await getUserFromRequest(req, res);
  if (!session) return res.status(401).json({ error: 'Authentication required.' });

  // Fail closed: without the signing secret we cannot check the charge
  // token, so we refuse rather than run an unpaid swap.
  if (!signingConfigured()) {
    console.error('[swap] CRON_SECRET missing; refusing');
    return res.status(503).json({ error: 'Face swap is temporarily unavailable.' });
  }

  try {
    const {
      imageUrl,
      videoUrl,
      videoFileName,
      faceFileName,
      swapToken,
    } = req.body || {};

    if (!isHttpUrl(imageUrl) || !isHttpUrl(videoUrl)) {
      return res.status(400).json({
        error: 'imageUrl (character image) and videoUrl (motion video) are required.',
      });
    }

    // No credit charge here. /api/character-frame takes FACE_SWAP_COST
    // once and returns a swapToken bound to this user, the source video
    // and its frame prediction. The token is reusable for 30 minutes so
    // retries and resume stay free; imageUrl must be that paid frame's
    // output, so the token cannot drive a swap on some other image.
    const paid = await verifySwapCharge({ swapToken, userId: session.user.id, videoUrl, imageUrl });
    if (!paid) {
      return res.status(402).json({
        error: 'paywall',
        code: 'SWAP_TOKEN_INVALID',
        message: 'This swap is not paid for, or the preview expired. Generate a new preview.',
      });
    }

    // Replay guard. The token is reusable, so record each motion job
    // started for this frame. While the last one is running or done,
    // hand back its id instead of starting (and paying for) another.
    let entitlement;
    let use;
    try {
      entitlement = await getEntitlement({
        supabase: session.supabase,
        userId: session.user.id,
        email: session.user.email,
      });
      use = await getSwapUse(entitlement, paid.framePredictionId);
    } catch (err) {
      console.error('[swap] use record lookup failed', err);
      return res.status(503).json({ error: 'Face swap is temporarily unavailable.' });
    }
    if (use && !(await previousSwapFailed(use.swapId))) {
      return res.status(200).json({
        jobId,
        predictionId: signJobId(session.user.id, use.swapId),
        status: 'processing',
        reused: true,
      });
    }
    if (use && use.count >= MAX_SWAPS_PER_FRAME) {
      return res.status(402).json({
        error: 'paywall',
        code: 'SWAP_RETRY_LIMIT',
        message: 'This preview has used all its retries. Start a new swap.',
      });
    }

    // Moderate the face image. videoUrl is a motion clip — we trust
    // those (face-swap doesn't surface the source video to the output).
    try {
      await screenImage(imageUrl);
    } catch (err) {
      if (err instanceof ModerationError) return moderationErrorResponse(res, err);
      console.error('[swap] moderation threw', err);
      return res.status(500).json({ error: 'Moderation check failed.' });
    }

    // Mode comes from the token (chosen before the charge), never the body.
    const safeMode = paid.mode;

    createJob({
      jobId,
      status: 'queued',
      videoFileName: videoFileName || 'motion.mp4',
      faceFileName: faceFileName || 'character.jpg',
      mode: safeMode,
    });

    updateJob(jobId, { status: 'processing' });

    console.log('[swap] creating prediction', {
      jobId,
      userId: session.user.id,
      mode: safeMode,
    });

    const prediction = await createMotionTransferPrediction({
      imageUrl,
      videoUrl,
      mode: safeMode,
      characterOrientation: 'video',
    });
    const normalized = normalizeStatus(prediction);

    try {
      await recordSwapUse(entitlement, paid.framePredictionId, prediction.id, (use?.count || 0) + 1);
    } catch (err) {
      // The job is already running; don't fail the response over it.
      console.error('[swap] could not record swap use', err);
    }

    console.log('[swap] prediction created', {
      jobId,
      predictionId: prediction.id,
      status: prediction.status,
    });

    updateJob(jobId, {
      predictionId: prediction.id,
      status: normalized.status === 'queued' ? 'processing' : normalized.status,
    });

    return res.status(200).json({
      jobId,
      predictionId: signJobId(session.user.id, prediction.id),
      status: 'processing',
    });
  } catch (err) {
    updateJob(jobId, {
      status: 'error',
      error: err.message || 'Unknown error',
    });
    return res.status(500).json({
      jobId,
      error: err.message || 'Generation failed to start.',
    });
  }
}
