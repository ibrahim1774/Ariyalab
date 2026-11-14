import { describe, expect, it, vi } from 'vitest';
import { makeRes } from '../helpers/apiMock';
import { ConflictError, LimitError, NotFoundError, sendError, ValidationError } from '../../lib/story/errors.js';
import { InsufficientCreditsError } from '../../lib/credits.js';
import { ModerationError, MODERATION_UNAVAILABLE } from '../../lib/moderation.js';

const send = (err) => {
  const res = makeRes();
  sendError(res, err);
  return res;
};

describe('sendError', () => {
  it('maps the story errors', () => {
    expect(send(new NotFoundError())).toMatchObject({ statusCode: 404, body: { error: 'not_found' } });
    expect(send(new ValidationError('Too long', { field: 'title' }))).toMatchObject({
      statusCode: 422, body: { error: 'validation_failed', message: 'Too long', field: 'title' },
    });
    expect(send(new ConflictError('Busy'))).toMatchObject({ statusCode: 409, body: { error: 'conflict', message: 'Busy' } });
    expect(send(new LimitError('Daily limit'))).toMatchObject({ statusCode: 429, body: { error: 'limit_reached' } });
    expect(send(new LimitError('Paid plan needed', { status: 402, code: 'plan_required' }))).toMatchObject({
      statusCode: 402, body: { error: 'plan_required', message: 'Paid plan needed' },
    });
  });

  it('maps insufficient credits to 402 with needed and available', () => {
    expect(send(new InsufficientCreditsError(120, 30))).toMatchObject({
      statusCode: 402, body: { error: 'insufficient_credits', needed: 120, available: 30 },
    });
  });

  it('uses the existing moderation response', () => {
    expect(send(new ModerationError('sexual', 'Layer 1'))).toMatchObject({ statusCode: 400, body: { code: 'BLOCKED_NSFW' } });
    expect(send(new ModerationError(MODERATION_UNAVAILABLE, MODERATION_UNAVAILABLE))).toMatchObject({ statusCode: 503 });
  });

  it('hides unexpected errors behind a 500', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = send(new Error('relation "x" does not exist'));
    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/relation/);
    spy.mockRestore();
  });
});
