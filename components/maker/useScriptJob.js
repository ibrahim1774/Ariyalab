import { useEffect, useRef } from 'react';

import { scriptJobActive } from './steps';

/**
 * Is a script job (a rewrite for a new style, a draft) running? `onFinished` runs once when it stops, so the screen that
 * holds its own copy of the script reads it again by itself.
 */
export default function useScriptJob(jobs, onFinished) {
  const active = scriptJobActive(jobs || []);
  const was = useRef(false);
  const cb = useRef(onFinished);
  cb.current = onFinished;
  useEffect(() => {
    if (was.current && !active) cb.current?.();
    was.current = active;
  }, [active]);
  return active;
}
