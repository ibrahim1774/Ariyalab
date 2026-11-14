import { InsufficientCreditsError } from '../credits.js';
import { ModerationError, moderationErrorResponse } from '../moderation.js';

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

/** 422. `field` names the offending input when there is one. */
export class ValidationError extends StoryError {
  constructor(message = 'Invalid input.', { field } = {}) {
    super(message, { status: 422, code: 'validation_failed', ...(field ? { field } : {}) });
    this.field = field;
  }
}

/** 409. A conflicting in-flight action. */
export class ConflictError extends StoryError {
  constructor(message = 'Another action is in progress.', extra = {}) {
    super(message, { status: 409, code: 'conflict', ...extra });
  }
}

/** 429 by default (rate and daily caps); pass { status: 402, code } for paid-plan gates. */
export class LimitError extends StoryError {
  constructor(message = 'Limit reached.', { status = 429, code = 'limit_reached', ...extra } = {}) {
    super(message, { status, code, ...extra });
  }
}

export function sendError(res, err) {
  if (err instanceof InsufficientCreditsError) {
    return res.status(402).json({ error: 'insufficient_credits', needed: err.needed, available: err.available });
  }
  if (err instanceof ModerationError) {
    return moderationErrorResponse(res, err);
  }
  if (err instanceof StoryError) {
    return res.status(err.status).json({ error: err.code, message: err.message, ...err.extra });
  }
  console.error('[story] unexpected error', err);
  return res.status(500).json({ error: 'server_error', message: 'Something went wrong. Please try again.' });
}
