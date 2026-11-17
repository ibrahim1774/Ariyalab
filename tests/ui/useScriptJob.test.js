// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

import useScriptJob from '../../components/maker/useScriptJob';

const job = (id, status) => ({ id, kind: 'script', status });

describe('useScriptJob', () => {
  it('fires once when a running job ends', () => {
    const done = vi.fn();
    const { rerender, result } = renderHook(({ jobs }) => useScriptJob(jobs, done, { ready: true }), { initialProps: { jobs: [job('a', 'running')] } });
    expect(result.current).toBe(true);
    rerender({ jobs: [job('a', 'done')] });
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('R4-6: a job that started and finished between two polls still fires, once, and an old finished job never does on load', () => {
    const done = vi.fn();
    const { rerender } = renderHook(({ jobs, ready }) => useScriptJob(jobs, done, { ready }), { initialProps: { jobs: [], ready: false } });
    rerender({ jobs: [job('old', 'done')], ready: true });
    expect(done).not.toHaveBeenCalled();
    rerender({ jobs: [job('old', 'done'), job('new', 'done')], ready: true });
    expect(done).toHaveBeenCalledTimes(1);
    rerender({ jobs: [job('old', 'done'), job('new', 'done')], ready: true });
    expect(done).toHaveBeenCalledTimes(1);
    rerender({ jobs: [job('old', 'done'), job('new', 'done'), job('third', 'failed')], ready: true });
    expect(done).toHaveBeenCalledTimes(2);
  });
});
