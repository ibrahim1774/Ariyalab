import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const nextConfig = createRequire(import.meta.url)('../next.config.js');

describe('old Ariya Lab pages redirect to www.ariyalab.online', () => {
  it('sends each old tool page to the same path there, temporarily', async () => {
    const redirects = await nextConfig.redirects();
    const bySource = Object.fromEntries(redirects.map((r) => [r.source, r]));
    for (const path of ['/ugc', '/ugc-2', '/ugc-3', '/local-business', '/local-business/pricing-plan', '/real-estate', '/real-estate/pricing-plan', '/interior-design', '/image-to-video', '/history', '/topup', '/video/editing']) {
      expect(bySource[path], path).toMatchObject({ destination: `https://www.ariyalab.online${path}`, permanent: false });
    }
    expect(bySource['/legacy-home']).toMatchObject({ destination: 'https://www.ariyalab.online/', permanent: false });
    expect(redirects.every((r) => r.permanent === false)).toBe(true);
  });

  it('leaves the pages the Sonallo app still needs alone', async () => {
    const sources = (await nextConfig.redirects()).map((r) => r.source);
    for (const kept of ['/', '/dashboard', '/ugc-2/claim', '/ugc-2/welcome', '/sign-in', '/sign-up', '/pricing', '/support', '/privacy', '/terms', '/reset-password', '/app', '/tracking']) {
      expect(sources, kept).not.toContain(kept);
    }
    // No wildcard source that could swallow a kept sub-page or an /api route.
    expect(sources.filter((s) => s.includes(':') || s.includes('*') || s.startsWith('/api'))).toEqual([]);
  });
});
