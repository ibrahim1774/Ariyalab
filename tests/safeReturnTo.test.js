import { describe, it, expect } from 'vitest';
import { safeReturnTo } from '../lib/safeReturnTo';

describe('safeReturnTo', () => {
  it.each([
    ['/\\evil.com'],
    ['/%5Cevil.com'],
    ['//evil.com'],
    ['https://evil.com'],
    ['/%2F%2Fevil.com'],
    ['/app\tx'],
    ['/app\nx'],
    ['/app%0Ax'],
    ['evil.com'],
    [''],
    [undefined],
    [['/app']],
    ['/%E0%A4%A'],
  ])('falls back for %j', (raw) => {
    expect(safeReturnTo(raw)).toBe('/app');
    expect(safeReturnTo(raw, '/')).toBe('/');
  });

  it('keeps ordinary site paths', () => {
    expect(safeReturnTo('/app/p/123?x=1')).toBe('/app/p/123?x=1');
    expect(safeReturnTo('/app/billing')).toBe('/app/billing');
  });
});
