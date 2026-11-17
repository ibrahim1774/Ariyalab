import { useCallback, useEffect, useRef, useState } from 'react';

import { getProject, getStatus, updateProject } from '../../lib/story/client';
import { anyJobActive } from './steps';
import { renderActive } from './finish';

export const POLL_ACTIVE_MS = 3000;
export const POLL_IDLE_MS = 15000;

const EMPTY = { project: null, shots: [], cast: [], jobs: [], balance: null, render: null, renders: [], rerolls: null, renderPrice: null };

/**
 * Loads a project and keeps it fresh.
 *
 * Expects GET /projects/[id]/status -> { project, shots, cast, jobs, balance, render, renders }
 * (`render` is the latest public render row, `renders` up to 10, newest first; optional: `rerolls: { included, used, credits }`, `renderPrice: { credits }` the next render's price). Until that route exists a 404 falls back to
 * GET /projects/[id], so `degraded` is true and shots, cast and jobs are empty.
 *
 * Polls every 3 s while any job is queued or running, every 15 s otherwise, pauses while the tab is
 * hidden (and refreshes the moment it is shown again), and stops on unmount. No realtime.
 */
export default function useProject(id) {
  const [state, setState] = useState({ ...EMPTY, loading: true, error: null, degraded: false });
  const statusMissing = useRef(false);
  const runRef = useRef(null);

  useEffect(() => {
    if (!id) return undefined;
    statusMissing.current = false;
    let stopped = false;
    let timer = null;
    let inflight = false;
    let again = false;
    let active = false;

    const schedule = () => {
      clearTimeout(timer);
      if (stopped || (typeof document !== 'undefined' && document.hidden)) return;
      timer = setTimeout(run, active ? POLL_ACTIVE_MS : POLL_IDLE_MS);
    };

    async function fetchOnce() {
      if (!statusMissing.current) {
        try {
          return { data: await getStatus(id), degraded: false };
        } catch (err) {
          if (err.status !== 404) throw err;
          statusMissing.current = true;
        }
      }
      const project = await getProject(id);
      return { data: { ...EMPTY, project }, degraded: true };
    }

    async function run() {
      clearTimeout(timer);
      if (stopped) return;
      if (inflight) {
        again = true;
        return;
      }
      inflight = true;
      try {
        const { data, degraded } = await fetchOnce();
        if (stopped) return;
        // A queued or running render polls at the active rate too (the server throttles its ticks to one every 3 s).
        active = anyJobActive(data.jobs || []) || renderActive(data.render);
        setState({
          project: data.project || null,
          shots: data.shots || [],
          cast: data.cast || [],
          jobs: data.jobs || [],
          balance: data.balance ?? null,
          render: data.render ?? null,
          renders: Array.isArray(data.renders) ? data.renders : [],
          rerolls: data.rerolls ?? null,
          renderPrice: data.renderPrice ?? null,
          loading: false,
          error: null,
          degraded,
        });
      } catch (err) {
        if (stopped) return;
        setState((s) => ({ ...s, loading: false, error: err }));
      } finally {
        inflight = false;
        if (!stopped) {
          if (again) {
            again = false;
            run();
          } else {
            schedule();
          }
        }
      }
    }

    const onVisibility = () => {
      clearTimeout(timer);
      if (!document.hidden) run();
    };

    runRef.current = run;
    setState({ ...EMPTY, loading: true, error: null, degraded: false });
    run();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      runRef.current = null;
    };
  }, [id]);

  const refresh = useCallback(() => runRef.current?.(), []);

  /** PATCH the brief fields and merge the saved project. Throws a StoryApiError. */
  const save = useCallback(
    async (patch) => {
      const project = await updateProject(id, patch);
      setState((s) => ({ ...s, project: { ...(s.project || {}), ...project } }));
      return project;
    },
    [id],
  );

  return { ...state, refresh, save };
}
