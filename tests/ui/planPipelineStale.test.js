// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';

vi.mock('../../lib/story/client', async (importOriginal) => {
  const actual = await importOriginal();
  const mocked = {};
  for (const [key, value] of Object.entries(actual)) {
    mocked[key] = typeof value === 'function' && key !== 'StoryApiError' && key !== 'normalizeError' ? vi.fn() : value;
  }
  return mocked;
});

const client = await import('../../lib/story/client');
const { StoryApiError } = client;
const { default: usePlanPipeline } = await import('../../components/simple/usePlanPipeline');

const project = (over = {}) => ({ id: 'p1', step: 'script', seconds: 10, quality: 'standard', fee_charged: false, consistent_cast: true, plan_requested: false, ...over });
const base = (over = {}) => ({
  project: project(), shots: [], cast: [], jobs: [],
  audio: { applicable: { narration: false, narrationLines: 0 }, narration: { status: 'ready', credits: 0 }, music: { type: 'none', status: 'ready', credits: 0 } },
  scenes: [{ id: 'a' }],
  ...over,
});
// hasScript() reads project.step; give the project a script step so the pipeline sees a script.
const withScript = (over = {}) => base({ project: project({ step: 'script' }), script: { scenes: [{ id: 'a' }] }, ...over });

beforeEach(() => {
  for (const fn of Object.values(client)) if (typeof fn?.mockReset === 'function') fn.mockReset();
  client.setPlanRequested.mockResolvedValue({});
});
afterEach(() => cleanup());

describe('the plan pipeline never stays busy after a refusal', () => {
  it('a refused start (402) turns off the working state and lets the customer press the button again', async () => {
    client.getPlanQuote.mockResolvedValue({ total: 90, castFee: 90, stills: 0, lines: [{ key: 'fee', credits: 90 }] });
    client.startCast.mockRejectedValueOnce(new StoryApiError({ status: 402, code: 'plan_required' }));
    const refresh = vi.fn(async () => {});
    const status = withScript();
    const { result } = renderHook(() => usePlanPipeline({ status, screen: 'script', refresh }));
    await waitFor(() => expect(result.current.quote).not.toBeNull());
    await act(async () => { await result.current.design(); });
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error.status).toBe(402);
    expect(result.current.armed).toBe(false);
    expect(result.current.busy).toBe(false);
    expect(result.current.working).toBe(false);
    // Pressing again tries again with the same price.
    client.startCast.mockResolvedValueOnce({});
    await act(async () => { await result.current.design(); });
    await waitFor(() => expect(client.startCast).toHaveBeenCalledTimes(2));
  });

  it('a priced start is confirmed once: after it was sent and its pictures failed, the same start asks for the price again', async () => {
    client.makeStills.mockResolvedValue({});
    const cast = [{ id: 'c1', name: 'Dre', status: 'ready', chosen_index: 0, image_url: '/d.png', candidates: [{ url: '/d.png' }] }];
    const shot = (over) => ({ id: 'sh1', ord: 0, scene_id: 'a', status: 'draft', still_url: null, still_credits: 2, source: 'generated', ...over });
    let status = withScript({ project: project({ fee_charged: true, plan_requested: true }), cast, shots: [shot()] });
    const refresh = vi.fn(async () => {});
    const { result, rerender } = renderHook(() => usePlanPipeline({ status, screen: 'plan', refresh }));
    // The pictures cost 2: the pipeline asks, the customer presses.
    await waitFor(() => expect(result.current.action).toMatchObject({ type: 'ask', what: 'pictures', credits: 2 }));
    await act(async () => { await result.current.confirm(); });
    await waitFor(() => expect(client.makeStills).toHaveBeenCalledTimes(1));
    expect(client.makeStills).toHaveBeenCalledWith('p1', ['sh1'], 2);
    // The picture failed.
    status = withScript({ project: project({ fee_charged: true, plan_requested: true }), cast, shots: [shot({ status: 'failed' })] });
    rerender();
    await waitFor(() => expect(result.current.action.type).toBe('blocked'));
    expect(result.current.working).toBe(false);
    // The description is edited: the shot can be drawn again. Nothing is sent until the customer presses, and the page says so.
    status = withScript({ project: project({ fee_charged: true, plan_requested: true }), cast, shots: [shot({ status: 'draft' })] });
    rerender();
    await waitFor(() => expect(result.current.action).toMatchObject({ type: 'ask', what: 'pictures', credits: 2 }));
    expect(result.current.working).toBe(false);
    await new Promise((r) => setTimeout(r, 100));
    expect(client.makeStills).toHaveBeenCalledTimes(1);
    // Pressing sends it again, with the price shown.
    await act(async () => { await result.current.confirm(); });
    await waitFor(() => expect(client.makeStills).toHaveBeenCalledTimes(2));
  });
});

describe('a free start that keeps coming back is not sent forever', () => {
  const old = new Date(Date.now() - 10 * 60_000).toISOString();
  const stuck = () => withScript({ project: project({ fee_charged: true, plan_requested: true }), cast: [{ id: 'c1', name: 'Dre', status: 'draft', updated_at: old }] });
  const working = () => withScript({ project: project({ fee_charged: true, plan_requested: true }), cast: [{ id: 'c1', name: 'Dre', status: 'pending', updated_at: new Date().toISOString() }], jobs: [{ kind: 'cast_image', status: 'running', payload: { castId: 'c1' } }] });

  it('resume_cast coming back three times is sent twice, then asks the customer; pressing sends once more', async () => {
    client.startCast.mockResolvedValue({});
    let status = stuck();
    const refresh = vi.fn(async () => {});
    const { result, rerender } = renderHook(() => usePlanPipeline({ status, screen: 'plan', refresh }));
    for (let round = 1; round <= 3; round += 1) {
      if (round <= 2) await waitFor(() => expect(client.startCast).toHaveBeenCalledTimes(round));
      status = working(); rerender();
      await waitFor(() => expect(result.current.action.type).toBe('wait'));
      status = stuck(); rerender();
      await waitFor(() => expect(result.current.action.type).toBe('resume_cast'));
    }
    await waitFor(() => expect(result.current.tired).toBe(true));
    await new Promise((r) => setTimeout(r, 100));
    expect(client.startCast).toHaveBeenCalledTimes(2);
    expect(result.current.working).toBe(false);
    await act(async () => { result.current.retry(); });
    await waitFor(() => expect(client.startCast).toHaveBeenCalledTimes(3));
  });
});

