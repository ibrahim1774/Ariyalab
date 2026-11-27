/*
 * Which optional provider features this deployment has keys for. Booleans only: no key, name or value
 * ever leaves the server (served by /api/story/capabilities, read by the "Start from a video" screen).
 *
 *   linkDownload   pasting an Instagram / TikTok / Facebook link: APIFY_TOKEN or SCRAPECREATORS_API_KEY
 *   transcription  speech to text: GROQ_API_KEY or REPLICATE_API_TOKEN
 *
 * Mock mode (tests, local dev) has everything, as the mock providers do.
 */

import { PROVIDER_CONFIG } from './config.js';
import { isMock } from './mock.js';

const has = (name) => Boolean(process.env[name]);

export function linkDownloadConfigured() {
  return isMock() || has(PROVIDER_CONFIG.apify.env) || has(PROVIDER_CONFIG.scrapecreators.env);
}

export function transcriptionConfigured() {
  return isMock() || has(PROVIDER_CONFIG.groq.env) || has(PROVIDER_CONFIG.replicate.env);
}

export function storyCapabilities() {
  return { linkDownload: linkDownloadConfigured(), transcription: transcriptionConfigured() };
}

const warned = new Set();
/** One server log line per feature per process, so a missing key is visible without flooding the log. */
export function logMissing(feature, effect) {
  if (warned.has(feature)) return;
  warned.add(feature);
  console.warn(`[story] ${feature} is not configured; ${effect}`);
}
