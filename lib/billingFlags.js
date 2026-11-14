import { readPricingConfig } from './pricing.js';

/** True when pricing_config key `billing_v2` is true. Default false; cached 60s with the pricing rows. */
export async function isBillingV2() {
  const row = (await readPricingConfig()).find((r) => r.key === 'billing_v2');
  return row?.value === true;
}
