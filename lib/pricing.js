// Credit prices and plan data. Single source of truth: the homepage
// (components/marketing/pricingData.js) and every route read from here.
// Rates can be overridden at runtime through `pricing_config` rows
// ({ key, value jsonb }); a row whose key matches a top-level key of
// DEFAULTS replaces that key (object values shallow-merge), other keys are
// ignored here. Reads are cached for 60 seconds and fall back to the
// defaults when the table cannot be read.

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

const DEFAULTS = {
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

const MIN_SECONDS = 3;
const CACHE_MS = 60_000;

let testDb = null;
let cache = null; // { at, rows }

/** Tests inject a PGlite-style handle ({ query }). Pass null to use the admin client. */
export function setPricingDb(db) {
  testDb = db;
  cache = null;
}

export function _resetPricingCache() {
  cache = null;
}

async function loadRows() {
  if (testDb) {
    const { rows } = await testDb.query('select key, value from public.pricing_config');
    return rows;
  }
  // Lazy import keeps the service-role client out of client bundles that only
  // want the constants above.
  const { getSupabaseAdmin } = await import('./supabaseServer.js');
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
  if (cache && now - cache.at < CACHE_MS) return cache.rows;
  let rows;
  try {
    rows = await loadRows();
  } catch (err) {
    console.error('pricing_config read failed, using defaults:', err?.message || err);
    rows = [];
  }
  cache = { at: now, rows };
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

function shotCredits(pricing, quality, seconds) {
  const rate = Object.hasOwn(pricing.perSecond, quality) ? pricing.perSecond[quality] : undefined;
  if (typeof rate !== 'number') throw new Error(`Unknown quality: ${quality}`);
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`Invalid seconds: ${seconds}`);
  }
  return Math.max(MIN_SECONDS, Math.ceil(seconds)) * rate;
}

/** Credits for one shot: generated seconds rounded up, minimum 3, times the quality rate. */
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
    lines.push({ label: `${g.count} ${quality} ${g.count === 1 ? 'shot' : 'shots'}`, credits: g.credits });
  }
  return { total: lines.reduce((n, l) => n + l.credits, 0), lines };
}
