import { describe, expect, it } from 'vitest';
import { isMetaInAppBrowser } from '../lib/inAppBrowser.js';

describe('isMetaInAppBrowser', () => {
  it('spots the Facebook, Messenger and Instagram in-app browsers', () => {
    const fb = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 [FBAN/FBIOS;FBAV/450.0.0.38.108;FBBV/565;FBDV/iPhone15,2]';
    const fbAndroid = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/440.0.0.33.113;]';
    const ig = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Instagram 300.0.0.29.110 (iPhone15,2)';
    for (const ua of [fb, fbAndroid, ig]) expect(isMetaInAppBrowser(ua)).toBe(true);
  });

  it('leaves ordinary browsers and missing user agents alone', () => {
    expect(isMetaInAppBrowser('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15')).toBe(false);
    expect(isMetaInAppBrowser('Mozilla/5.0 (Linux; Android 13) Chrome/120.0 Mobile Safari/537.36')).toBe(false);
    expect(isMetaInAppBrowser('')).toBe(false);
    expect(isMetaInAppBrowser(undefined)).toBe(false);
  });
});
