import { readPricingConfig, readPricingConfigStrict } from './pricing.js';

/** True when pricing_config key `billing_v2` is true. Default false; cached 60s with the pricing rows. */
export async function isBillingV2() {
  const row = (await readPricingConfig()).find((r) => r.key === 'billing_v2');
  return row?.value === true;
}

/**
 * Same flag for money paths (grants, refunds, claims). Throws instead of
 * answering "legacy" when the flag has never been read successfully on this
 * instance and the current read fails, so a cold instance during a database
 * blip retries (webhook 500) rather than granting on the wrong path.
 */
export async function isBillingV2Strict() {
  const row = (await readPricingConfigStrict()).find((r) => r.key === 'billing_v2');
  return row?.value === true;
}

/**
 * How a profile that already points at a live Stripe customer may be moved
 * to another one (lib/entitlement.js assertCanLink). pricing_config key
 * `relink_mode`:
 *   'support' (default, and any value other than 'auto'): only the admin
 *             tool moves it; every customer-triggered path answers 409.
 *   'auto':   customer-triggered paths may move it under the relink rules.
 * Read strictly, like isBillingV2Strict: throws when the config has never
 * been read on this instance and cannot be read now.
 */
export async function relinkModeStrict() {
  const row = (await readPricingConfigStrict()).find((r) => r.key === 'relink_mode');
  return row?.value === 'auto' ? 'auto' : 'support';
}
