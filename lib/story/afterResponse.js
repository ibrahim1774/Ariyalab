/*
 * Keeps work going after the HTTP response is sent. On Vercel the platform's waitUntil keeps the function alive for the promise
 * (the request context the platform puts on globalThis); anywhere else the promise simply runs on, and a failure is only logged.
 * No dependency: it reads the same global @vercel/functions' waitUntil reads.
 */
export function afterResponse(promise) {
  const guarded = Promise.resolve(promise).catch((err) => console.error('[story] background work failed', err?.message || err));
  try {
    const ctx = globalThis[Symbol.for('@vercel/request-context')]?.get?.();
    if (typeof ctx?.waitUntil === 'function') ctx.waitUntil(guarded);
  } catch {
    // no platform context: the promise runs on its own
  }
  return guarded;
}
