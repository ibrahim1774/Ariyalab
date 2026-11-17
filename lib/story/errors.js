import { InsufficientCreditsError } from '../credits.js';
import { ModerationError, moderationErrorResponse } from '../moderation.js';
import { ProviderError } from '../providers/errors.js';

/*
 * Typed errors for lib/story/* and the one error mapper every
 * /api/story route uses: `catch (err) { return sendError(res, err); }`.
 *
 * Response body for story errors: { error: <code>, message, ...extra }.
 */

export class StoryError extends Error {
  constructor(message, { status = 500, code = 'server_error', ...extra } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/** 404. Also used for rows owned by someone else, so ownership never leaks. */
export class NotFoundError extends StoryError {
  constructor(message = 'Not found.') {
    super(message, { status: 404, code: 'not_found' });
  }
}

/** 422. `field` names the offending input when there is one; other keys (a more exact `code`, a `shotId`) ride along. */
export class ValidationError extends StoryError {
  constructor(message = 'Invalid input.', { field, ...extra } = {}) {
    super(message, { status: 422, code: 'validation_failed', ...(field ? { field } : {}), ...extra });
    this.field = field;
  }
}

/** 409. A conflicting in-flight action. */
export class ConflictError extends StoryError {
  constructor(message = 'Another action is in progress.', extra = {}) {
    super(message, { status: 409, code: 'conflict', ...extra });
  }
}

/** 409 quote_changed: the price the customer confirmed is not the price now. extra: { total } (the current price). */
export class QuoteChangedError extends ConflictError {
  constructor(message = 'The price changed. Check the new price and confirm again.', extra = {}) {
    super(message, { code: 'quote_changed', ...extra });
  }
}

// HTTP status for each LimitError code (lib/story/limits.js). Any other code
// is a cap (daily, per project) and gets 429.
export const LIMIT_STATUS = Object.freeze({ plan_required: 402, email_unverified: 403 });

/** Free-tier gates and caps. The status follows the code: plan_required 402, email_unverified 403, caps 429. */
export class LimitError extends StoryError {
  constructor(message = 'Limit reached.', { code = 'limit_reached', status = LIMIT_STATUS[code] ?? 429, ...extra } = {}) {
    super(message, { status, code, ...extra });
  }
}

// A provider failure (lib/providers) during a synchronous story action.
// ProviderError messages are safe to show; 'config' (a missing key) is not
// the customer's problem, so it gets the generic message.
const PROVIDER_STATUS = { blocked: 422, rate_limited: 429, failed: 502, config: 503 };

export function sendError(res, err) {
  if (err instanceof InsufficientCreditsError) {
    return res.status(402).json({ error: 'insufficient_credits', needed: err.needed, available: err.available });
  }
  if (err instanceof ModerationError) {
    return moderationErrorResponse(res, err);
  }
  if (err instanceof ProviderError) {
    const status = PROVIDER_STATUS[err.code] ?? 502;
    const message = err.code === 'config' ? 'This service is not available right now. Please try again later.' : err.message;
    if (status >= 500) console.error('[story] provider error', err.code, err.cause?.message || err.message);
    return res.status(status).json({ error: `provider_${err.code}`, message });
  }
  if (err instanceof StoryError) {
    return res.status(err.status).json({ error: err.code, message: err.message, ...err.extra });
  }
  console.error('[story] unexpected error', err);
  return res.status(500).json({ error: 'server_error', message: 'Something went wrong. Please try again.' });
}
