/*
 * Screenshots of /app/brand, the storyboard with a footage shot and a picture-in-picture, and the cast step with the
 * customer's own picture (Task 23). Nothing here calls a provider: the dev server runs with STORY_MOCK=1 and Supabase env
 * blank, and every /api/story call is answered by the stubs below (so the screens show stub data, not data from the real routes).
 *
 *   STORY_MOCK=1 NEXT_PUBLIC_SUPABASE_URL= NEXT_PUBLIC_SUPABASE_ANON_KEY= npx next dev -p 3225 &
 *   PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core CHROME_PATH=/path/to/chrome \
 *     node scripts/brand-screenshots.mjs
 *
 * BASE_URL (default http://localhost:3225), OUT_DIR (default .superpowers/sdd/2026-11-14-story-video-maker/shots-task23).
 */
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const base = process.env.BASE_URL || 'http://localhost:3225';
const dir = process.env.OUT_DIR || '.superpowers/sdd/2026-11-14-story-video-maker/shots-task23';
mkdirSync(dir, { recursive: true });
const scen = JSON.parse(await (await fetch(base + '/mock/scenarios.json')).text());

const asset = (id, kind, name, over = {}) => ({ id, kind, name, url: '/mock/still-1.jpg', seconds: null, bytes: 120000, width: 640, height: 480, inBrandKit: true, created_at: '2026-11-14T10:00:00.000Z', ...over });
const ASSETS = [
  asset('a1', 'logo', "Jack's logo", { url: '/mock/still-4.jpg' }),
  asset('a2', 'product', 'Booking page', { url: '/mock/still-2.jpg' }),
  asset('a3', 'product', 'Shop front', { url: '/mock/still-3.jpg' }),
  asset('a4', 'mascot', 'Marcus', { url: '/mock/cast-marcus-0.jpg' }),
  asset('a5', 'recording', 'App walkthrough', { url: '/api/mock/fixtures/clip.mp4', seconds: 24 }),
  asset('a6', 'clip', 'Saturday queue', { url: '/api/mock/fixtures/clip.mp4', seconds: 12, inBrandKit: false }),
];
const BRAND = {
  offer: 'A barbershop with a booking page: pick a time in two taps.', audience: 'Local guys who hate waiting', tone: 'Warm, plain, a little funny.',
  avoid: ['cheap', 'hustle', 'grind'], colors: ['#16130f', '#7c5cff', '#f4efe6'], logo: ASSETS[0],
};
const EMPTY = { offer: null, audience: null, tone: null, avoid: [], colors: [], logo: null };

const sb = scen.scen.storyboard;
const shots = sb.shots.map((s) => ({ ...s, footage_asset_id: null, footage: null, inset_asset_id: null, inset: null, footage_url: null, inset_url: null }));
shots[1] = { ...shots[1], source: 'footage', footage_asset_id: 'a6', footage: { trimStart: 1.5, fit: 'contain' }, footage_url: '/api/mock/fixtures/clip.mp4', status: 'draft', still_url: null, still_credits: null };
shots[2] = { ...shots[2], inset_asset_id: 'a2', inset: { x: 0.72, y: 0.3, w: 0.38 }, inset_url: '/mock/still-2.jpg', inset_is_image: true };
const castRows = (scen.scen.cast.cast || []).map((c, i) => (i === 1 ? { ...c, chosen_index: null, asset_id: 'a4', image_url: '/mock/cast-marcus-0.jpg' } : c));

const views = {
  'brand-full': { path: '/app/brand', wait: '[data-section="clip"]', brand: BRAND, assets: ASSETS },
  'brand-empty': { path: '/app/brand', wait: '[data-section="clip"]', brand: EMPTY, assets: [] },
  'shots-footage': { path: '/app/p/p1', wait: '[data-shot]', scenario: 'storyboard', shots, openMore: true },
  'cast-own-picture': { path: '/app/p/p1', wait: '[data-cast]', scenario: 'cast', cast: castRows },
  'picker-open': { path: '/app/p/p1', wait: '[data-shot]', scenario: 'storyboard', shots, picker: 'Use my footage' },
};

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
const out = [];
const measure = (page) => page.evaluate(() => {
  const vw = innerWidth;
  const small = vw < 761 ? [...document.querySelectorAll('button,a,select,summary,input[type=text],input[type=number],input[type=range]')].filter((e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && r.height < 43.5 && cs.visibility !== 'hidden' && !e.closest('header,nav,aside') && !e.closest('[class*="stepper"]'); }).map((e) => (e.textContent || e.getAttribute('aria-label') || e.tagName).trim().slice(0, 18) + ':' + Math.round(e.getBoundingClientRect().height)).slice(0, 8) : [];
  return { overflowX: document.documentElement.scrollWidth > vw + 1, tapUnder44: small, pageHeight: document.documentElement.scrollHeight };
});
const openMore = async (page) => {
  for (const b of await page.$$('button[aria-expanded="false"]')) {
    if ((await b.textContent()).includes('Change this shot') && (await b.isVisible())) await b.click().catch(() => {});
  }
  await page.waitForTimeout(300);
};
for (const [w, h] of [[1280, 720], [390, 844]]) {
  for (const [name, v] of Object.entries(views)) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const page = await ctx.newPage();
    await page.route('**/api/story/**', (r) => {
      const u = new URL(r.request().url()).pathname;
      const j = (b, s = 200) => r.fulfill({ status: s, contentType: 'application/json', body: JSON.stringify(b) });
      if (u.endsWith('/brand')) return j({ brand: v.brand });
      if (u.endsWith('/assets')) {
        const kinds = (new URL(r.request().url()).searchParams.get('kinds') || '').split(',').filter(Boolean);
        return j({ assets: (v.assets || ASSETS).filter((a) => !kinds.length || kinds.includes(a.kind)) });
      }
      if (u.endsWith('/status')) return j({ ...sb, ...(scen.scen[v.scenario] || {}), shots: v.shots || sb.shots, cast: v.cast || scen.scen.cast.cast || [], jobs: [], balance: null, render: null });
      if (u.endsWith('/billing')) return j({ v2: true, balance: { available: 900 }, history: [] });
      if (u.endsWith('/pricing')) return j({ pricing: { perSecond: { economy: 8, standard: 11, pro_narrated: 14, pro_talking: 21 }, projectFee: 90, stillReroll: 2, castRegen: 5, included: { castRegenPerCharacter: 2 }, freeRerollShare: 0.2 } });
      if (u.endsWith('/quote')) return j({ total: 330, lines: [{ label: 'Project fee', credits: 90 }, { label: '6 Pro narrated shots', credits: 240 }] });
      return j({ error: 'not_found' }, 404);
    });
    await page.goto(`${base}${v.path}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(v.wait, { timeout: 90000 });
    await page.waitForTimeout(1200);
    if (v.openMore || v.picker) await openMore(page);
    if (v.picker) {
      await page.getByRole('button', { name: v.picker }).first().click();
      await page.waitForSelector('[role="dialog"] ul li', { timeout: 15000 });
      await page.waitForTimeout(500);
    }
    const m = await measure(page);
    await page.screenshot({ path: `${dir}/${name}-${w}x${h}.png` });
    if (h > 800 && !v.picker) await page.screenshot({ path: `${dir}/${name}-${w}x${h}-full.png`, fullPage: true });
    out.push(`${name} ${w}x${h}: ${JSON.stringify(m)}`);
    await ctx.close();
  }
}
await browser.close();
console.log(out.join('\n'));
