/**
 * Same-origin guard for post-login return paths. Returns the path when it is a
 * plain site-relative path, else the fallback. Rejects backslashes (browsers
 * treat /\host as //host), control characters, protocol-relative and absolute
 * URLs, in both raw and once-decoded form.
 */
export function safeReturnTo(raw, fallback = '/app') {
  if (typeof raw !== 'string' || raw === '') return fallback;
  let decoded;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return fallback;
  }
  for (const value of [raw, decoded]) {
    if (!value.startsWith('/') || value.startsWith('//')) return fallback;
    if (/[\\\u0000-\u001f\u007f]/.test(value)) return fallback;
  }
  try {
    if (new URL(raw, 'https://x.invalid').origin !== 'https://x.invalid') return fallback;
  } catch {
    return fallback;
  }
  return raw;
}
