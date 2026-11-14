// Starting plan values for the homepage. A later task repoints this file to
// lib/pricing.js; PricingSection reads from here only.
export const PLANS = {
  starter: { usd: 29, credits: 1500 },
  creator: { usd: 49, credits: 2600 },
  studio: { usd: 99, credits: 5400 },
};

export const YEARLY_DISCOUNT = 0.2;

// 720 credits is one 45 second Pro narrated video.
export const CREDITS_PER_REFERENCE_VIDEO = 720;

export function videosFor(credits) {
  return Math.floor(credits / CREDITS_PER_REFERENCE_VIDEO);
}
