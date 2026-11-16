// Credit prices and plan data. Constants live in lib/pricingConstants.js
// (import-free, safe for client bundles) and are re-exported here.
// Rates can be overridden at runtime through `pricing_config` rows
// ({ key, value jsonb }); a row whose key matches a top-level key of
// DEFAULTS replaces that key (object values shallow-merge), other keys are
// ignored here. Reads are cached for 60 seconds and fall back to the
// defaults when the table cannot be read.

import { getSupabaseAdmin } from './supabaseServer.js';
import {
  PLANS_V2, TOPUPS_V2, YEARLY_DISCOUNT, LEGACY_TO_V2, DEFAULTS, QUALITY_LABELS,
} from './pricingConstants.js';

export { PLANS_V2, TOPUPS_V2, YEARLY_DISCOUNT, LEGACY_TO_V2, QUALITY_LABELS };

const MIN_SECONDS = 3;
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

/** Seconds a shot is generated (and priced) at: rounded up, at least the quality's minimum (3 by default). */
export function generatedSeconds(pricing, quality, seconds) {
  const min = Number.isInteger(pricing.minSeconds?.[quality]) ? pricing.minSeconds[quality] : MIN_SECONDS;
  return Math.max(min, Math.ceil(seconds));
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
export async function quoteProject({ shots, feeAlreadyCharged }) {
  const pricing = await getPricing();
  const groups = new Map();
  for (const shot of shots) {
    const g = groups.get(shot.quality) || { count: 0, credits: 0 };
    g.count += 1;
    g.credits += shotCredits(pricing, shot.quality, shot.seconds);
    groups.set(shot.quality, g);
  }
  const lines = [];
  if (!feeAlreadyCharged) lines.push({ label: 'Project fee', credits: pricing.projectFee });
  for (const [quality, g] of groups) {
    lines.push({ label: `${g.count} ${QUALITY_LABELS[quality] || quality} ${g.count === 1 ? 'shot' : 'shots'}`, credits: g.credits });
  }
  return { total: lines.reduce((n, l) => n + l.credits, 0), lines };
}
