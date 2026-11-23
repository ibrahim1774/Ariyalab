// The admin pricing editor (pages/api/admin/pricing.js, pages/admin/index.js):
// which pricing_config keys may be written, how each value is checked, and the
// readouts the owner prices with (cost per credit, margin per quality, drift
// from the static defaults the homepage shows).

import { DEFAULTS, PROVIDER_COSTS_USD, QUALITY_LABELS } from './pricingConstants.js';
import { v2Offers } from './pricing.js';

const QUALITIES = Object.keys(DEFAULTS.perSecond);
const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const isNum = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function objectOf(value, allowed, check, what) {
  if (!isObj(value)) return `${what} must be an object.`;
  const keys = Object.keys(value);
  if (!keys.length) return `${what} is empty.`;
  for (const k of keys) {
    if (!allowed.includes(k)) return `${what}: unknown key "${k}" (allowed: ${allowed.join(', ')}).`;
    const err = check(value[k], k);
    if (err) return `${what}.${k}: ${err}`;
  }
  return null;
}

const offer = (v) => {
  if (!isObj(v)) return 'must be { usd, credits }.';
  for (const k of Object.keys(v)) if (k !== 'usd' && k !== 'credits') return `unknown key "${k}".`;
  if (v.usd !== undefined && !(isNum(v.usd, 0.5, 10000) && Math.abs(Math.round(v.usd * 100) - v.usd * 100) < 1e-6)) return 'usd must be 0.50 to 10000 with at most 2 decimals.';
  if (v.credits !== undefined && !isInt(v.credits, 1, 1_000_000)) return 'credits must be a whole number from 1 to 1,000,000.';
  if (v.usd === undefined && v.credits === undefined) return 'give usd and/or credits.';
  return null;
};

/** Every key the editor may write, with its check: (value) -> error message or null. */
export const EDITABLE = {
  perSecond: (v) => objectOf(v, QUALITIES, (x) => (isInt(x, 1, 1000) ? null : 'a whole number from 1 to 1000.'), 'perSecond'),
  minSeconds: (v) => objectOf(v, QUALITIES, (x) => (isInt(x, 1, 15) ? null : 'a whole number from 1 to 15.'), 'minSeconds'),
  projectFee: (v) => (isInt(v, 0, 100000) ? null : 'projectFee must be a whole number from 0 to 100000.'),
  projectFeeShort: (v) => (isInt(v, 0, 100000) ? null : 'projectFeeShort must be a whole number from 0 to 100000.'),
  stillReroll: (v) => (isInt(v, 0, 100000) ? null : 'stillReroll must be a whole number from 0 to 100000.'),
  castRegen: (v) => (isInt(v, 0, 100000) ? null : 'castRegen must be a whole number from 0 to 100000.'),
  castFromPicture: (v) => (isInt(v, 1, 100000) ? null : 'castFromPicture must be a whole number from 1 to 100000 (a look-alike always costs something).'),
  narrationRegen: (v) => (isInt(v, 0, 100000) ? null : 'narrationRegen must be a whole number from 0 to 100000.'),
  musicRegen: (v) => (isInt(v, 0, 100000) ? null : 'musicRegen must be a whole number from 0 to 100000.'),
  renderRegen: (v) => (isInt(v, 0, 100000) ? null : 'renderRegen must be a whole number from 0 to 100000.'),
  voiceClone: (v) => (isInt(v, 1, 100000) ? null : 'voiceClone must be a whole number from 1 to 100000 (a clone always costs something).'),
  freeRerollShare: (v) => (isNum(v, 0, 1) ? null : 'freeRerollShare must be a number from 0 to 1.'),
  included: (v) => objectOf(v, Object.keys(DEFAULTS.included), (x) => (isInt(x, 0, 100000) ? null : 'a whole number from 0 to 100000.'), 'included'),
  retentionDays: (v) => (isInt(v, 1, 365) ? null : 'retentionDays must be a whole number from 1 to 365.'),
  plans: (v) => objectOf(v, Object.keys(DEFAULTS.plans), offer, 'plans'),
  topups: (v) => objectOf(v, Object.keys(DEFAULTS.topups), offer, 'topups'),
  yearlyDiscount: (v) => (isNum(v, 0, 0.9) ? null : 'yearlyDiscount must be a number from 0 to 0.9 (0.2 = 20% off).'),
  billing_v2: (v) => (typeof v === 'boolean' ? null : 'billing_v2 must be true or false.'),
};

/** -> null when { key, value } may be written, else the reason. */
export function validatePricingWrite(key, value) {
  if (!Object.hasOwn(EDITABLE, key)) return `"${key}" is not an editable pricing key.`;
  return EDITABLE[key](value);
}

/**
 * The owner's readout for a pricing object (getPricing()):
 *   plans/topups: price, credits, cost per credit (USD), yearly price;
 *   margins: per quality, the provider cost of one generated second
 *     (PROVIDER_COSTS_USD) against what the customer pays for it
 *     (perSecond credits x USD per credit), at the cheapest and the dearest
 *     credit on sale. margin = 1 - cost / price.
 *   render: { included, credits }: renders of a project that are free, and the price of each one after.
 *   drift: the keys whose live value differs from the static DEFAULTS the
 *     homepage pricing section renders (it does not read the config).
 */
export function pricingReadout(pricing) {
  const offers = v2Offers(pricing);
  const perCredit = [];
  const plans = {};
  for (const [k, p] of Object.entries(offers.plans)) {
    const usdPerCredit = p.usd / p.credits;
    perCredit.push(usdPerCredit);
    plans[k] = { ...p, usdPerCredit, yearlyUsdPerCredit: p.yearlyUsd / (p.credits * 12) };
    perCredit.push(plans[k].yearlyUsdPerCredit);
  }
  const topups = {};
  for (const [k, t] of Object.entries(offers.topups)) {
    topups[k] = { ...t, usdPerCredit: t.usd / t.credits };
    perCredit.push(topups[k].usdPerCredit);
  }
  const cheapest = Math.min(...perCredit);
  const dearest = Math.max(...perCredit);
  const margins = {};
  for (const q of QUALITIES) {
    const cost = PROVIDER_COSTS_USD.perSecond[q];
    const credits = pricing.perSecond?.[q];
    const low = credits * cheapest;
    const high = credits * dearest;
    margins[q] = {
      label: QUALITY_LABELS[q] || q,
      providerUsdPerSecond: cost,
      creditsPerSecond: credits,
      priceUsdPerSecondLow: low,
      priceUsdPerSecondHigh: high,
      marginLow: low > 0 ? 1 - cost / low : null,
      marginHigh: high > 0 ? 1 - cost / high : null,
    };
  }
  const drift = Object.keys(DEFAULTS).filter((k) => JSON.stringify(pricing[k]) !== JSON.stringify(DEFAULTS[k]));
  const render = { included: pricing.included?.render ?? DEFAULTS.included.render, credits: pricing.renderRegen ?? DEFAULTS.renderRegen };
  return { plans, topups, yearlyDiscount: offers.yearlyDiscount, usdPerCredit: { cheapest, dearest }, margins, render, drift };
}
