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

export class ProviderError extends Error {
  constructor(code, message, { cause, provider } = {}) {
    super(message || SAFE_MESSAGES[code] || SAFE_MESSAGES.failed);
    this.name = 'ProviderError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
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
const REFUSAL_RE = /sensitive|nsfw|explicit|porn|sexual|moderat|content polic|policy violation|violat|prohibit|forbidden|inappropriate|unsafe|safety|blocked by|minor|child|underage|copyright|celebrit|public figure/i;

export function isContentRefusal(text) {
  return REFUSAL_RE.test(String(text || ''));
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
