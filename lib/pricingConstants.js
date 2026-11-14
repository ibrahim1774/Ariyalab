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
export const YEARLY_DISCOUNT = 0.2;
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
  included: { castRegenPerCharacter: 2, narration: 3, music: 3, chat: 150 },
};

export const QUALITY_LABELS = {
  economy: 'Economy',
  standard: 'Standard',
  pro_narrated: 'Pro narrated',
  pro_talking: 'Pro talking',
};
