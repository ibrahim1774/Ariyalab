/*
 * Screenshots of the Voice and sound step in mock mode (Task 19). Nothing here calls a provider: the dev server
 * runs with STORY_MOCK=1 and Supabase env blank, and every /api/story call is answered by the stubs below.
 *
 *   STORY_MOCK=1 NEXT_PUBLIC_SUPABASE_URL= NEXT_PUBLIC_SUPABASE_ANON_KEY= npx next dev -p 3219 &
 *   PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core CHROME_PATH=/path/to/chrome-headless-shell \
 *     node scripts/audio-screenshots.mjs
 *
 * PLAYWRIGHT_CORE: a playwright-core package directory. CHROME_PATH: a headless Chrome binary.
 * BASE_URL (default http://localhost:3219), OUT_DIR (default .superpowers/sdd/2026-11-14-story-video-maker/shots-task19).
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const base = process.env.BASE_URL || 'http://localhost:3219';
const dir = process.env.OUT_DIR || '.superpowers/sdd/2026-11-14-story-video-maker/shots-task19';
const exe = process.env.CHROME_PATH;
const scen = JSON.parse(await (await fetch(base + '/mock/scenarios.json')).text());
const project = { ...scen.scen.generate.project, step: 'audio', quality: 'pro_narrated' };
const SEG = [
  ['s1', 0, 'Every Saturday the line outside Jack’s started before sunrise.', 0.0, 3.4],
  ['s2', 0, 'Nobody minded waiting, because the stories in line were half the fun.', 3.7, 7.9],
  ['s3', 0, 'Then the barber lifted the blinds, and the whole street smiled.', 8.2, 12.1],
  ['s4', 0, 'That was the day Jack knew the shop was home.', 12.4, 15.6],
].map(([sceneId, lineIndex, text, start, end]) => ({ sceneId, lineIndex, text, start, end }));
const t = (o = {}) => ({ status: 'none', url: null, error: null, source: 'generated', credits: 0, retry_credits: null, included: 3, used: 0, free_left: 3, ...o });
const VOICES = [{ id: 'v1', name: 'Sarah', gender: 'female', sampleUrl: null }, { id: 'v2', name: 'Adrian', gender: 'male', sampleUrl: null }, { id: 'v3', name: 'Ethan', gender: 'male', sampleUrl: null }];
const audio = (n = {}, m = {}, plan = {}) => ({
  plan: { mode: 'narrated', voiceId: 'v1', voiceTrackAssetId: null, music: { type: 'generated', prompt: 'Warm, hopeful piano with a soft beat', assetId: null }, captions: { on: true, style: 'serif_accent' }, ...plan },
  voices: VOICES, applicable: { narration: true, narrationLines: 4 },
  narration: { ...t(), seconds: null, segments: null, outdated: false, ...n }, music: { ...t(), type: 'generated', ...m },
});
const READY_N = { status: 'ready', url: '/api/mock/fixtures/voice.mp3', seconds: 15.6, segments: SEG, used: 1, free_left: 2 };
const READY_M = { status: 'ready', url: '/api/mock/fixtures/music.mp3', used: 1, free_left: 2 };
const scenarios = {
  empty: audio(),
  ready: audio(READY_N, READY_M),
  waiting: audio({ status: 'pending', used: 1, free_left: 2 }, { status: 'pending', used: 1, free_left: 2 }),
  failed: audio({ status: 'failed', error: 'Something went wrong while making your voice. Please try again.', retry_credits: 5, credits: 5, used: 4, free_left: 0, url: '/api/mock/fixtures/voice.mp3', segments: SEG, seconds: 15.6 }, { status: 'blocked', credits: 5, free_left: 0, used: 3, error: 'This music description was stopped by our content rules. Change it and try again.' }),
};
const browser = await chromium.launch({ executablePath: exe, headless: true });
const out = [];
for (const [w, h] of [[1280, 720], [390, 844]]) {
  for (const [name, view] of Object.entries(scenarios)) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const page = await ctx.newPage();
    await page.route('**/api/story/**', (r) => {
      const u = new URL(r.request().url()).pathname;
      const j = (b, s = 200) => r.fulfill({ status: s, contentType: 'application/json', body: JSON.stringify(b) });
      if (u.endsWith('/audio')) return j({ audio: view });
      if (u.endsWith('/status')) return j({ project, shots: scen.scen.generate.shots, cast: scen.scen.generate.cast || [], jobs: [], balance: null, render: null });
      if (u.endsWith('/billing')) return j({ v2: true, balance: { available: 900 }, history: [] });
      if (u.endsWith('/pricing')) return j({ pricing: { perSecond: { economy: 7, standard: 8, pro_narrated: 16, pro_talking: 21 }, projectFee: 90, stillReroll: 2, castRegen: 5, narrationRegen: 5, musicRegen: 5, included: { castRegenPerCharacter: 2, narration: 3, music: 3 }, freeRerollShare: 0.2 } });
      if (u.endsWith('/quote')) return j({ total: 510, lines: [{ label: 'Project fee', credits: 90 }, { label: '10 Pro narrated shots', credits: 420 }] });
      return j({ error: 'not_found' }, 404);
    });
    await page.goto(`${base}/app/p/p1`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-section="narration"]', { timeout: 60000 });
    await page.waitForTimeout(1200);
    const m = await page.evaluate(() => {
      const vw = innerWidth, vh = innerHeight;
      const small = vw < 761 ? [...document.querySelectorAll('button,a,summary,input:not([type=radio]):not([type=checkbox]),label')].filter((e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && r.height < 43.5 && cs.visibility !== 'hidden' && !e.closest('audio') && !e.closest('[class*="aside"]') && !e.closest('[class*="stepper"]') && !e.closest('header,nav'); }).map((e) => (e.textContent || e.getAttribute('aria-label') || e.tagName).trim().slice(0, 18) + ':' + Math.round(e.getBoundingClientRect().height)).slice(0, 8) : [];
      return { overflowX: document.documentElement.scrollWidth > vw + 1, tapUnder44: small, sections: [...document.querySelectorAll('[data-section]')].map((s) => Math.round(s.getBoundingClientRect().height)), pageHeight: document.documentElement.scrollHeight };
    });
    await page.screenshot({ path: `${dir}/audio-${name}-${w}x${h}.png` });
    if (h > 800 || name === 'ready') await page.screenshot({ path: `${dir}/audio-${name}-${w}x${h}-full.png`, fullPage: true });
    out.push(`${name} ${w}x${h}: ${JSON.stringify(m)}`);
    await ctx.close();
  }
}
await browser.close();
console.log(out.join('\n'));
