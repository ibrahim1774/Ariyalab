// Homepage plan numbers. One source of truth: lib/pricingConstants.js (import-free,
// so no server code reaches the client bundle).
import { PLANS_V2, YEARLY_DISCOUNT, videosPerPlan } from '../../lib/pricingConstants.js';

export const PLANS = PLANS_V2;
export { YEARLY_DISCOUNT, videosPerPlan };

export const CARD_VIDEO_SECONDS = 45;
export const MATRIX_LENGTHS = [15, 30, 45, 60];
export const MATRIX_QUALITIES = [
  { key: 'standard', label: 'Standard', note: '720p with a narrator.' },
  { key: 'pro_narrated', label: 'Pro narrated', note: '1080p with a narrator.' },
  { key: 'pro_talking', label: 'Pro talking', note: '1080p and the characters speak.' },
];
export const DEFAULT_MATRIX_QUALITY = 'pro_narrated';
