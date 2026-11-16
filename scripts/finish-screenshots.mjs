/*
 * Screenshots of the Finish step and the home-page project cards in mock mode (Task 21). Nothing here calls a
 * provider: the dev server runs with STORY_MOCK=1 and Supabase env blank, and every /api/story call is stubbed below.
 *
 *   STORY_MOCK=1 NEXT_PUBLIC_SUPABASE_URL= NEXT_PUBLIC_SUPABASE_ANON_KEY= npx next dev -p 3221 &
 *   PLAYWRIGHT_CORE=/path/to/playwright-core CHROME_PATH=/path/to/chrome BASE_URL=http://localhost:3221 \
 *     node scripts/finish-screenshots.mjs
 *
 * HOME_ONLY=1 shoots only the home page. BASE_URL (default http://localhost:3221), OUT_DIR (default .superpowers/sdd/2026-11-14-story-video-maker/shots-task21).
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const base = process.env.BASE_URL || 'http://localhost:3221';
const dir = process.env.OUT_DIR || '.superpowers/sdd/2026-11-14-story-video-maker/shots-task21';
const exe = process.env.CHROME_PATH;
const scen = JSON.parse(await (await fetch(base + '/mock/scenarios.json')).text());
const FILE = '/api/mock/fixtures/clip.mp4';
const proj = (extra = {}) => ({ ...scen.scen.review.project, step: 'done', aspect: '16:9', title: 'The line outside the barbershop', files_expire_at: '2026-12-14T00:00:00Z', ...extra });
const done = (v, extra = {}) => ({ id: `r${v}`, version: v, status: 'done', url: FILE, warnings: [], created_at: '2026-11-14T10:00:00Z', finished_at: '2026-11-14T10:01:10Z', error: null, duration_seconds: 15.6, ...extra });
const WARN = [
  { code: 'loudness', message: 'The music is a little loud under the voice. Lower the music in the Voice and sound step if that bothers you.' },
  { code: 'narration_gap', message: 'There is a pause of 4 seconds after scene 3.' },
];
const justNow = () => new Date(Date.now() - 42000).toISOString();
const scenarios = {
  none: { project: proj(), render: null, renders: [] },
  queued: { project: proj(), render: { id: 'r1', version: 1, status: 'queued', url: null, warnings: [], created_at: justNow(), finished_at: null, error: null }, renders: [] },
  running: { project: proj(), render: { id: 'r1', version: 1, status: 'running', url: null, warnings: [], created_at: justNow(), finished_at: null, error: null }, renders: [] },
  done: { project: proj(), render: done(1), renders: [done(1)] },
  'done-portrait': { project: proj({ aspect: '9:16' }), render: done(2, { warnings: WARN }), renders: [done(2, { warnings: WARN }), done(1)] },
  'done-warnings': { project: proj(), render: done(2, { warnings: WARN }), renders: [done(2, { warnings: WARN }), done(1)] },
  failed: { project: proj(), render: { id: 'r2', version: 2, status: 'failed', url: null, warnings: [], created_at: justNow(), finished_at: justNow(), error: 'The video could not be made this time. Try again.' }, renders: [{ id: 'r2', version: 2, status: 'failed', url: null, warnings: [], error: 'The video could not be made this time. Try again.' }, done(1)] },
  expired: { project: proj({ status: 'expired', files_expire_at: '2026-11-10T00:00:00Z' }), render: done(1), renders: [done(1)] },
};
const cards = [
  { id: 'a', title: 'The line outside the barbershop', style: '3d_family', thumbnail_url: '/mock/still-1.jpg', step: 'done', status: 'finished', updated_at: '2026-11-13', latest_render_url: FILE, latest_render_version: 1, files_expire_at: '2026-12-14T00:00:00Z' },
  { id: 'b', title: 'Fox and the moon, a bedtime story for tiny people', style: 'clay', thumbnail_url: '/mock/still-4.jpg', step: 'generate', updated_at: '2026-11-12', files_expire_at: '2026-12-12T00:00:00Z' },
  { id: 'c', title: 'Old promo', style: 'watercolor', step: 'done', status: 'expired', updated_at: '2026-09-01', files_expire_at: '2026-10-01T00:00:00Z' },
  { id: 'd', title: 'Untitled story', step: 'script', updated_at: '2026-11-14' },
];
const browser = await chromium.launch({ executablePath: exe, headless: true });
const out = [];
for (const [w, h] of [[1280, 720], [390, 844]]) {
  for (const [name, view] of Object.entries(process.env.HOME_ONLY ? {} : scenarios)) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const page = await ctx.newPage();
    await page.route('**/api/story/**', (r) => {
      const u = new URL(r.request().url()).pathname;
      const j = (b, s = 200) => r.fulfill({ status: s, contentType: 'application/json', body: JSON.stringify(b) });
      if (u.endsWith('/status')) return j({ project: view.project, shots: scen.scen.review.shots, cast: scen.scen.review.cast || [], jobs: [], balance: null, render: view.render, renders: view.renders });
      if (u.endsWith('/billing')) return j({ v2: true, balance: { available: 900 }, history: [] });
      if (u.endsWith('/pricing')) return j({ pricing: { perSecond: { economy: 8, standard: 11, pro_narrated: 14, pro_talking: 21 }, projectFee: 90, stillReroll: 2, castRegen: 5, included: { castRegenPerCharacter: 2 }, freeRerollShare: 0.2 } });
      if (u.endsWith('/quote')) return j({ total: 510, lines: [{ label: 'Project fee', credits: 90 }] });
      if (u.endsWith('/script')) return j({ script: scen.script });
      return j({ error: 'not_found' }, 404);
    });
    await page.goto(`${base}/app/p/p1?step=finish`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="finish"]', { timeout: 60000 }).catch(async () => {
      // The finish step is the project's furthest step (step: done), so it opens by itself; fall back to the stepper.
      await page.getByRole('button', { name: /finish/i }).first().click({ timeout: 3000 }).catch(() => {});
      await page.waitForSelector('[data-testid="finish"]', { timeout: 20000 });
    });
    await page.waitForTimeout(1500);
    const m = await page.evaluate(() => {
      const vw = innerWidth;
      const small = vw < 761 ? [...document.querySelectorAll('button,a,summary')].filter((e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && r.height < 43.5 && cs.visibility !== 'hidden' && !e.closest('video') && !e.closest('[class*="aside"]') && !e.closest('[class*="stepper"]') && !e.closest('header,nav'); }).map((e) => (e.textContent || e.getAttribute('aria-label') || e.tagName).trim().slice(0, 18) + ':' + Math.round(e.getBoundingClientRect().height)).slice(0, 8) : [];
      const v = document.querySelector('video');
      return { overflowX: document.documentElement.scrollWidth > vw + 1, tapUnder44: small, video: v ? { w: Math.round(v.getBoundingClientRect().width), h: Math.round(v.getBoundingClientRect().height), ready: v.readyState, err: v.error?.code || null } : null, pageHeight: document.documentElement.scrollHeight };
    });
    await page.screenshot({ path: `${dir}/finish-${name}-${w}x${h}.png` });
    out.push(`finish ${name} ${w}x${h}: ${JSON.stringify(m)}`);
    await ctx.close();
  }
  // Home page: cards with download / duplicate / delete, and the delete confirmation.
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const page = await ctx.newPage();
  await page.route('**/api/story/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ projects: cards }) }));
  await page.goto(`${base}/app`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-project]', { timeout: 60000 });
  await page.waitForTimeout(1200);
  const hm = await page.evaluate(() => ({ overflowX: document.documentElement.scrollWidth > innerWidth + 1, cards: document.querySelectorAll('[data-project]').length, tapUnder44: innerWidth < 761 ? [...document.querySelectorAll('[data-project] button,[data-project] a')].filter((e) => e.getBoundingClientRect().height < 43.5).map((e) => e.textContent.trim().slice(0, 14)).slice(0, 8) : [] }));
  await page.screenshot({ path: `${dir}/home-${w}x${h}.png` });
  await page.screenshot({ path: `${dir}/home-${w}x${h}-full.png`, fullPage: true });
  await page.getByRole('button', { name: /^delete$/i }).first().click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${dir}/home-delete-${w}x${h}.png` });
  out.push(`home ${w}x${h}: ${JSON.stringify(hm)}`);
  await ctx.close();
}
await browser.close();
console.log(out.join('\n'));
