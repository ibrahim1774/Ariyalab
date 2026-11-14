import dns from 'node:dns';
import util from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertPublicHttpUrl,
  guardedLookup,
  isPrivateAddress,
  resolvePublicUrl,
} from '../../lib/providers/http.js';
import { ProviderError, isContentRefusal } from '../../lib/providers/errors.js';

function stubLookup(answers) {
  // answers: array of address lists, consumed one per call (last one repeats)
  let i = 0;
  return vi.spyOn(dns, 'lookup').mockImplementation((host, opts, cb) => {
    const callback = typeof opts === 'function' ? opts : cb;
    const list = answers[Math.min(i++, answers.length - 1)];
    const addrs = list.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    process.nextTick(() => {
      if (opts && opts.all) callback(null, addrs);
      else callback(null, addrs[0].address, addrs[0].family);
    });
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('assertPublicHttpUrl (literal checks)', () => {
  it.each([
    'http://localhost./a',
    'http://foo.localhost./a',
    'http://LOCALHOST/a',
    'http://[::127.0.0.1]/a',
    'http://[::ffff:10.0.0.1]/a',
    'http://[fe90::1]/a',
    'http://[fec0::1]/a',
    'http://[fd12::1]/a',
    'http://[64:ff9b::7f00:1]/a',
    'http://[ff02::1]/a',
    'http://100.100.100.200/a',
    'http://198.18.0.1/a',
    'http://224.0.0.1/a',
    'http://255.255.255.255/a',
    'http://0.0.0.0/a',
    'http://2130706433/a',
    'http://0x7f.1/a',
    'http://intranet/a',
  ])('rejects %s', (url) => {
    expect(() => assertPublicHttpUrl(url)).toThrow(expect.objectContaining({ code: 'failed' }));
  });

  it.each([
    'https://fcbarcelona.com/v.mp4',
    'https://fd.example.com/v.mp4',
    'http://8.8.8.8/v.mp4',
    'http://[2606:4700::1111]/v.mp4',
    'https://cdn.example.com./v.mp4',
  ])('allows %s', (url) => {
    expect(() => assertPublicHttpUrl(url)).not.toThrow();
  });

  it('classifies addresses', () => {
    expect(isPrivateAddress('10.0.0.5')).toBe(true);
    expect(isPrivateAddress('169.254.169.254')).toBe(true);
    expect(isPrivateAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateAddress('93.184.216.34')).toBe(false);
    expect(isPrivateAddress('not-an-ip')).toBe(true);
  });
});

describe('resolvePublicUrl (DNS)', () => {
  it('rejects a public-looking name that resolves to a private address', async () => {
    stubLookup([['10.0.0.5']]);
    await expect(resolvePublicUrl('https://127.0.0.1.nip.io/x')).rejects.toMatchObject({ code: 'failed' });
  });

  it('rejects when ANY resolved address is private', async () => {
    stubLookup([['93.184.216.34', '127.0.0.1']]);
    await expect(resolvePublicUrl('https://mixed.example.com/x')).rejects.toMatchObject({ code: 'failed' });
  });

  it('allows a name that resolves only to public addresses', async () => {
    stubLookup([['93.184.216.34', '2606:2800:220:1::1']]);
    const url = await resolvePublicUrl('https://cdn.example.com/x');
    expect(url.hostname).toBe('cdn.example.com');
  });

  it('does not resolve IP literals', async () => {
    const spy = stubLookup([['10.0.0.1']]);
    await resolvePublicUrl('http://8.8.8.8/x');
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('guardedLookup (connect-time pinning)', () => {
  function run(opts) {
    return new Promise((resolve) => {
      guardedLookup('rebind.example.com', opts, (err, address, family) => resolve({ err, address, family }));
    });
  }

  it('blocks DNS rebinding: public on the check, private at connect', async () => {
    stubLookup([['93.184.216.34'], ['127.0.0.1']]);
    await resolvePublicUrl('https://rebind.example.com/x');
    const connect = await run({});
    expect(connect.err).toBeTruthy();
    expect(connect.address).toBeUndefined();
  });

  it('returns the checked public address (single and all forms)', async () => {
    stubLookup([['93.184.216.34']]);
    expect(await run({})).toMatchObject({ err: null, address: '93.184.216.34', family: 4 });
    const all = await new Promise((resolve) => guardedLookup('x.example.com', { all: true }, (e, a) => resolve(a)));
    expect(all).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });
});

describe('isContentRefusal', () => {
  it.each([
    'The content violates our sensitive content policy',
    'Prompt flagged as NSFW by moderation',
    'Your request was rejected by the safety system: content policy',
    'Image contains a public figure',
  ])('treats "%s" as a refusal', (msg) => {
    expect(isContentRefusal(msg)).toBe(true);
  });

  it.each([
    'image size violates minimum dimensions',
    'forbidden: invalid api key',
    'child process exited with code 1',
    'minor version mismatch',
    'safety margin exceeded for queue',
  ])('treats "%s" as a technical failure', (msg) => {
    expect(isContentRefusal(msg)).toBe(false);
  });
});

describe('ProviderError.cause never carries secrets', () => {
  it('keeps a sanitised status/message only', () => {
    vi.stubEnv('REPLICATE_API_TOKEN', 'r8_supersecret');
    const upstream = Object.assign(new Error('Request failed for token r8_supersecret'), {
      status: 401,
      request: { headers: { Authorization: 'Bearer r8_supersecret' } },
      response: { status: 401 },
    });
    const err = new ProviderError('failed', undefined, { cause: upstream, provider: 'replicate' });
    expect(err.cause).toEqual({ name: 'Error', status: 401, message: 'Request failed for token [redacted]' });
    expect(JSON.stringify(err)).not.toContain('r8_supersecret');
    expect(util.inspect(err, { depth: 10 })).not.toContain('r8_supersecret');
    const bearer = new ProviderError('failed', undefined, { cause: 'header was Bearer abc.def-123' });
    expect(bearer.cause.message).toBe('header was Bearer [redacted]');
  });
});
