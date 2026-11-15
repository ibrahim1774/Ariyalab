// /ugc-2/claim and /api/checkout/claim-ticket add their cookies to the
// response instead of replacing Set-Cookie (a refreshed Supabase session
// cookie set earlier in the same request must survive). Stripe is a stub.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/stripe', () => ({
  stripe: () => ({
    checkout: { sessions: { retrieve: async () => ({ id: 'cs_test_1', payment_status: 'paid' }) } },
  }),
}));

const { appendSetCookie } = await import('../../lib/setCookie.js');
const { getServerSideProps } = await import('../../pages/ugc-2/claim.js');
const { clearClaimCookie } = await import('../../pages/api/checkout/claim-ticket.js');

function nodeRes(initial) {
  const headers = initial === undefined ? {} : { 'set-cookie': initial };
  return {
    headers,
    setHeader: (name, value) => {
      headers[name.toLowerCase()] = value;
    },
    getHeader: (name) => headers[name.toLowerCase()],
  };
}

describe('Set-Cookie is appended, never overwritten', () => {
  it('lib/setCookie.js keeps what is there, in order', () => {
    const res = nodeRes('a=1');
    appendSetCookie(res, 'b=2');
    appendSetCookie(res, 'c=3');
    expect(res.headers['set-cookie']).toEqual(['a=1', 'b=2', 'c=3']);
  });

  it('/ugc-2/claim keeps a session cookie set earlier in the request', async () => {
    const res = nodeRes(['sb-auth-token=fresh; Path=/']);
    const out = await getServerSideProps({ query: { session_id: 'cs_test_1' }, res });
    expect(out.redirect.destination).toBe('/ugc-2/welcome');
    const cookies = res.headers['set-cookie'];
    expect(cookies[0]).toBe('sb-auth-token=fresh; Path=/');
    expect(cookies[1]).toMatch(/^ugc2_claim_sid=cs_test_1;/);
  });

  it('claim-ticket clears its two cookies after the session cookie', () => {
    const res = nodeRes(['sb-auth-token=fresh; Path=/']);
    clearClaimCookie(res, undefined, { metadata: {} });
    const cookies = res.headers['set-cookie'];
    expect(cookies).toHaveLength(3);
    expect(cookies[0]).toBe('sb-auth-token=fresh; Path=/');
    expect(cookies[1]).toMatch(/^ugc2_claim_sid=; .*Max-Age=0/);
    expect(cookies[2]).toMatch(/^ugc2_claim_nonce=; .*Max-Age=0/);
  });
});
