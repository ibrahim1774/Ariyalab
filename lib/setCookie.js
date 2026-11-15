// Adds a cookie to the response, keeping any Set-Cookie already on it (a
// chunked Supabase session cookie is several Set-Cookie headers, and a route
// may add its own after the session refresh; overwriting keeps only the
// last). Order is kept. Works on Node responses (getHeader) and on minimal
// test doubles without getHeader.
const pendingCookies = new WeakMap();

export function appendSetCookie(res, cookie) {
  let existing = typeof res.getHeader === 'function' ? res.getHeader('Set-Cookie') : pendingCookies.get(res);
  if (existing === undefined || existing === null) existing = [];
  const list = [...(Array.isArray(existing) ? existing : [String(existing)]), cookie];
  if (typeof res.getHeader !== 'function') pendingCookies.set(res, list);
  res.setHeader('Set-Cookie', list);
}
