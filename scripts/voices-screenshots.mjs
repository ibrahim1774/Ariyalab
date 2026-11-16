/*
 * Screenshots of /app/voices and the Voice and sound step with a cloned voice (Task 24). Nothing here calls a
 * provider: the dev server runs with STORY_MOCK=1 and Supabase env blank, and every /api/story call is answered by
 * the stubs below (so the screens show stub data, not data from the real routes).
 *
 *   STORY_MOCK=1 NEXT_PUBLIC_SUPABASE_URL= NEXT_PUBLIC_SUPABASE_ANON_KEY= npx next dev -p 3224 &
 *   PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core CHROME_PATH=/path/to/chrome \
 *     node scripts/voices-screenshots.mjs
 *
 * BASE_URL (default http://localhost:3224), OUT_DIR (default .superpowers/sdd/2026-11-14-story-video-maker/shots-task24).
 */
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const base = process.env.BASE_URL || 'http://localhost:3224';
const dir = process.env.OUT_DIR || '.superpowers/sdd/2026-11-14-story-video-maker/shots-task24';
mkdirSync(dir, { recursive: true });
const scen = JSON.parse(await (await fetch(base + '/mock/scenarios.json')).text());
const project = { ...scen.scen.generate.project, step: 'audio', quality: 'pro_narrated' };

const STATEMENT = 'I confirm that this recording is my own voice, or that the speaker has given me their permission to clone it. The clone is private to my account, and I will not use it to imitate anyone else or to mislead people.';
const voice = (o = {}) => ({ id: 'c1', name: 'Maya', status: 'ready', error: null, voiceId: 'mock-voice-1', sampleUrl: '/api/mock/fixtures/voice.mp3', seconds: 14, consent_at: '2026-11-14T10:00:00.000Z', created_at: '2026-11-14T10:00:00.000Z', credits: 20, retry_credits: null, ...o });
const PRESETS = [
  { id: 'v1', name: 'Sarah', gender: 'female', sampleUrl: '/api/mock/fixtures/voice.mp3' },
  { id: 'v2', name: 'Adrian', gender: 'male', sampleUrl: '/api/mock/fixtures/voice.mp3' },
  { id: 'v3', name: 'Ethan', gender: 'male', sampleUrl: null },
];
const listing = (voices) => ({ voices, presets: PRESETS, price: 20, statement: STATEMENT, limits: { sampleMinSeconds: 10, sampleMaxSeconds: 60, maxBytes: 20 * 1024 * 1024 } });
const pages = {
  'voices-full': listing([
    voice(),
    voice({ id: 'c2', name: 'Leo', status: 'failed', voiceId: null, sampleUrl: null, error: 'The service is busy right now. Please try again in a minute.', retry_credits: 20 }),
    voice({ id: 'c3', name: 'Nora', status: 'pending', voiceId: null, sampleUrl: null }),
  ]),
  'voices-empty': listing([]),
};

const t = (o = {}) => ({ status: 'none', url: null, error: null, source: 'generated', credits: 0, retry_credits: null, included: 3, used: 0, free_left: 3, ...o });
const VOICES = [
  { id: 'v1', name: 'Sarah', gender: 'female', sampleUrl: '/api/mock/fixtures/voice.mp3' },
  { id: 'v2', name: 'Adrian', gender: 'male', sampleUrl: '/api/mock/fixtures/voice.mp3' },
  { id: 'v3', name: 'Ethan', gender: 'male', sampleUrl: null },
  { id: 'mock-voice-1', name: 'Maya', gender: null, sampleUrl: '/api/mock/fixtures/voice.mp3', own: true },
];
const audio = (voiceId, extra = {}) => ({
  plan: { mode: 'narrated', voiceId, voiceTrackAssetId: null, music: { type: 'generated', prompt: 'Warm, hopeful piano with a soft beat', assetId: null }, captions: { on: true, style: 'serif_accent' } },
  uploads: { voiceTrack: null, music: null },
  voices: VOICES, applicable: { narration: true, narrationLines: 4 },
  narration: { ...t(), seconds: null, segments: null, outdated: false }, music: { ...t(), type: 'generated' }, ...extra,
});
const steps = {
  'step-clone': audio('mock-voice-1'),
  'step-nopreview': audio('v3'),
};

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
const out = [];
const measure = (page) => page.evaluate(() => {
  const vw = innerWidth;
  const small = vw < 761 ? [...document.querySelectorAll('button,a,summary,input[type=text],label')].filter((e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && r.height < 43.5 && cs.visibility !== 'hidden' && !e.closest('audio') && !e.closest('header,nav,aside') && !e.closest('[class*="stepper"]'); }).map((e) => (e.textContent || e.getAttribute('aria-label') || e.tagName).trim().slice(0, 18) + ':' + Math.round(e.getBoundingClientRect().height)).slice(0, 8) : [];
  return { overflowX: document.documentElement.scrollWidth > vw + 1, tapUnder44: small, pageHeight: document.documentElement.scrollHeight };
});
for (const [w, h] of [[1280, 720], [390, 844]]) {
  for (const [name, kind] of [...Object.keys(pages).map((n) => [n, 'page']), ...Object.keys(steps).map((n) => [n, 'step'])]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const page = await ctx.newPage();
    await page.route('**/api/story/**', (r) => {
      const u = new URL(r.request().url()).pathname;
      const j = (b, s = 200) => r.fulfill({ status: s, contentType: 'application/json', body: JSON.stringify(b) });
      if (u.endsWith('/voices')) return j(pages[name] || listing([]));
      if (u.endsWith('/audio')) return j({ audio: steps[name] });
      if (u.endsWith('/status')) return j({ project, shots: scen.scen.generate.shots, cast: scen.scen.generate.cast || [], jobs: [], balance: null, render: null });
      if (u.endsWith('/billing')) return j({ v2: true, balance: { available: 900 }, history: [] });
      if (u.endsWith('/pricing')) return j({ pricing: { perSecond: { economy: 8, standard: 11, pro_narrated: 14, pro_talking: 21 }, projectFee: 90, stillReroll: 2, castRegen: 5, narrationRegen: 5, musicRegen: 5, voiceClone: 20, included: { castRegenPerCharacter: 2, narration: 3, music: 3 }, freeRerollShare: 0.2 } });
      if (u.endsWith('/quote')) return j({ total: 510, lines: [{ label: 'Project fee', credits: 90 }, { label: '10 Pro narrated shots', credits: 420 }] });
      return j({ error: 'not_found' }, 404);
    });
    await page.goto(kind === 'page' ? `${base}/app/voices` : `${base}/app/p/p1`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(kind === 'page' ? '[aria-label="Included voices"]' : '[data-section="narration"]', { timeout: 90000 });
    await page.waitForTimeout(1200);
    const m = await measure(page);
    await page.screenshot({ path: `${dir}/${name}-${w}x${h}.png` });
    if (h > 800) await page.screenshot({ path: `${dir}/${name}-${w}x${h}-full.png`, fullPage: true });
    out.push(`${name} ${w}x${h}: ${JSON.stringify(m)}`);
    await ctx.close();
  }
}
await browser.close();
console.log(out.join('\n'));
