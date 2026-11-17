// Credit prices and plan data. Constants live in lib/pricingConstants.js
// (import-free, safe for client bundles) and are re-exported here.
// Rates can be overridden at runtime through `pricing_config` rows
// ({ key, value jsonb }); a row whose key matches a top-level key of
// DEFAULTS replaces that key (object values shallow-merge), other keys are
// ignored here. Reads are cached for 60 seconds and fall back to the
// defaults when the table cannot be read.

import { getSupabaseAdmin } from './supabaseServer.js';
import {
  PLANS_V2, TOPUPS_V2, YEARLY_DISCOUNT, LEGACY_TO_V2, DEFAULTS, QUALITY_LABELS, projectFeeFor, generatedSeconds,
} from './pricingConstants.js';

export { PLANS_V2, TOPUPS_V2, YEARLY_DISCOUNT, LEGACY_TO_V2, QUALITY_LABELS, projectFeeFor, generatedSeconds };

const CACHE_MS = 60_000;
const RETRY_MS = 5_000; // after a failed read

let testDb = null;
let cache = null; // { at, rows, ttl }
let lastGood = null; // rows from the last successful read

/** Tests inject a PGlite-style handle ({ query }). Pass null to use the admin client. */
export function setPricingDb(db) {
  testDb = db;
  cache = null;
  lastGood = null;
}

export function _resetPricingCache() {
  cache = null;
  lastGood = null;
}

async function loadRows() {
  if (testDb) {
    const { rows } = await testDb.query('select key, value from public.pricing_config');
    return rows;
  }
  const { data, error } = await getSupabaseAdmin().from('pricing_config').select('key, value');
  if (error) throw error;
  return data || [];
}

/**
 * Cached pricing_config rows ([{ key, value }]); [] when the read fails.
 * Shared by getPricing() and lib/billingFlags.js.
 */
export async function readPricingConfig() {
  const now = Date.now();
  if (cache && now - cache.at < cache.ttl) return cache.rows;
  try {
    const rows = await loadRows();
    lastGood = rows;
    cache = { at: now, rows, ttl: CACHE_MS };
  } catch (err) {
    console.error('pricing_config read failed:', err?.message || err);
    // Keep the last good rows if there are any, else defaults; retry soon.
    cache = { at: now, rows: lastGood || [], ttl: RETRY_MS };
  }
  return cache.rows;
}

/**
 * Like readPricingConfig(), but throws when pricing_config has never been
 * read successfully on this instance and the current read failed. For money
 * paths that must not fall back to defaults (lib/billingFlags.js
 * isBillingV2Strict).
 */
export async function readPricingConfigStrict() {
  const rows = await readPricingConfig();
  if (lastGood === null) throw new Error('pricing_config_unavailable');
  return rows;
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export async function getPricing() {
  const merged = structuredClone(DEFAULTS);
  for (const { key, value } of await readPricingConfig()) {
    if (!Object.hasOwn(DEFAULTS, key)) continue;
    if (isPlainObject(DEFAULTS[key]) && isPlainObject(value)) {
      merged[key] = { ...merged[key], ...structuredClone(value) };
    } else {
      merged[key] = structuredClone(value);
    }
  }
  return merged;
}

/** Credits for one shot with a pricing object already read (getPricing()). */
export function creditsForShot(pricing, quality, seconds) {
  return shotCredits(pricing, quality, seconds);
}

function shotCredits(pricing, quality, seconds) {
  const rate = Object.hasOwn(pricing.perSecond, quality) ? pricing.perSecond[quality] : undefined;
  if (typeof rate !== 'number') throw new Error(`Unknown quality: ${quality}`);
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`Invalid seconds: ${seconds}`);
  }
  return generatedSeconds(pricing, quality, seconds) * rate;
}

/** Credits for one shot: generated seconds rounded up, at least the quality's minimum (3; economy 4), times the quality rate. */
export async function quoteShot({ quality, seconds }) {
  return shotCredits(await getPricing(), quality, seconds);
}

/** Total for a set of shots plus the project fee unless already charged. One line per quality. */
export async function quoteProject({ shots, feeAlreadyCharged, seconds }) {
  const pricing = await getPricing();
  const groups = new Map();
  for (const shot of shots) {
    const g = groups.get(shot.quality) || { count: 0, credits: 0 };
    g.count += 1;
    g.credits += shotCredits(pricing, shot.quality, shot.seconds);
    groups.set(shot.quality, g);
  }
  const lines = [];
  if (!feeAlreadyCharged) lines.push({ label: 'Project fee', credits: projectFeeFor(pricing, seconds) });
  for (const [quality, g] of groups) {
    lines.push({ label: `${g.count} ${QUALITY_LABELS[quality] || quality} ${g.count === 1 ? 'shot' : 'shots'}`, credits: g.credits });
  }
  return { total: lines.reduce((n, l) => n + l.credits, 0), lines };
}

const posInt = (v) => Number.isInteger(v) && v > 0;
const posNum = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

/** Discount for yearly plans from a pricing object: a number in [0, 0.9], else 0. */
export function yearlyDiscountOf(pricing) {
  const d = pricing?.yearlyDiscount;
  return typeof d === 'number' && Number.isFinite(d) && d >= 0 && d <= 0.9 ? d : 0;
}

/**
 * What billing v2 sells right now, from a pricing object (getPricing()):
 *   plans:  { starter: { usd, credits, monthlyCents, yearlyCents, yearlyUsd } , ... }
 *   topups: { s: { usd, credits, cents }, ... }
 *   yearlyDiscount
 * Each plan or pack merges over the PLANS_V2 / TOPUPS_V2 default; an entry
 * whose usd or credits is not a positive number falls back to the default.
 * The yearly price is 12 x monthly less yearlyDiscount, rounded to the cent;
 * a yearly plan grants the monthly credits each month.
 */
export function v2Offers(pricing) {
  const discount = yearlyDiscountOf(pricing);
  const plans = {};
  for (const [key, def] of Object.entries(PLANS_V2)) {
    const cfg = { ...def, ...(isPlainObject(pricing?.plans?.[key]) ? pricing.plans[key] : {}) };
    const usd = posNum(cfg.usd) ? cfg.usd : def.usd;
    const credits = posInt(cfg.credits) ? cfg.credits : def.credits;
    const monthlyCents = Math.round(usd * 100);
    const yearlyCents = Math.round(monthlyCents * 12 * (1 - discount));
    plans[key] = { usd, credits, monthlyCents, yearlyCents, yearlyUsd: yearlyCents / 100 };
  }
  const topups = {};
  for (const [key, def] of Object.entries(TOPUPS_V2)) {
    const cfg = { ...def, ...(isPlainObject(pricing?.topups?.[key]) ? pricing.topups[key] : {}) };
    const usd = posNum(cfg.usd) ? cfg.usd : def.usd;
    const credits = posInt(cfg.credits) ? cfg.credits : def.credits;
    topups[key] = { usd, credits, cents: Math.round(usd * 100) };
  }
  return { plans, topups, yearlyDiscount: discount };
}

/** The raw pricing_config rows, read now (no cache). For the admin pricing editor. */
export async function readPricingRowsFresh() {
  return loadRows();
}

/**
 * Writes one pricing_config row (admin pricing editor; the caller validated
 * it) and drops this instance's cache. Other server instances keep their
 * cached rows for up to 60 s (CACHE_MS).
 */
export async function writePricingConfig(key, value) {
  if (testDb) {
    await testDb.query(
      `insert into public.pricing_config (key, value) values ($1, $2::jsonb)
       on conflict (key) do update set value = excluded.value, updated_at = now()`,
      [key, JSON.stringify(value)]
    );
  } else {
    const { error } = await getSupabaseAdmin().from('pricing_config').upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
    if (error) throw error;
  }
  _resetPricingCache();
}

/**
 * True once scripts/migrate-legacy-credits.mjs --apply moved anyone
 * (credit_legacy_migrations has a row): billing v2 is then one-way.
 */
export async function legacyMigrationRan() {
  if (testDb) {
    const { rows } = await testDb.query('select exists (select 1 from public.credit_legacy_migrations) as ran');
    return rows[0].ran === true;
  }
  const { data, error } = await getSupabaseAdmin().from('credit_legacy_migrations').select('customer_id').limit(1);
  if (error) throw error;
  return (data || []).length > 0;
}
