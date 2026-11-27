import Stripe from 'stripe';
import { PLANS_V2 } from './pricingConstants.js';

let cached = null;

export function stripe() {
  if (cached) return cached;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error('STRIPE_SECRET_KEY is not set.');
  }
  cached = new Stripe(key, { apiVersion: '2024-06-20' });
  return cached;
}

export const PLANS = {
  monthly: {
    name: 'Sonallo Monthly',
    // Distinct lookup key — Haelabs's planFromPrice doesn't recognise
    // this, so its webhook handler no-ops on ariyalab subscriptions.
    lookupKey: 'ariyalab_monthly_v1',
    amountCents: 500, // $5.00
    interval: 'month',
    // 760 credits = 76 seconds of Seedance 1.5 Pro 480p no-audio
    // (10 cr/sec baseline). Ibrahim's cost target ≤ $1 at full burn.
    cap: 760,
  },
  pro: {
    name: 'Sonallo Pro',
    lookupKey: 'ariyalab_pro_v1',
    amountCents: 900, // $9.00
    interval: 'month',
    // 2,280 credits = 228 seconds at 480p no-audio. Ibrahim's cost
    // target ≤ $3 at full burn.
    cap: 2280,
  },
  yearly: {
    name: 'Sonallo Yearly',
    lookupKey: 'ariyalab_yearly_v1',
    amountCents: 2900, // $29.00
    interval: 'year',
    // 3,840 credits = 384 seconds at 480p no-audio. Ibrahim's cost
    // target ≤ $5 at full burn. Per-credit slightly cheaper than
    // monthly (3840 vs 760×12=9120) — modest loyalty discount.
    cap: 3840,
  },
};

export const TRIAL_CREDITS = 2; // legacy free-trial pool (kept for any old trialing subs).

export const CAPS = {
  trial: TRIAL_CREDITS,
  monthly: PLANS.monthly.cap,
  pro: PLANS.pro.cap,
  yearly: PLANS.yearly.cap,
};

export const TRIAL_MS = 24 * 60 * 60 * 1000;

/*
 * One-time top-up credit packs. Sold as Stripe one-time prices
 * (not subscriptions). Two distinct kinds:
 *
 *   - kind: 'video' — credits the existing `creditsRemaining` pool used
 *     by face-swap / UGC / image-to-video.
 *   - kind: 'image' — credits the `imageCreditsRemaining` pool used by
 *     /api/glow-up (and any future image features).
 *
 * The two pools never mix: a customer who buys an image pack cannot
 * spend those credits on video features, and vice versa.
 */
export const TOPUPS = {
  // ── Video credit packs. Distinct lookup keys so Haelabs's webhook
  // handler returns null on topupFromPrice and no-ops on ariyalab events.
  s: {
    kind: 'video',
    name: 'Sonallo Video Credits (2,280)',
    lookupKey: 'ariyalab_topup_video_s_v1',
    amountCents: 1500, // $15.00
    credits: 2280,
  },
  m: {
    kind: 'video',
    name: 'Sonallo Video Credits (7,600)',
    lookupKey: 'ariyalab_topup_video_m_v1',
    amountCents: 5000, // $50.00
    credits: 7600,
  },
  l: {
    kind: 'video',
    name: 'Sonallo Video Credits (15,200)',
    lookupKey: 'ariyalab_topup_video_l_v1',
    amountCents: 10000, // $100.00
    credits: 15200,
  },
  // ── Image credit packs (Glow Up / Interior Design). Pricing reflects
  // the much lower unit cost of kie.ai 4o-image / Flux Kontext
  // (~$0.03/image). Distinct lookup keys for ariyalab isolation.
  'image-s': {
    kind: 'image',
    name: 'Sonallo Image Credits (50)',
    lookupKey: 'ariyalab_topup_image_s_v1',
    amountCents: 500, // $5.00
    credits: 50,
  },
  'image-m': {
    kind: 'image',
    name: 'Sonallo Image Credits (200)',
    lookupKey: 'ariyalab_topup_image_m_v1',
    amountCents: 1500, // $15.00
    credits: 200,
  },
  'image-l': {
    kind: 'image',
    name: 'Sonallo Image Credits (500)',
    lookupKey: 'ariyalab_topup_image_l_v1',
    amountCents: 3000, // $30.00
    credits: 500,
  },
};

/*
 * Per-surface variants of each subscription plan. SAME PRICE, SAME
 * ENTITLEMENT — only the Stripe Product NAME differs so the checkout
 * page header reads the right label for the surface the customer
 * came from. Every variant maps back to the same internal plan
 * ('monthly' or 'yearly') via planFromPrice, so the rest of the app
 * (entitlement, credits, top-ups, webhook handlers) is unchanged.
 *
 * The 'default' variant keeps the legacy lookup keys exactly so any
 * existing customer's subscription continues to map cleanly.
 */
export const PLAN_SURFACES = {
  monthly: {
    default: { lookupKey: PLANS.monthly.lookupKey, productName: PLANS.monthly.name },
    'glow-up': {
      lookupKey: 'ariyalab_monthly_glow_up_v1',
      productName: 'Glow Up Monthly Plan',
    },
    'interior-design': {
      lookupKey: 'ariyalab_monthly_interior_v1',
      productName: 'AI Interior Monthly Plan',
    },
    'local-business': {
      lookupKey: 'ariyalab_monthly_local_business_v1',
      productName: 'Local Business Monthly Plan',
    },
    'real-estate': {
      lookupKey: 'ariyalab_monthly_real_estate_v1',
      productName: 'Real Estate Monthly Plan',
    },
  },
  pro: {
    default: { lookupKey: PLANS.pro.lookupKey, productName: PLANS.pro.name },
    'glow-up': {
      lookupKey: 'ariyalab_pro_glow_up_v1',
      productName: 'Glow Up Pro Plan',
    },
    'interior-design': {
      lookupKey: 'ariyalab_pro_interior_v1',
      productName: 'AI Interior Pro Plan',
    },
    'local-business': {
      lookupKey: 'ariyalab_pro_local_business_v1',
      productName: 'Local Business Pro Plan',
    },
    'real-estate': {
      lookupKey: 'ariyalab_pro_real_estate_v1',
      productName: 'Real Estate Pro Plan',
    },
  },
  yearly: {
    default: { lookupKey: PLANS.yearly.lookupKey, productName: PLANS.yearly.name },
    'glow-up': {
      lookupKey: 'ariyalab_yearly_glow_up_v1',
      productName: 'Glow Up Yearly Plan',
    },
    'interior-design': {
      lookupKey: 'ariyalab_yearly_interior_v1',
      productName: 'AI Interior Yearly Plan',
    },
    'local-business': {
      lookupKey: 'ariyalab_yearly_local_business_v1',
      productName: 'Local Business Yearly Plan',
    },
    'real-estate': {
      lookupKey: 'ariyalab_yearly_real_estate_v1',
      productName: 'Real Estate Yearly Plan',
    },
  },
};

const priceCache = new Map(); // `${plan}:${surface}` -> price object

/**
 * Returns an active Stripe Price for the given plan + surface,
 * creating the Product + Price the first time it's needed.
 * Idempotent — uses `lookup_key` so we don't create duplicates
 * across deploys. When `surface` is omitted or unknown, falls back
 * to the 'default' variant (the legacy Sonallo Monthly / Yearly).
 */
export async function getOrCreatePrice(plan, surface = 'default') {
  const planCfg = PLANS[plan];
  if (!planCfg) throw new Error(`Unknown plan: ${plan}`);
  const surfaces = PLAN_SURFACES[plan] || {};
  const variant = surfaces[surface] || surfaces.default;
  if (!variant) throw new Error(`No variant for ${plan}/${surface}`);

  const cacheKey = `${plan}:${surface in surfaces ? surface : 'default'}`;
  if (priceCache.has(cacheKey)) return priceCache.get(cacheKey);

  const existing = await stripe().prices.list({
    lookup_keys: [variant.lookupKey],
    limit: 1,
    active: true,
    expand: ['data.product'],
  });

  if (existing.data.length > 0) {
    priceCache.set(cacheKey, existing.data[0]);
    return existing.data[0];
  }

  const product = await stripe().products.create({
    name: variant.productName,
    metadata: { plan, surface: surface in surfaces ? surface : 'default' },
  });

  const price = await stripe().prices.create({
    product: product.id,
    lookup_key: variant.lookupKey,
    unit_amount: planCfg.amountCents,
    currency: 'usd',
    recurring: { interval: planCfg.interval },
  });

  priceCache.set(cacheKey, price);
  return price;
}

/**
 * Given a Stripe Price ID or expanded Price, return our internal
 * plan name ('monthly'|'yearly'|null) by matching its lookup_key.
 * Recognizes both the legacy lookup keys (PLANS.{plan}.lookupKey)
 * and every per-surface variant lookup key, so a customer who
 * subscribed via "Glow Up Monthly Plan" still resolves to 'monthly'.
 */
export function planFromPrice(priceOrId) {
  const lookup =
    typeof priceOrId === 'string' ? null : priceOrId?.lookup_key || null;
  if (!lookup) return null;
  // Billing v2 plans (ariya_v2_<plan>_<interval>_<cents>_<credits>).
  const v2 = parseV2LookupKey(lookup);
  if (v2?.kind === 'plan') return v2.plan;
  // Legacy direct match against PLANS.
  for (const [name, cfg] of Object.entries(PLANS)) {
    if (cfg.lookupKey === lookup) return name;
  }
  // Per-surface variants — all roll up to the same plan name.
  for (const [planName, surfaces] of Object.entries(PLAN_SURFACES)) {
    for (const variant of Object.values(surfaces)) {
      if (variant.lookupKey === lookup) return planName;
    }
  }
  return null;
}


/**
 * Given a Stripe Price (expanded), return the top-up pack config
 * (key + config including `kind: 'video' | 'image'`), or null if it's
 * not one of our top-up prices.
 */
export function topupFromPrice(priceOrId) {
  const lookup =
    typeof priceOrId === 'string' ? null : priceOrId?.lookup_key || null;
  if (!lookup) return null;
  // Billing v2 packs (ariya_v2_topup_<pack>_<cents>_<credits>). Their keys
  // (s/m/l) are the legacy pack keys too: `v2: true` tells them apart, and
  // what they grant is in `credits` (already v2 credits, never converted).
  const v2 = parseV2LookupKey(lookup);
  if (v2?.kind === 'topup') {
    return {
      key: v2.pack,
      kind: 'video',
      v2: true,
      name: `Sonallo Credits (${v2.credits.toLocaleString('en-US')})`,
      lookupKey: lookup,
      amountCents: v2.amountCents,
      credits: v2.credits,
    };
  }
  for (const [key, cfg] of Object.entries(TOPUPS)) {
    if (cfg.lookupKey === lookup) return { key, ...cfg };
  }
  return null;
}

const topupPriceCache = new Map();

/**
 * Idempotently get or create a one-time Stripe Price for a top-up pack.
 * Mirrors getOrCreatePrice but without a recurring interval.
 */
export async function getOrCreateTopupPrice(packKey) {
  const config = TOPUPS[packKey];
  if (!config) throw new Error(`Unknown top-up pack: ${packKey}`);

  if (topupPriceCache.has(packKey)) return topupPriceCache.get(packKey);

  const existing = await stripe().prices.list({
    lookup_keys: [config.lookupKey],
    limit: 1,
    active: true,
    expand: ['data.product'],
  });

  if (existing.data.length > 0) {
    topupPriceCache.set(packKey, existing.data[0]);
    return existing.data[0];
  }

  const product = await stripe().products.create({
    name: config.name,
    metadata: { topup: packKey, credits: String(config.credits) },
  });

  const price = await stripe().prices.create({
    product: product.id,
    lookup_key: config.lookupKey,
    unit_amount: config.amountCents,
    currency: 'usd',
    // No `recurring` — one-time payment.
  });

  topupPriceCache.set(packKey, price);
  return price;
}

// ---------------------------------------------------------------- billing v2

/*
 * Billing v2 prices (Task 27). Every v2 lookup key starts with V2_PREFIX and
 * carries what the price is: the amount in cents and the credits it grants
 * (for a yearly plan: the credits granted each month).
 *
 *   ariya_v2_<starter|creator|studio>_<month|year>_<cents>_<credits>
 *   ariya_v2_topup_<s|m|l>_<cents>_<credits>
 *
 * Stripe prices cannot change, so a price edited in the admin pricing editor
 * is a NEW lookup key (new price); subscribers on the old price keep renewing
 * on it and keep getting the credits that price was sold with. The grant
 * reads the credits from the price's own lookup key, never from today's
 * config, so what was shown at checkout is what is granted. Legacy keys
 * (ariyalab_*) are untouched. haelabs.live never uses either prefix.
 */
export const V2_PREFIX = 'ariya_v2_';
export const V2_PLAN_NAMES = ['starter', 'creator', 'studio'];
export const V2_PACKS = ['s', 'm', 'l'];
const V2_PLAN_RE = /^ariya_v2_(starter|creator|studio)_(month|year)_([1-9]\d{0,7})_([1-9]\d{0,7})$/;
const V2_TOPUP_RE = /^ariya_v2_topup_(s|m|l)_([1-9]\d{0,7})_([1-9]\d{0,7})$/;

/** What a v2 lookup key sells, or null when it is not a v2 key. */
export function parseV2LookupKey(lookup) {
  if (typeof lookup !== 'string' || !lookup.startsWith(V2_PREFIX)) return null;
  let m = V2_PLAN_RE.exec(lookup);
  if (m) {
    return { kind: 'plan', plan: m[1], interval: m[2], amountCents: Number(m[3]), credits: Number(m[4]) };
  }
  m = V2_TOPUP_RE.exec(lookup);
  if (m) return { kind: 'topup', pack: m[1], amountCents: Number(m[2]), credits: Number(m[3]) };
  return null;
}

export function v2PlanLookupKey({ plan, interval, amountCents, credits }) {
  return `${V2_PREFIX}${plan}_${interval}_${amountCents}_${credits}`;
}
export function v2TopupLookupKey({ pack, amountCents, credits }) {
  return `${V2_PREFIX}topup_${pack}_${amountCents}_${credits}`;
}

export const isV2Plan = (plan) => V2_PLAN_NAMES.includes(plan);

/**
 * What a subscription price is: { plan, version: 'v2'|'legacy', interval,
 * amountCents, credits } or null when it is not this app's. For a legacy plan
 * `credits` is its legacy cap; for a v2 plan the credits each month.
 */
export function planInfoFromPrice(price) {
  const lookup = price && typeof price === 'object' ? price.lookup_key : null;
  const v2 = parseV2LookupKey(lookup);
  if (v2?.kind === 'plan') {
    return { plan: v2.plan, version: 'v2', interval: v2.interval, amountCents: v2.amountCents, credits: v2.credits };
  }
  const plan = v2 ? null : planFromPrice(price);
  if (!plan || !PLANS[plan]) return null;
  return { plan, version: 'legacy', interval: PLANS[plan].interval, amountCents: PLANS[plan].amountCents, credits: CAPS[plan] };
}

/** Cents charged for a plan (the price's own amount when it is a v2 price). */
export function planAmountCents(plan, price) {
  const info = price ? planInfoFromPrice(price) : null;
  if (info) return info.amountCents;
  if (PLANS[plan]) return PLANS[plan].amountCents;
  if (isV2Plan(plan)) return PLANS_V2[plan].usd * 100;
  return 0;
}

/** A plan's credits per period in its own units (legacy cap, or v2 credits per month). */
export function planCap(plan, price) {
  const info = price ? planInfoFromPrice(price) : null;
  if (info) return info.credits;
  if (CAPS[plan] !== undefined) return CAPS[plan];
  if (isV2Plan(plan)) return PLANS_V2[plan].credits;
  return 0;
}

const v2PriceCache = new Map(); // lookup key -> price

/**
 * Get or create the Stripe price for a v2 offer. `offer` is
 * { kind: 'plan', plan, interval, amountCents, credits } or
 * { kind: 'topup', pack, amountCents, credits }, worked out by the caller from
 * the current pricing config (lib/pricing.js v2Offers). Idempotent on the
 * lookup key, which names the amount and credits.
 */
export async function getOrCreateV2Price(offer) {
  const isPlan = offer.kind === 'plan';
  if (isPlan ? !isV2Plan(offer.plan) || !['month', 'year'].includes(offer.interval) : !V2_PACKS.includes(offer.pack)) {
    throw new Error('Unknown v2 offer');
  }
  if (!Number.isInteger(offer.amountCents) || offer.amountCents <= 0 || !Number.isInteger(offer.credits) || offer.credits <= 0) {
    throw new Error('Invalid v2 offer amount');
  }
  const lookupKey = isPlan ? v2PlanLookupKey(offer) : v2TopupLookupKey(offer);
  if (v2PriceCache.has(lookupKey)) return v2PriceCache.get(lookupKey);

  const found = await findV2Price(lookupKey);
  if (found) {
    v2PriceCache.set(lookupKey, found);
    return found;
  }
  const label = (n) => n.toLocaleString('en-US');
  const name = isPlan
    ? `Sonallo ${offer.plan[0].toUpperCase()}${offer.plan.slice(1)} (${offer.interval === 'year' ? 'yearly' : 'monthly'}, ${label(offer.credits)} credits a month)`
    : `Sonallo Credits (${label(offer.credits)})`;
  const product = await stripe().products.create({
    name,
    metadata: isPlan
      ? { billing: 'v2', plan: offer.plan, interval: offer.interval, credits: String(offer.credits) }
      : { billing: 'v2', topup: offer.pack, credits: String(offer.credits) },
  });
  let price;
  try {
    price = await stripe().prices.create({
      product: product.id,
      lookup_key: lookupKey,
      unit_amount: offer.amountCents,
      currency: 'usd',
      ...(isPlan ? { recurring: { interval: offer.interval } } : {}),
      metadata: { billing: 'v2', credits: String(offer.credits) },
    });
  } catch (err) {
    // Two first clicks at once: the other request created it. Never transfer
    // the key (subscribers on an older price with this key would lose it).
    price = await findV2Price(lookupKey);
    if (!price) throw err;
  }
  v2PriceCache.set(lookupKey, price);
  return price;
}

/**
 * The price with this lookup key, active or archived (an archived one is
 * reactivated: the key names its exact amount and credits, so it is the same
 * offer). null when none exists.
 */
async function findV2Price(lookupKey) {
  const list = await stripe().prices.list({ lookup_keys: [lookupKey], limit: 10, expand: ['data.product'] });
  const all = list?.data || [];
  const active = all.find((p) => p.active);
  if (active) return active;
  const archived = all[0];
  if (!archived) return null;
  return stripe().prices.update(archived.id, { active: true });
}
