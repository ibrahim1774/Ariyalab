import { useEffect, useRef } from 'react';

import { ACTIVE_JOB } from './steps';

/**
 * Is a script job (a rewrite for a new style, a draft) running? `onFinished` runs when a script job has finished since the
 * last look: a running one that ended, or one that started and finished between two polls (the latest finished job is a
 * different one). `ready`: the first real status has arrived; what had finished before that never fires.
 */
export default function useScriptJob(jobs, onFinished, { ready = true } = {}) {
  const list = (jobs || []).filter((j) => j.kind === 'script');
  const active = list.some((j) => ACTIVE_JOB.has(j.status));
  const finished = [...list].reverse().find((j) => !ACTIVE_JOB.has(j.status));
  const finishedId = finished?.id ?? null;
  const seen = useRef(undefined); // undefined until ready; then the last finished job id looked at
  const cb = useRef(onFinished);
  cb.current = onFinished;
  useEffect(() => {
    if (!ready) return;
    if (seen.current === undefined) {
      seen.current = finishedId;
      return;
    }
    if (finishedId !== seen.current) {
      seen.current = finishedId;
      cb.current?.();
    }
  }, [ready, finishedId, active]);
  return active;
}
