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

// What each AI action costs the owner, in USD. The 70% rule: every plan and top-up
// keeps at least 70% margin after Stripe's fee (tests/pricing.test.js).
//
// Measured on one real 10 s Standard video, 2026-11-17 (kie.ai balance before and after): every Nano Banana Pro
// picture (character option, character sheet, scene picture) was charged 18 kie credits = 0.09 dollars. Failed
// kie.ai tasks are not charged.
export const PICTURE_USD = 0.09;
// Pictures one project makes besides its scene pictures: 2 characters x (1 picture + 1 sheet) = 4, at PICTURE_USD.
// (Was 8 while each character was drawn 3 times for the customer to choose from; one picture per character since 2026-11-23.)
const FIXED_PICTURES = 4;
// Everything else the project costs once, as it was assumed before the real video (the old projectFixed 0.84 = 8 cast
// pictures at the old 0.02 = 0.16, plus 0.68): script and analysis model calls, narration, generated music and render.
// Kept as it was, not zeroed: only the pictures were measured. The real video's model calls were estimated at 0.15 to 0.25
// dollars; narration (Fish), music (Lyria) and render were not run, so their share of this 0.68 is still an assumption.
const FIXED_OTHER_USD = 0.68;
// The free character redraws every project includes (DEFAULTS.included.castRegenPerCharacter per character) are made at the
// owner's cost. Expected, not certain: rerollAllowance of them are used, the same share the model already assumes for free
// clip and picture re-rolls (no usage data yet). 2 characters x 2 redraws x 2 pictures x 0.09 x 0.2 = 0.144.
const MODEL_CHARACTERS = 2;

export const PROVIDER_COSTS_USD = {
  // All sound-on, kie.ai list prices read 2026-11-17: Seedance 2 Mini 720p, Gemini Omni 1.2 Flash 1080p, Kling 3.0 std / pro.
  perSecond: { economy: 0.041, standard: 0.05, pro_narrated: 0.1135, pro_talking: 0.151 },
  // One scene picture.
  still: PICTURE_USD,
  // Once per video, not counting scene pictures or clips: 4 pictures x 0.09 = 0.36, plus 0.68 for the rest = 1.04.
  // (Was 1.40 with 8 pictures, and 0.84 with still = 0.02.)
  projectFixed: Math.round((FIXED_PICTURES * PICTURE_USD + FIXED_OTHER_USD) * 100) / 100,
  // Share of video and stills expected to be redone at no charge to the customer.
  rerollAllowance: 0.2,
};

// What one credit sells for: the Starter plan, 29 dollars for 900 credits.
export const USD_PER_CREDIT = PLANS_V2.starter.usd / PLANS_V2.starter.credits;
export const MIN_MARGIN = 0.7;

/** The smallest whole number of credits that sells `costUsd` of provider cost at MIN_MARGIN (70%) or better. */
export function creditsForMargin(costUsd) {
  // cost <= credits x USD_PER_CREDIT x (1 - MIN_MARGIN); the small epsilon keeps an exact result from rounding up.
  return Math.ceil(costUsd / (USD_PER_CREDIT * (1 - MIN_MARGIN)) - 1e-9);
}

// A picture-backed price is derived here, once; DEFAULTS, getPricing (the server) and usePricing (the screens) read it.
// A paid scene-picture redo makes 1 picture. A paid character redraw makes 1 picture and the sheet of it = 2 (was 3 options + sheet = 4).
export const PICTURES_PER_CAST_REDRAW = 2;
// "Make them look like a picture" draws one new picture of the character from the customer's picture, then the sheet = 2.
export const PICTURES_PER_CAST_FROM_PICTURE = 2;

/** Expected owner cost of the included free character redraws (see MODEL_CHARACTERS above): 0.144 dollars. */
export const freeRedrawsExpectedUsd = (pricing = DEFAULTS) =>
  PROVIDER_COSTS_USD.rerollAllowance * MODEL_CHARACTERS * (pricing.included?.castRegenPerCharacter ?? 0) * PICTURES_PER_CAST_REDRAW * PROVIDER_COSTS_USD.still;

export const DEFAULTS = {
  perSecond: { economy: 7, standard: 8, pro_narrated: 16, pro_talking: 21 },
  projectFee: 90,
  // The project fee of a video of SHORT_VIDEO_SECONDS or less (projectFeeFor). The owner asked for 45, but the 70%
  // margin rule (tests/pricing.test.js) needed 90 at 7 and 10 seconds with the earlier cost model (the corrected model is under 70% everywhere, see the margin pins), so the short fee equals the full fee. Admin pricing can set a lower one.
  projectFeeShort: 90,
  stillReroll: creditsForMargin(PROVIDER_COSTS_USD.still), // 1 picture: 10 (was 2)
  castRegen: creditsForMargin(PICTURES_PER_CAST_REDRAW * PROVIDER_COSTS_USD.still), // 2 pictures: 19 (was 38 for 4, and 5 before that)
  // Make a character look like a picture the customer chose: always paid, never uses a free redraw. 2 pictures: 19.
  castFromPicture: creditsForMargin(PICTURES_PER_CAST_FROM_PICTURE * PROVIDER_COSTS_USD.still),
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

function shotMath(seconds, shotSeconds) {
  const shots = Math.ceil(seconds / shotSeconds);
  return { shots, generatedSeconds: shots * shotSeconds };
}

export function costOfVideoUsd({ quality, seconds, shotSeconds = 3 }) {
  const { shots, generatedSeconds } = shotMath(seconds, shotSeconds);
  const c = PROVIDER_COSTS_USD;
  // Free picture redos and free clip re-rolls: the allowance on top of both. Free character redraws: their expected cost.
  return (c.perSecond[quality] * generatedSeconds + c.still * shots) * (1 + c.rerollAllowance) + c.projectFixed + freeRedrawsExpectedUsd();
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
