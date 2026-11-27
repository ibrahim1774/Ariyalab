import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendCapiEvent } from '../lib/meta.js';
import { KEY, META_NS, nsEventId } from '../lib/metaKeys.js';
import { META_PRODUCT } from '../components/MetaPixel.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('Meta product tag', () => {
  it('server events and event ids say sonallo; browser pixel tag matches', async () => {
    vi.stubEnv('META_ACCESS_TOKEN', 'test-token');
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => '{}' }));
    vi.stubGlobal('fetch', fetchMock);
    const eventId = nsEventId('ic-cs_1');
    expect(eventId).toBe('sonallo-ic-cs_1');
    await sendCapiEvent({ eventName: 'InitiateCheckout', eventId, value: 5, customData: { kind: 'subscription' } });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.data[0].custom_data.product).toBe('sonallo');
    expect(body.data[0].event_id).toBe('sonallo-ic-cs_1');
    expect(META_PRODUCT).toBe('sonallo');
  });

  it('Stripe metadata keys keep the ariyalab namespace', () => {
    expect(META_NS).toBe('ariyalab');
    expect(KEY.credits).toBe('ariyalab_credits');
  });
});
