// Homepage plan numbers. One source of truth: lib/pricingConstants.js (import-free,
// so no server code reaches the client bundle).
import { PLANS_V2, YEARLY_DISCOUNT, videosPerPlan } from '../../lib/pricingConstants.js';

export const PLANS = PLANS_V2;
export { YEARLY_DISCOUNT, videosPerPlan };

export const CARD_VIDEO_SECONDS = 45;
export const MATRIX_LENGTHS = [10, 30, 60, 120];
export const MATRIX_QUALITIES = [
  { key: 'standard', label: 'Standard', note: '1080p with voice and sound.' },
  { key: 'pro_narrated', label: 'Pro', note: '720p with voice and sound.' },
  { key: 'pro_talking', label: 'Pro Max', note: '1080p with voice and sound.' },
];
export const DEFAULT_MATRIX_QUALITY = 'standard';
