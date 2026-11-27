import { statSync, readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/head', () => ({ default: ({ children }) => children }));
for (const m of ['Hero', 'ProductDemo', 'VideoRail', 'HowItWorks', 'PricingSection', 'Faq', 'ClosingCta']) {
  vi.doMock(`../../components/marketing/${m}`, () => ({ default: () => null }));
}

const { default: OgTags } = await import('../../components/marketing/OgTags.js');
const { default: Home } = await import('../../pages/index.js');

const tag = (html, attr, name) => new RegExp(`<meta[^>]*${attr}="${name}"[^>]*content="([^"]*)"`).exec(html)?.[1];

describe('link preview tags', () => {
  it('the homepage carries og:title, description, url, type, image and the Twitter card', () => {
    const html = renderToStaticMarkup(<Home />);
    expect(tag(html, 'property', 'og:title')).toBe('Sonallo | Animated story videos');
    expect(tag(html, 'property', 'og:description')).toBe(tag(html, 'name', 'description'));
    expect(tag(html, 'property', 'og:url')).toBe('https://sonallo.com');
    expect(tag(html, 'property', 'og:type')).toBe('website');
    expect(tag(html, 'property', 'og:image')).toBe('https://sonallo.com/og-image.jpg');
    expect(tag(html, 'name', 'twitter:card')).toBe('summary_large_image');
  });

  it('the layout default has the same tags', () => {
    const html = renderToStaticMarkup(<OgTags />);
    expect(tag(html, 'property', 'og:image')).toBe('https://sonallo.com/og-image.jpg');
    expect(tag(html, 'property', 'og:title')).toBe('Sonallo | Animated story videos');
  });

  it('the image exists, is a 1200x630 JPEG and is under 300 KB', () => {
    const buf = readFileSync('public/og-image.jpg');
    expect(statSync('public/og-image.jpg').size).toBeLessThan(300 * 1024);
    // SOF0/SOF2 marker holds height then width.
    let i = 2;
    while (i < buf.length) {
      if (buf[i] !== 0xff) { i += 1; continue; }
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker === 0xc0 || marker === 0xc2) {
        expect([buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)]).toEqual([1200, 630]);
        return;
      }
      i += 2 + len;
    }
    throw new Error('no SOF marker');
  });
});
