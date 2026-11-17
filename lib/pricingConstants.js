// Pure pricing constants. No imports, so client bundles can use them without
// pulling in any server code. lib/pricing.js re-exports these.

export const PLANS_V2 = {
  // At least 70% gross margin when every credit is used, after Stripe's fee
  // (owner decision 2026-11-16: same prices, fewer credits).
  starter: { usd: 29, credits: 900 },
  creator: { usd: 49, credits: 1500 },
  studio: { usd: 99, credits: 3100 },
};
export const TOPUPS_V2 = {
  s: { usd: 15, credits: 450 },
  m: { usd: 40, credits: 1240 },
  l: { usd: 100, credits: 3100 },
};
// Share taken off 12 x the monthly price for a yearly plan: 15% (owner decision,
// 2026-11-16). pricing_config key `yearlyDiscount` overrides it (admin pricing editor).
export const YEARLY_DISCOUNT = 0.15;
export const LEGACY_TO_V2 = 21 / 100;

export const DEFAULTS = {
  perSecond: { economy: 7, standard: 8, pro_narrated: 16, pro_talking: 21 },
  projectFee: 90,
  // The project fee of a video of SHORT_VIDEO_SECONDS or less (projectFeeFor). The owner asked for 45, but the 70%
  // margin rule (tests/pricing.test.js) needs 90 at 7 and 10 seconds with today's plan credits, so until the plans or
  // the fixed cost change the short fee equals the full fee. Admin pricing can set a lower one.
  projectFeeShort: 90,
  stillReroll: 2,
  castRegen: 5,
  narrationRegen: 5,
  musicRegen: 5,
  // Every render after the included one (included.render): the first finished render of a project is free.
  renderRegen: 5,
  voiceClone: 20,
  freeRerollShare: 0.2,
  // Shortest clip each quality's video model makes (lib/providers/config.js); a shorter shot is priced and made at this length.
  minSeconds: { economy: 4, standard: 3, pro_narrated: 3, pro_talking: 3 },
  included: { castRegenPerCharacter: 2, narration: 3, music: 3, chat: 150, render: 1 },
  // Billing v2 offers (admin-editable; lib/pricing.js v2Offers). A changed
  // amount or credit count is a new Stripe price (lib/stripe.js).
  plans: PLANS_V2,
  topups: TOPUPS_V2,
  yearlyDiscount: YEARLY_DISCOUNT,
  retentionDays: 30, // each stored file keeps the project's media at least this many days (spec 10.10)
};

// The lengths the simple maker offers (the server accepts 7 to 120 seconds, lib/story/projects.js).
export const SIMPLE_LENGTHS = Object.freeze([7, 10, 30, 60, 120]);
export const SHORT_VIDEO_SECONDS = 10;

/**
 * The project fee for a video of this many seconds, from a pricing object: projectFeeShort when
 * seconds <= 10, else projectFee. A projectFeeShort that is not a whole number of 0 or more falls back to projectFee.
 * The one place that decides it: every quote and charge goes through here.
 */
export function projectFeeFor(pricing, seconds) {
  const short = pricing?.projectFeeShort;
  if (Number.isFinite(seconds) && seconds <= SHORT_VIDEO_SECONDS && Number.isInteger(short) && short >= 0) return short;
  return pricing?.projectFee;
}

// Every shot lasts 3 to 6 whole seconds (the storyboard rules, lib/story/prompts/shot.js).
export const MIN_SHOT_SECONDS = 3;
export const MAX_SHOT_SECONDS = 6;

/** Seconds a shot is generated (and priced) at: rounded up, at least the quality's minimum (3 by default). */
export function generatedSeconds(pricing, quality, seconds) {
  const min = Number.isInteger(pricing.minSeconds?.[quality]) ? pricing.minSeconds[quality] : MIN_SHOT_SECONDS;
  return Math.max(min, Math.ceil(seconds));
}

/**
 * How a video of `total` seconds is split into shots when nothing else decides it: as few shots as can reach the full
 * length (6 seconds each at most), the seconds spread evenly, each kept to 3..6. The planner's default (the mock
 * storyboard uses it) and the length picker's estimate both come from here, so they cannot drift apart.
 * `count` overrides the number of shots (a script with many lines has more).
 */
export function plannedShotSeconds(total, count = Math.max(1, Math.ceil(total / MAX_SHOT_SECONDS))) {
  const whole = Math.floor(total);
  return Array.from({ length: count }, (_, i) => {
    const share = Math.floor(whole / count) + (i < whole % count ? 1 : 0);
    return Math.min(MAX_SHOT_SECONDS, Math.max(MIN_SHOT_SECONDS, share));
  });
}

export const QUALITY_LABELS = {
  // The card names of lib/qualityInfo.js (tests/qualityInfo.test.js keeps the two equal).
  economy: 'Budget',
  standard: 'Standard',
  pro_narrated: 'Pro',
  pro_talking: 'Pro Max',
};

// What each AI action costs the owner, in USD. The 70% rule: every plan and top-up
// keeps at least 70% margin after Stripe's fee (tests/pricing.test.js).
export const PROVIDER_COSTS_USD = {
  // All sound-on, kie.ai list prices read 2026-11-17: Seedance 2 Mini 720p, Gemini Omni 1.2 Flash 1080p, Kling 3.0 std / pro.
  perSecond: { economy: 0.041, standard: 0.05, pro_narrated: 0.1135, pro_talking: 0.151 },
  still: 0.02,
  // Script and analysis, cast images, narration, music and render, once per video.
  projectFixed: 0.84,
  // Share of video and stills expected to be redone at no charge to the customer.
  rerollAllowance: 0.2,
};

function shotMath(seconds, shotSeconds) {
  const shots = Math.ceil(seconds / shotSeconds);
  return { shots, generatedSeconds: shots * shotSeconds };
}

export function costOfVideoUsd({ quality, seconds, shotSeconds = 3 }) {
  const { shots, generatedSeconds } = shotMath(seconds, shotSeconds);
  const c = PROVIDER_COSTS_USD;
  return (c.perSecond[quality] * generatedSeconds + c.still * shots) * (1 + c.rerollAllowance) + c.projectFixed;
}

export function creditsForVideo({ quality, seconds, shotSeconds = 3 }) {
  const { generatedSeconds } = shotMath(seconds, shotSeconds);
  return projectFeeFor(DEFAULTS, seconds) + DEFAULTS.perSecond[quality] * generatedSeconds;
}

export function videosPerPlan({ credits, quality, seconds }) {
  return Math.floor(credits / creditsForVideo({ quality, seconds }));
}

export function markup({ quality, seconds, usdPerCredit }) {
  return (creditsForVideo({ quality, seconds }) * usdPerCredit) / costOfVideoUsd({ quality, seconds });
}
