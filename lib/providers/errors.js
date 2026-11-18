/*
 * ProviderError is the only error the provider layer throws.
 *   .code     'blocked' | 'failed' | 'rate_limited' | 'config'
 *   .message  safe to show a customer (never a provider/model name or raw detail)
 *   .cause    the raw upstream error or body, for logs only
 */

export const SAFE_MESSAGES = {
  blocked: "This can't be generated because it breaks the content rules. Try a different description or image.",
  failed: 'Generation failed. Please try again.',
  rate_limited: 'The service is busy right now. Please try again in a minute.',
};

// Env vars whose values must never appear in a stored error.
const SECRET_ENV = [
  'ANTHROPIC_API_KEY', 'KIE_API_KEY', 'REPLICATE_API_TOKEN', 'GROQ_API_KEY', 'APIFY_TOKEN',
  'SCRAPECREATORS_API_KEY', 'FISH_API_KEY', 'GOOGLE_AI_API_KEY', 'BLOB_READ_WRITE_TOKEN',
  'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'KIE_WEBHOOK_SECRET',
];

export function redactSecrets(text) {
  let out = String(text ?? '').replace(/(Bearer|Token|Basic)\s+[^\s"',;]+/gi, '$1 [redacted]');
  for (const name of SECRET_ENV) {
    const v = process.env[name];
    if (v && v.length >= 6) out = out.split(v).join('[redacted]');
  }
  return out;
}

/**
 * Reduces any upstream error/body to { name?, status?, code?, message } with
 * secrets redacted. SDK error objects can carry the request (with its
 * Authorization header), so they are never stored whole.
 */
function sanitizeCause(cause) {
  if (cause === undefined || cause === null) return undefined;
  if (typeof cause !== 'object') return { message: redactSecrets(cause).slice(0, 2000) };
  const out = {};
  if (cause instanceof Error) out.name = cause.name;
  const status = cause.status ?? cause.response?.status;
  if (Number.isFinite(status)) out.status = status;
  const code = cause.code ?? cause.kieCode;
  if (code !== undefined && (typeof code === 'string' || typeof code === 'number')) out.code = code;
  // fetch() wraps socket errors: TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }).
  const causeCode = cause.cause?.code ?? cause.causeCode;
  if (typeof causeCode === 'string' || typeof causeCode === 'number') out.causeCode = causeCode;
  let message = cause.message;
  if (message === undefined) {
    try {
      message = JSON.stringify(cause);
    } catch {
      message = String(cause);
    }
  }
  out.message = redactSecrets(message).slice(0, 2000);
  return out;
}

// A request that may have reached the provider although we got no answer:
// the socket closed after sending, a timeout or abort, or a gateway error.
// The job runner never repeats such a submit (it could create a second paid task).
const AMBIGUOUS_NAMES = new Set(['TimeoutError', 'AbortError']);
const AMBIGUOUS_CODES = new Set(['ECONNRESET', 'UND_ERR_SOCKET', 'EPIPE', 'UND_ERR_CLOSED', 'ETIMEDOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);
const AMBIGUOUS_STATUS = new Set([502, 503, 504]);

function isAmbiguousCause(c) {
  if (!c || typeof c !== 'object') return false;
  if (AMBIGUOUS_NAMES.has(c.name) || AMBIGUOUS_NAMES.has(c.cause?.name)) return true;
  if (AMBIGUOUS_CODES.has(c.code) || AMBIGUOUS_CODES.has(c.cause?.code) || AMBIGUOUS_CODES.has(c.causeCode)) return true;
  const status = c.status ?? c.response?.status;
  return AMBIGUOUS_STATUS.has(status);
}

export class ProviderError extends Error {
  constructor(code, message, { cause, provider } = {}) {
    super(message || SAFE_MESSAGES[code] || SAFE_MESSAGES.failed);
    this.name = 'ProviderError';
    this.code = code;
    /** true when the request may have reached the provider (see isAmbiguousCause). */
    this.ambiguous = isAmbiguousCause(cause);
    const safe = sanitizeCause(cause);
    if (safe !== undefined) this.cause = safe;
    if (provider) this.provider = provider;
  }
}

export function configError(envName, provider) {
  return new ProviderError('config', `${envName} is not set. Add it to .env.local.`, { provider });
}

/** Reads a required env var or throws ProviderError 'config' naming it. */
export function requireEnv(name, provider) {
  const v = process.env[name];
  if (!v) throw configError(name, provider);
  return v;
}

// Content-policy refusals across kie/Kling/Seedance/Google/Fish wording.
// Deliberately phrase-based: bare words like "violates", "forbidden",
// "safety", "minor" or "child" also appear in technical failures.
const REFUSAL_RE = new RegExp([
  '\\bnsfw\\b',
  '\\bporn',
  '\\bsexual',
  '\\bnudity\\b',
  'explicit (content|material|image)',
  'sensitive (content|information|words?|image)',
  'content (polic(y|ies)|moderation|safety|filter|review|guidelines)',
  '(usage|safety|community|acceptable use) (polic(y|ies)|guidelines)',
  '\\bmoderation\\b',
  'safety (system|filter|check)',
  '(prohibited|inappropriate|harmful|unsafe|restricted|violent) content',
  'flagged (as|by|for)',
  '\\bcopyright',
  '\\bcelebrit',
  'public figure',
  '(involving|depicting|of) (a )?minors?',
  'child (safety|sexual|abuse|exploitation)',
  '\\bunderage\\b',
].join('|'), 'i');

export function isContentRefusal(text) {
  return REFUSAL_RE.test(String(text || ''));
}

// A failure that is the provider's own hiccup and may well work a moment later (not the request's fault): a 5xx, a request
// timeout (408), or wording like "Internal Error, Please try again later" / "timed out". A content refusal, a 4xx and a
// rate limit (429, handled by its own wait) are never transient. Used to retry free work once (story_jobs payload.retryTransient).
const TRANSIENT_RE = /(internal (server )?error|try again later|temporar(y|ily)|timed? ?out|timeout|overloaded|service unavailable|bad gateway|gateway time)/i;

export function isTransientFailure(status, text) {
  if (isContentRefusal(text)) return false;
  const code = Number(status);
  if (Number.isFinite(code) && code > 0) return code >= 500 || code === 408;
  return TRANSIENT_RE.test(String(text || ''));
}

/** Builds a ProviderError from an HTTP status (or kie body code) and detail. */
export function errorFromStatus(status, detail, provider) {
  const cause = typeof detail === 'string' ? new Error(detail.slice(0, 2000)) : detail;
  if (status === 429) return new ProviderError('rate_limited', undefined, { cause, provider });
  if ((status === 400 || status === 422 || status === 451) && isContentRefusal(typeof detail === 'string' ? detail : JSON.stringify(detail))) {
    return new ProviderError('blocked', undefined, { cause, provider });
  }
  return new ProviderError('failed', undefined, { cause, provider });
}

/** Normalises any thrown value into a ProviderError. */
export function toProviderError(err, provider) {
  if (err instanceof ProviderError) return err;
  const status = err?.status ?? err?.kieCode;
  if (status === 429 || err?.kieCode === 429) return new ProviderError('rate_limited', undefined, { cause: err, provider });
  return new ProviderError('failed', undefined, { cause: err, provider });
}
