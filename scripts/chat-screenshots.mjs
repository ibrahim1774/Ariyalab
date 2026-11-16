/*
 * Screenshots of the chat helper in mock mode (Task 18). Nothing here calls a provider: the dev server runs with
 * STORY_MOCK=1 and Supabase env blank, and every /api/story call is answered by the stubs below.
 *
 *   STORY_MOCK=1 NEXT_PUBLIC_SUPABASE_URL= NEXT_PUBLIC_SUPABASE_ANON_KEY= npx next dev -p 3218 &
 *   PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core CHROME_PATH=/path/to/chrome node scripts/chat-screenshots.mjs
 *
 * BASE_URL (default http://localhost:3218), OUT_DIR (default .superpowers/sdd/2026-11-14-story-video-maker/shots-task18).
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const base = process.env.BASE_URL || 'http://localhost:3218';
const dir = process.env.OUT_DIR || '.superpowers/sdd/2026-11-14-story-video-maker/shots-task18';
const scen = JSON.parse(await (await fetch(base + '/mock/scenarios.json')).text());
const view = scen.scen.cast;
const msg = (id, role, text, confirms = []) => ({ id, role, text, confirms, created_at: '2026-11-14T12:00:00.000Z' });
const HISTORY = [
  msg('1', 'user', 'Make the opening funnier'),
  msg('2', 'assistant', 'I rewrote the first scene so Marcus trips over the broom as he opens up. The rest of the story is the same.'),
  msg('3', 'user', 'Give Dre a red cap'),
  msg('4', 'assistant', 'Dre has used his included new pictures, so the next set costs 5 credits. Press the button to start it.', [{
    tool: 'regenerate_character', needsConfirm: true, quote: { label: 'New pictures of Dre', credits: 5 },
    confirm: { action: 'cast-regen', method: 'POST', body: { castId: 'c1', note: 'a red cap', expected_credits: 5 } },
  }]),
];
const states = {
  history: { messages: HISTORY, usage: { used: 2, limit: 150 } },
  empty: { messages: [], usage: { used: 0, limit: 150 } },
  waiting: { messages: HISTORY.slice(0, 2), usage: { used: 1, limit: 150 }, send: 'Make it 45 seconds' },
};
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
const out = [];
for (const [w, h] of [[1280, 720], [390, 844]]) {
  for (const [name, state] of Object.entries(states)) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const page = await ctx.newPage();
    await page.route('**/api/story/**', (r) => {
      const u = new URL(r.request().url()).pathname;
      const j = (b, s = 200) => r.fulfill({ status: s, contentType: 'application/json', body: JSON.stringify(b) });
      if (u.endsWith('/chat') && r.request().method() === 'GET') return j(state);
      if (u.endsWith('/chat')) return; // left pending: the waiting state
      if (u.endsWith('/status')) return j({ shots: [], cast: [], jobs: [], balance: null, render: null, ...view });
      if (u.endsWith('/script')) return j({ script: scen.script });
      if (u.endsWith('/billing')) return j({ v2: true, balance: { available: 900 }, history: [] });
      if (u.endsWith('/pricing')) return j({ pricing: { perSecond: { economy: 8, standard: 11, pro_narrated: 14, pro_talking: 21 }, projectFee: 90, stillReroll: 2, castRegen: 5, included: { castRegenPerCharacter: 2, chat: 150 }, freeRerollShare: 0.2 } });
      if (u.endsWith('/quote')) return j({ total: 510, lines: [{ label: 'Project fee', credits: 90 }, { label: '10 Pro narrated shots', credits: 420 }] });
      return j({ error: 'not_found' }, 404);
    });
    await page.goto(`${base}/app/p/p1`, { waitUntil: 'domcontentloaded', timeout: 240000 });
    await page.waitForSelector('[data-testid="chat-panel"]', { timeout: 90000, state: 'attached' });
    if (w < 900) { await page.getByRole('button', { name: 'Chat helper' }).click(); await page.waitForTimeout(500); }
    await page.waitForTimeout(1500);
    if (state.send) {
      await page.getByLabel('Message to the chat helper').fill(state.send);
      await page.getByRole('button', { name: 'Send' }).click();
      await page.waitForSelector('[data-testid="chat-waiting"]');
      await page.waitForTimeout(300);
    }
    const m = await page.evaluate(() => {
      const a = document.querySelector('aside[aria-label="Chat helper"]').getBoundingClientRect();
      return { overflowX: document.documentElement.scrollWidth > innerWidth + 1, aside: { top: Math.round(a.top), height: Math.round(a.height), width: Math.round(a.width) } };
    });
    await page.screenshot({ path: `${dir}/chat-${name}-${w}x${h}.png` });
    out.push(`${name} ${w}x${h}: ${JSON.stringify(m)}`);
    await ctx.close();
  }
}
await browser.close();
console.log(out.join('\n'));
