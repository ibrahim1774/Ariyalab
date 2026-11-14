/*
 * Small HTTP helpers shared by the /api/oauth/* routes.
 */

/** True when the request's Content-Type is `type` (parameters such as charset ignored). */
export function hasContentType(req, type) {
  const raw = String(req?.headers?.['content-type'] || '');
  return raw.split(';')[0].trim().toLowerCase() === type;
}

/** Token and registration responses must not be cached (RFC 6749 5.1, RFC 7591 3.2.1). */
export function noStore(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
}

export function methodNotAllowed(res, allow) {
  res.setHeader('Allow', allow);
  return res.status(405).json({ error: 'invalid_request', error_description: `Use ${allow}.` });
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ESCAPES[c]);

/** A minimal error page (text escaped), framing forbidden. */
export function sendErrorPage(res, status, title, message) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).send(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<title>${escapeHtml(title)}</title></head>` +
      `<body style="font-family:system-ui,sans-serif;background:#FDFBF5;color:#16130F;padding:48px 16px">` +
      `<main style="max-width:480px;margin:0 auto;background:#fff;border-radius:20px;padding:28px;box-shadow:0 12px 32px -14px rgba(22,19,15,.14)">` +
      `<h1 style="font-size:22px;margin:0 0 12px">${escapeHtml(title)}</h1><p style="margin:0;line-height:1.5">${escapeHtml(message)}</p>` +
      `</main></body></html>`
  );
}
