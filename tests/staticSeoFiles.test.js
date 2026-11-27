import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('robots.txt, sitemap.xml and favicon.ico', () => {
  it('robots.txt allows the site, hides the app, API and admin, and names the sitemap', () => {
    const t = readFileSync('public/robots.txt', 'utf8');
    expect(t).toMatch(/^User-agent: \*$/m);
    expect(t).toMatch(/^Allow: \/$/m);
    for (const p of ['/app', '/api', '/admin']) expect(t).toContain(`Disallow: ${p}\n`);
    expect(t).toContain('Sitemap: https://sonallo.com/sitemap.xml');
  });

  it('sitemap.xml lists the public pages', () => {
    const t = readFileSync('public/sitemap.xml', 'utf8');
    const locs = [...t.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    expect(locs).toEqual(['https://sonallo.com/', 'https://sonallo.com/privacy', 'https://sonallo.com/terms', 'https://sonallo.com/support']);
  });

  it('favicon.ico is a real ICO with 16 and 32 pixel images', () => {
    const b = readFileSync('public/favicon.ico');
    expect([b.readUInt16LE(0), b.readUInt16LE(2)]).toEqual([0, 1]);
    const n = b.readUInt16LE(4);
    const sizes = Array.from({ length: n }, (_, i) => b[6 + i * 16] || 256);
    expect(sizes).toEqual(expect.arrayContaining([16, 32]));
  });
});
