import { createHmac, timingSafeEqual } from 'crypto';

/*
 * HMAC-signed values that let routes trust what the browser hands back
 * without a database row. Keyed with CRON_SECRET. Each kind of value
 * signs under its own prefix ("job:" / "swap:") so one can never pass
 * as the other.
 *
 *   signJobId / verifyJobId   prediction ownership for /api/status
 *   signSwapToken / verifySwapToken
 *       proof that /api/character-frame took the face-swap charge, so
 *       /api/swap can run (and retry) without charging again.
 */

const MOCK_SECRET = 'story-mock-signing-secret';
export const SWAP_TOKEN_TTL_MS = 30 * 60 * 1000;

export function signingConfigured() {
  return Boolean(process.env.CRON_SECRET) || process.env.STORY_MOCK === '1';
}

function secret() {
  const value = process.env.CRON_SECRET;
  if (value) return value;
  if (process.env.STORY_MOCK === '1') return MOCK_SECRET;
  throw new Error('CRON_SECRET is not set; refusing to sign or verify.');
}

function hmac(message) {
  return createHmac('sha256', secret()).update(message).digest('base64url');
}

function sameSig(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// Splits "<value>.<sig>" on the LAST dot (ids may contain dots).
function splitSigned(signed) {
  if (typeof signed !== 'string') return null;
  const i = signed.lastIndexOf('.');
  if (i <= 0 || i === signed.length - 1) return null;
  return { value: signed.slice(0, i), sig: signed.slice(i + 1) };
}

export function signJobId(userId, predictionId) {
  return `${predictionId}.${hmac(`job:${userId}:${predictionId}`)}`;
}

/** Returns the raw prediction id, or null when missing/forged/another user's. */
export function verifyJobId(userId, signed) {
  if (!userId || !signingConfigured()) return null;
  const parts = splitSigned(signed);
  if (!parts) return null;
  return sameSig(parts.sig, hmac(`job:${userId}:${parts.value}`)) ? parts.value : null;
}

export function signSwapToken({ userId, videoUrl, framePredictionId, now = Date.now() }) {
  const payload = Buffer.from(
    JSON.stringify({ u: userId, v: videoUrl, f: framePredictionId, exp: now + SWAP_TOKEN_TTL_MS })
  ).toString('base64url');
  return `${payload}.${hmac(`swap:${payload}`)}`;
}

/**
 * Returns { framePredictionId, exp } when the token is genuine, unexpired,
 * and was issued to this user for this video. Otherwise null.
 */
export function verifySwapToken(token, { userId, videoUrl }) {
  if (!userId || !signingConfigured()) return null;
  const parts = splitSigned(token);
  if (!parts || !sameSig(parts.sig, hmac(`swap:${parts.value}`))) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts.value, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || payload.u !== userId || payload.v !== videoUrl) return null;
  if (typeof payload.exp !== 'number' || Date.now() > payload.exp) return null;
  if (typeof payload.f !== 'string' || !payload.f) return null;
  return { framePredictionId: payload.f, exp: payload.exp };
}
