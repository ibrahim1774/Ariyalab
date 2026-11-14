// Homepage plan numbers. One source of truth: lib/pricingConstants.js (import-free,
// so no server code reaches the client bundle).
import { PLANS_V2, YEARLY_DISCOUNT } from '../../lib/pricingConstants.js';

export const PLANS = PLANS_V2;
export { YEARLY_DISCOUNT };

// 720 credits is one 45 second Pro narrated video.
export const CREDITS_PER_REFERENCE_VIDEO = 720;

export function videosFor(credits) {
  return Math.floor(credits / CREDITS_PER_REFERENCE_VIDEO);
}
