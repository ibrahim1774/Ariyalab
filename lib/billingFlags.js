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
