/*
 * Screenshots of "Start from a video" (StepReference) and the Breakdown step (StepBreakdown) in mock mode (Task 22).
 * Nothing here calls a provider: the dev server runs with STORY_MOCK=1 and Supabase env blank, and every /api/story
 * call is answered by the stubs below.
 *
 *   STORY_MOCK=1 NEXT_PUBLIC_SUPABASE_URL= NEXT_PUBLIC_SUPABASE_ANON_KEY= npx next dev -p 3222 &
 *   PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core CHROME_PATH=/path/to/chrome-headless-shell \
 *     node scripts/reference-screenshots.mjs
 *
 * BASE_URL (default http://localhost:3222), OUT_DIR (default .superpowers/sdd/2026-11-14-story-video-maker/shots-task22).
 */
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const base = process.env.BASE_URL || 'http://localhost:3222';
const dir = process.env.OUT_DIR || '.superpowers/sdd/2026-11-14-story-video-maker/shots-task22';
mkdirSync(dir, { recursive: true });

const project = {
  id: 'p1', title: 'Barber shop reel', purpose: 'service', offer: 'A barber shop that takes bookings online.', style: '3d_family', seconds: 30,
  aspect: '9:16', quality: 'standard', mode: 'narrated', step: 'breakdown', status: 'draft', reference_id: 'r1', fee_charged: false, files_expire_at: null,
};
const BEATS = [
  [0, 2.1, 'A barber looks straight into the phone camera, scissors in hand.', 'Nobody books a haircut on a Monday.', 'It opens on a face and a doubt the viewer shares.'],
  [2.1, 5.4, 'The empty shop at opening time, chairs still turned up.', '', 'It shows the problem without a word.'],
  [5.4, 9.8, 'He scrolls through an empty booking book, then sighs.', 'I used to wait by the door all morning.', 'A small, honest moment makes him likeable.'],
  [9.8, 14.2, 'His friend leans over the counter and shows him something on her phone.', 'Just let them book from their phone.', 'The turning point comes from someone he trusts.'],
  [14.2, 21.6, 'Quick cuts: phone notifications, the chair spinning, a full waiting bench.', 'Now Monday is my busiest day.', 'Fast cuts make the change feel big and real.'],
  [21.6, 27.3, 'He laughs with a customer as the door chimes again.', '', 'It ends on warmth, not on a sales line.'],
].map(([start, end, visual, said, why], i) => ({ ord: i + 1, start, end, visual, said, why, thumb: i === 1 ? null : `/mock/still-${i + 1}.jpg` }));
const ready = {
  id: 'r1', status: 'ready', error: null, source_type: 'link', source_url: 'https://www.tiktok.com/@shop/video/1', platform: 'tiktok', duration: 27.3,
  beats: BEATS, hook: 'Opens on a face and a doubt the viewer already has, in under two seconds.', structure: 'Problem, a friend’s nudge, then proof in quick cuts and a warm payoff.',
  mood: 'Warm acoustic guitar with a light beat that builds', mode: 'narrated', shots: 9, rights_confirmed_at: '2026-11-15T10:00:00.000Z',
};
const pending = { ...ready, status: 'pending', beats: [], hook: null, structure: null, mood: null, mode: null, shots: 0 };
const failed = { ...pending, status: 'failed', error: 'This video is longer than 3 minutes. Trim it to 3 minutes or less and try again.' };

const PRICING = { pricing: { perSecond: { economy: 8, standard: 11, pro_narrated: 14, pro_talking: 21 }, projectFee: 90, stillReroll: 2, castRegen: 5, narrationRegen: 5, musicRegen: 5, included: { castRegenPerCharacter: 2, narration: 3, music: 3 }, freeRerollShare: 0.2 } };

async function stub(page, reference, proj = project) {
  await page.route('**/api/story/**', (r) => {
    const u = new URL(r.request().url()).pathname;
    const j = (b, s = 200) => r.fulfill({ status: s, contentType: 'application/json', body: JSON.stringify(b) });
    if (u.endsWith('/analyze')) return j({ reference });
    if (u.endsWith('/status')) return j({ project: proj, shots: [], cast: [], jobs: [], balance: null, render: null });
    if (u.endsWith('/billing')) return j({ v2: true, balance: { available: 900 }, history: [] });
    if (u.endsWith('/pricing')) return j(PRICING);
    if (u.endsWith('/quote')) return j({ total: 420, lines: [{ label: 'Project fee', credits: 90 }, { label: '10 Standard shots', credits: 330 }] });
    if (u.includes('/chat')) return j({ messages: [], usage: { used: 0, limit: 150 } });
    return j({ error: 'not_found' }, 404);
  });
}

async function measure(page) {
  return page.evaluate(() => {
    const vw = innerWidth;
    const small = vw < 761 ? [...document.querySelectorAll('main button, main a, main input:not([type=radio]):not([type=checkbox]):not([type=file]), main label')]
      .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.height < 43.5 && getComputedStyle(e).visibility !== 'hidden' && !e.closest('[class*="stepper"]') && !e.closest('aside'); })
      .map((e) => `${(e.textContent || e.getAttribute('aria-label') || e.tagName).trim().slice(0, 20)}:${Math.round(e.getBoundingClientRect().height)}`).slice(0, 8) : [];
    const beats = [...document.querySelectorAll('[data-beat]')].map((b) => b.getBoundingClientRect()).filter((r) => r.top < innerHeight).length;
    return { overflowX: document.documentElement.scrollWidth > vw + 1, tapUnder44: small, beatsVisible: beats, pageHeight: document.documentElement.scrollHeight };
  });
}

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
const out = [];
for (const [w, h] of [[1280, 720], [390, 844]]) {
  const shoot = async (name, fn) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const page = await ctx.newPage();
    await fn(page);
    await page.waitForTimeout(800);
    const m = await measure(page);
    await page.screenshot({ path: `${dir}/${name}-${w}x${h}.png` });
    await page.screenshot({ path: `${dir}/${name}-${w}x${h}-full.png`, fullPage: true });
    out.push(`${name} ${w}x${h}: ${JSON.stringify(m)}`);
    await ctx.close();
  };

  // StepReference on the first screen: the upload door, then the link door with a refused link, then a good one ticked.
  await shoot('reference-upload', async (page) => {
    await stub(page, null);
    await page.goto(`${base}/app/new`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-step="reference"]', { timeout: 90000 });
    await page.locator('[data-step="reference"]').scrollIntoViewIfNeeded();
  });
  await shoot('reference-link-refused', async (page) => {
    await stub(page, null);
    await page.goto(`${base}/app/new`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-step="reference"]', { timeout: 90000 });
    await page.getByRole('radio', { name: /Paste a link/ }).check();
    await page.getByLabel('Link to the video').fill('https://www.youtube.com/watch?v=abc');
    await page.locator('[data-step="reference"]').scrollIntoViewIfNeeded();
  });
  await shoot('reference-link-ready', async (page) => {
    await stub(page, null);
    await page.goto(`${base}/app/new`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-step="reference"]', { timeout: 90000 });
    await page.getByRole('radio', { name: /Paste a link/ }).check();
    await page.getByLabel('Link to the video').fill('https://www.tiktok.com/@barbershop/video/7311234567');
    await page.getByRole('checkbox', { name: /right to use this video/i }).check();
    await page.locator('[data-step="reference"]').scrollIntoViewIfNeeded();
  });

  // StepBreakdown: ready, waiting, failed.
  for (const [name, view] of [['breakdown-ready', ready], ['breakdown-waiting', pending], ['breakdown-failed', failed]]) {
    await shoot(name, async (page) => {
      await stub(page, view);
      await page.goto(`${base}/app/p/p1`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('text=Breakdown of', { timeout: 90000 });
    });
  }
}
await browser.close();
console.log(out.join('\n'));
