// Pure pricing constants. No imports, so client bundles can use them without
// pulling in any server code. lib/pricing.js re-exports these.

export const PLANS_V2 = {
  starter: { usd: 29, credits: 1500 },
  creator: { usd: 49, credits: 2600 },
  studio: { usd: 99, credits: 5400 },
};
export const TOPUPS_V2 = {
  s: { usd: 15, credits: 700 },
  m: { usd: 40, credits: 1900 },
  l: { usd: 100, credits: 5000 },
};
// Share taken off 12 x the monthly price for a yearly plan. 0 until the owner
// sets one (pricing_config key `yearlyDiscount`, admin pricing editor).
export const YEARLY_DISCOUNT = 0;
export const LEGACY_TO_V2 = 21 / 100;

export const DEFAULTS = {
  perSecond: { economy: 8, standard: 11, pro_narrated: 14, pro_talking: 21 },
  projectFee: 90,
  stillReroll: 2,
  castRegen: 5,
  narrationRegen: 5,
  musicRegen: 5,
  voiceClone: 20,
  freeRerollShare: 0.2,
  // Shortest clip each quality's video model makes (lib/providers/config.js); a shorter shot is priced and made at this length.
  minSeconds: { economy: 4, standard: 3, pro_narrated: 3, pro_talking: 3 },
  included: { castRegenPerCharacter: 2, narration: 3, music: 3, chat: 150 },
  // Billing v2 offers (admin-editable; lib/pricing.js v2Offers). A changed
  // amount or credit count is a new Stripe price (lib/stripe.js).
  plans: PLANS_V2,
  topups: TOPUPS_V2,
  yearlyDiscount: YEARLY_DISCOUNT,
  retentionDays: 30, // project media is deleted this many days after the first file is stored (spec 10.10)
};

export const QUALITY_LABELS = {
  economy: 'Economy',
  standard: 'Standard',
  pro_narrated: 'Pro narrated',
  pro_talking: 'Pro talking',
};

// What each AI action costs the owner, in USD. The 2x rule: customers are charged
// about twice this. tests/pricing.test.js fails if DEFAULTS drift outside that band.
export const PROVIDER_COSTS_USD = {
  perSecond: { economy: 0.041, standard: 0.0755, pro_narrated: 0.101, pro_talking: 0.151 },
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
  return DEFAULTS.projectFee + DEFAULTS.perSecond[quality] * generatedSeconds;
}

export function videosPerPlan({ credits, quality, seconds }) {
  return Math.floor(credits / creditsForVideo({ quality, seconds }));
}

export function markup({ quality, seconds, usdPerCredit }) {
  return (creditsForVideo({ quality, seconds }) * usdPerCredit) / costOfVideoUsd({ quality, seconds });
}
