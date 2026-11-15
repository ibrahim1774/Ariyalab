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

// Fallback key for the test runner only (vitest sets NODE_ENV=test).
// STORY_MOCK alone is not enough: it doesn't mock Replicate/kie/Stripe,
// so a mock-mode deploy must still use a real CRON_SECRET.
const TEST_SECRET = 'test-only-signing-secret';
export const SWAP_TOKEN_TTL_MS = 30 * 60 * 1000;
const SWAP_MODES = ['std', 'pro'];

export function signingConfigured() {
  return Boolean(process.env.CRON_SECRET) || process.env.NODE_ENV === 'test';
}

function secret() {
  const value = process.env.CRON_SECRET;
  if (value) return value;
  if (process.env.NODE_ENV === 'test') return TEST_SECRET;
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

/*
 * A job id may also carry the billing_v2 hold that pays for it
 * (lib/entitlement.js): "<id>~<holdId>~<amount>~<route>", signed under its
 * own prefix ("jobh:"). /api/status settles or releases that hold when the
 * job ends, so the hold needs no database row or Stripe metadata entry.
 */
const HOLD_SEP = '~';
const HOLD_ROUTE = /^[a-z0-9-]{1,40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function signJobId(userId, predictionId, hold = null) {
  if (hold) {
    const { holdId, amount, route } = hold;
    if (!UUID.test(String(holdId)) || !Number.isInteger(amount) || amount <= 0 || !HOLD_ROUTE.test(String(route))) {
      throw new TypeError('invalid hold for a job id');
    }
    const value = [predictionId, holdId, amount, route].join(HOLD_SEP);
    return `${value}.${hmac(`jobh:${userId}:${value}`)}`;
  }
  return `${predictionId}.${hmac(`job:${userId}:${predictionId}`)}`;
}

/**
 * { predictionId, hold } for a genuine job id of this user (hold is
 * { holdId, amount, route } or null), else null.
 */
export function verifyJobToken(userId, signed) {
  if (!userId || !signingConfigured()) return null;
  const parts = splitSigned(signed);
  if (!parts) return null;
  if (sameSig(parts.sig, hmac(`job:${userId}:${parts.value}`))) return { predictionId: parts.value, hold: null };
  if (!sameSig(parts.sig, hmac(`jobh:${userId}:${parts.value}`))) return null;
  const fields = parts.value.split(HOLD_SEP);
  if (fields.length < 4) return null;
  const [holdId, amount, route] = fields.slice(-3);
  const predictionId = fields.slice(0, -3).join(HOLD_SEP);
  if (!predictionId) return null;
  return { predictionId, hold: { holdId, amount: Number(amount), route } };
}

/** Returns the raw prediction id, or null when missing/forged/another user's. */
export function verifyJobId(userId, signed) {
  return verifyJobToken(userId, signed)?.predictionId ?? null;
}

export function signSwapToken({ userId, videoUrl, framePredictionId, mode = 'std', now = Date.now() }) {
  const m = SWAP_MODES.includes(mode) ? mode : 'std';
  const payload = Buffer.from(
    JSON.stringify({ u: userId, v: videoUrl, f: framePredictionId, m, exp: now + SWAP_TOKEN_TTL_MS })
  ).toString('base64url');
  return `${payload}.${hmac(`swap:${payload}`)}`;
}

/**
 * Returns { framePredictionId, mode, exp } when the token is genuine, unexpired,
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
  if (!SWAP_MODES.includes(payload.m)) return null;
  return { framePredictionId: payload.f, mode: payload.m, exp: payload.exp };
}

/**
 * Pay-first claim cookie: a signed list of this browser's most recent claim
 * nonces, newest first, each with the time it was issued. Every checkout
 * appends a FRESH nonce (a session's ticket is never derived from an incoming
 * cookie), so a cookie planted by someone else only adds nonces they know to
 * the list; the new session still uses one they have never seen. An entry
 * stops counting CLAIM_NONCE_TTL_MS after it was issued, whatever the
 * browser does with the cookie: the issue time is inside the signed value.
 * Signed under the "claim:" prefix.
 * Value: "<base64url(JSON [[nonce, issuedAtSeconds], ...])>.<sig>".
 */
export const CLAIM_NONCES_MAX = 5;
export const CLAIM_NONCE_TTL_MS = 24 * 60 * 60 * 1000;
const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * `entries`: newest first, each `{ nonce, issuedAt }` (ms) or a bare nonce
 * string issued now. Keeps the newest CLAIM_NONCES_MAX.
 */
export function signClaimNonces(entries, now = Date.now()) {
  const list = entries
    .map((e) => (typeof e === 'string' ? { nonce: e, issuedAt: now } : e))
    .filter((e) => e && NONCE_RE.test(e.nonce) && Number.isFinite(e.issuedAt))
    .slice(0, CLAIM_NONCES_MAX)
    .map((e) => [e.nonce, Math.floor(e.issuedAt / 1000)]);
  const payload = Buffer.from(JSON.stringify(list)).toString('base64url');
  return `${payload}.${hmac(`claim:${payload}`)}`;
}

/**
 * The unexpired entries ([{ nonce, issuedAt }], newest first) when the cookie
 * was signed by this server, else null.
 */
export function verifyClaimNonces(signed, now = Date.now()) {
  if (!signingConfigured()) return null;
  const parts = splitSigned(signed);
  if (!parts || !sameSig(parts.sig, hmac(`claim:${parts.value}`))) return null;
  try {
    const list = JSON.parse(Buffer.from(parts.value, 'base64url').toString('utf8'));
    if (!Array.isArray(list)) return null;
    return list
      .filter((e) => Array.isArray(e) && typeof e[0] === 'string' && NONCE_RE.test(e[0]) && Number.isFinite(e[1]))
      .map(([nonce, issuedAtS]) => ({ nonce, issuedAt: issuedAtS * 1000 }))
      .filter((e) => now - e.issuedAt < CLAIM_NONCE_TTL_MS)
      .slice(0, CLAIM_NONCES_MAX);
  } catch {
    return null;
  }
}
