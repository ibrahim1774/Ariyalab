async (page) => {
  // Run with the dev server up (STORY_MOCK=1, Supabase env blank). All mock data lives in the repo: public/mock/scenarios.json and public/mock/*.jpg.
  const dir = '/Users/ibrahim/AI-Video-Generator/.superpowers/sdd/2026-11-14-story-video-maker/shots-task17';
  const base = 'http://localhost:3217';
  const boot = await page.context().newPage();
  await boot.goto(base + '/mock/scenarios.json');
  const { scen, script, projects } = JSON.parse(await boot.evaluate(() => document.body.innerText));
  await boot.close();
  const out = [];
  const setup = async (w, h, scenario) => {
    const p = await page.context().newPage();
    await p.setViewportSize({ width: w, height: h });
    await p.route('**/api/story/**', (r) => {
      const u = new URL(r.request().url()).pathname;
      const j = (b, s = 200) => r.fulfill({ status: s, contentType: 'application/json', body: JSON.stringify(b) });
      if (u.endsWith('/projects')) return j({ projects });
      if (u.endsWith('/status')) return j({ shots: [], cast: [], jobs: [], balance: null, render: null, ...scen[scenario] });
      if (u.endsWith('/script')) return j({ script });
      if (u.endsWith('/billing')) return j({ v2: true, balance: { available: 900 }, history: [] });
      if (u.endsWith('/pricing')) return j({ pricing: { perSecond: { economy: 8, standard: 11, pro_narrated: 14, pro_talking: 21 }, projectFee: 90, stillReroll: 2, castRegen: 5, included: { castRegenPerCharacter: 2 }, freeRerollShare: 0.2 } });
      if (u.endsWith('/quote')) {
        // Same shape as quoteProject in lib/pricing.js: 'Project fee' plus one line per quality. 3 s shots at 14 credits a second (Pro narrated), fee 90.
        const n = (scen[scenario].shots || []).length || 10;
        return j({ total: 90 + n * 42, lines: [{ label: 'Project fee', credits: 90 }, { label: `${n} Pro narrated ${n === 1 ? 'shot' : 'shots'}`, credits: n * 42 }] });
      }
      return j({ error: 'not_found' }, 404);
    });
    return p;
  };
  const metrics = (p) => p.evaluate(() => {
    const vh = innerHeight, vw = innerWidth;
    const cards = [...document.querySelectorAll('[data-shot]')];
    const whole = cards.filter((c) => { const r = c.getBoundingClientRect(); return r.top >= 0 && r.bottom <= vh && r.width > 0; }).length;
    const part = cards.filter((c) => { const r = c.getBoundingClientRect(); return r.top < vh && r.bottom > 0; }).length;
    const castWhole = [...document.querySelectorAll('[data-cast]')].filter((c) => { const r = c.getBoundingClientRect(); return r.top >= 0 && r.bottom <= vh; }).length;
    const note = document.querySelector('[data-testid="style-note"]');
    const noteVisible = note ? (getComputedStyle(note).display !== 'none' && note.getBoundingClientRect().height > 0) : null;
    const bar = document.querySelector('[data-testid="quote-bar"]');
    const barH = bar ? Math.round(bar.getBoundingClientRect().height) : null;
    const small = vw < 761 ? [...document.querySelectorAll('button,a,select,summary,input:not([type=radio])')].filter((e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && r.top < vh && r.bottom > 0 && r.height < 43.5 && cs.visibility !== 'hidden' && !e.closest('video') && !e.closest('[class*="aside"]'); }).map((e) => (e.textContent || e.getAttribute('aria-label') || e.tagName).trim().slice(0, 16) + ':' + Math.round(e.getBoundingClientRect().height)).slice(0, 5) : [];
    const asideEl = document.querySelector('aside[aria-label="Chat helper"]');
    const asideH = asideEl && vw > 900 ? Math.round(asideEl.getBoundingClientRect().height) : null;
    const videos = [...document.querySelectorAll('[data-shot] video')].length;
    const plays = [...document.querySelectorAll('[data-shot] button[aria-label^="Play clip"]')].length;
    const scrim = (() => { const s = document.querySelector('button[aria-label="Close chat helper"]'); return s ? getComputedStyle(s).display : 'none-in-dom'; })();
    return { asideHeight: asideH, wholeCards: whole, partCards: part, wholeCast: castWhole, noteVisible, quoteBarHeight: barH, videosInShots: videos, playButtons: plays, overflowX: document.documentElement.scrollWidth > vw + 1, tapUnder44: small };
  });
  for (const [w, h] of [[1280, 720], [1920, 1080], [390, 844], [360, 740]]) {
    for (const k of Object.keys(scen)) {
      const p = await setup(w, h, k);
      await p.goto(base + '/app/p/p1', { waitUntil: 'domcontentloaded' });
      await p.waitForSelector('[data-media-card], [data-scene], [data-testid="quote-bar"]', { timeout: 30000 }).catch(() => {});
      await p.waitForTimeout(2200);
      if (k === 'generate') { await p.getByTestId('generate-all').click({ timeout: 3000 }).catch(() => {}); await p.waitForTimeout(900); }
      const m = await metrics(p);
      await p.screenshot({ path: `${dir}/final-${k}-${w}x${h}.png` });
      if (k === 'storyboard') {
        await p.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight)); await p.waitForTimeout(700);
        await p.screenshot({ path: `${dir}/final-storyboard-bottom-${w}x${h}.png` });
      }
      out.push(`${k} ${w}x${h}: ${JSON.stringify(m)}`);
      await p.close();
    }
  }
  for (const [w, h, url, name] of [[390, 844, '/app', 'dashboard'], [390, 844, '/', 'home'], [1440, 900, '/', 'home']]) {
    const p = await setup(w, h, 'storyboard');
    await p.goto(base + url, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(3500);
    const m = await p.evaluate(() => ({ overflowX: document.documentElement.scrollWidth > innerWidth + 1, cards: [...document.querySelectorAll('a[aria-label^="Open"]')].filter((c) => { const r = c.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }).length }));
    await p.screenshot({ path: `${dir}/final-${name}-${w}x${h}.png` });
    out.push(`${name} ${w}x${h}: ${JSON.stringify(m)}`);
    await p.close();
  }
  return out.join('\n');
}
