import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { buildShots, getPlanQuote, makeMusic, makeNarration, makeStills, pickCast, setPlanRequested, startCast } from '../../lib/story/client';
import { FREE_STARTS, actionKey, clipsStarted, confirmedFrom, nextPlanAction } from './derive';

const COOL_MS = 4000;
// A wait older than this gets a message and a next step instead of a spinner.
export const STALLED_MS = 5 * 60_000;
const LOCK_RETRY_MS = 5000;

/**
 * One tab at a time runs the free parts of a plan: a Web Lock named for the project, taken without waiting. Where the API is
 * missing the tab runs without it. -> true while this tab may run them.
 */
export function usePlanLock(projectId, wanted) {
  const supported = typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function';
  const [held, setHeld] = useState(!supported);
  const release = useRef(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!supported || !projectId || !wanted || held) return undefined;
    let gone = false;
    navigator.locks.request(`ariya-plan-${projectId}`, { ifAvailable: true }, (lock) => {
      if (!lock) return undefined;
      if (gone) return undefined;
      setHeld(true);
      return new Promise((resolve) => { release.current = resolve; });
    }).catch(() => {});
    const timer = setTimeout(() => setTick((n) => n + 1), LOCK_RETRY_MS);
    return () => { gone = true; clearTimeout(timer); };
  }, [supported, projectId, wanted, held, tick]);
  useEffect(() => () => { release.current?.(); }, []);
  return held;
}

/** What the pipeline says it is doing, in plain words, for the progress line and the screen reader. */
export function stageText(action) {
  if (!action) return '';
  if (action.type === 'cast') return 'Starting your characters';
  if (action.type === 'build') return 'Planning your shots';
  if (action.type === 'pick') return `Picking a look for ${action.name || 'your character'}`;
  if (action.type === 'resume_cast') return 'Getting your characters going again';
  if (action.type === 'stills') return 'Drawing the storyboard pictures';
  if (action.type === 'narration') return 'Recording the narration';
  if (action.type === 'music') return 'Composing the music';
  if (action.type === 'wait') {
    const w = action.what || [];
    if (w.includes('script')) return 'Rewriting your script';
    if (w.includes('characters')) return 'Drawing your characters';
    if (w.includes('pictures')) return 'Drawing the storyboard pictures';
    if (w.includes('voice')) return 'Recording the narration';
    if (w.includes('music')) return 'Composing the music';
  }
  return '';
}

/**
 * Drives "Looks good, design my video": cast -> wait for the automatic picks -> shots -> pictures -> narration -> music.
 *
 * It is driven by server state, not by its own memory: every render it asks nextPlanAction(status) what is missing and starts
 * only that. So a reload, or a second tab, continues from wherever the project is. Money rules:
 *  - a part that costs credits starts only with the amount the customer confirmed in this tab (the quote when they pressed the
 *    button); after a reload nothing is confirmed, so only parts that cost 0 are resumed and a priced part is shown as a question;
 *  - each start is sent once per mounted screen (a poll that has not seen the result yet never repeats it);
 *  - a 409 quote_changed drops the confirmation and shows the new price; any other 409 is another tab's start: refresh and wait;
 *  - any other error (402 included) stops the pipeline and is shown, until the customer asks again.
 *
 * Returns { quote, quoteError, action, busy, armed, error, note, design, confirm, retry, reloadQuote }.
 */
export default function usePlanPipeline({ status, screen, refresh, quoteKey = '' }) {
  const project = status?.project || null;
  const projectId = project?.id;
  const [quote, setQuote] = useState(null);
  const [quoteError, setQuoteError] = useState(null);
  const [armed, setArmed] = useState(false);
  const [confirmed, setConfirmed] = useState({});
  const [error, setError] = useState(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const inflight = useRef(false);
  const sent = useRef(new Set());
  const cool = useRef(new Map());
  const quoteRun = useRef(0);
  const [stalled, setStalled] = useState(false);
  const cleared = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const reloadQuote = useCallback(async () => {
    if (!projectId) return null;
    const run = ++quoteRun.current;
    try {
      const next = await getPlanQuote(projectId);
      if (alive.current && run === quoteRun.current) {
        setQuote(next);
        setQuoteError(null);
      }
      return next;
    } catch (err) {
      if (alive.current && run === quoteRun.current) {
        setQuote(null);
        setQuoteError(err);
      }
      return null;
    }
  }, [projectId]);

  // The price on the "design my video" button: read while the script screen is open, and again when what it depends on changes.
  // The plan screen needs it too when the cast is missing after clips exist (the switch to the same characters): the cast fee.
  const castMissing = screen === 'plan' && project?.consistent_cast !== false && (status?.cast || []).length === 0;
  useEffect(() => {
    if ((screen === 'script' || castMissing) && projectId) reloadQuote();
  }, [screen, castMissing, projectId, quoteKey, reloadQuote]);

  const action = useMemo(() => nextPlanAction(status, { confirmed, quote }), [status, confirmed, quote]);
  const marker = Boolean(project?.plan_requested);
  const lockHeld = usePlanLock(projectId, (armed || marker) && (screen === 'plan' || screen === 'script'));
  // Free parts start by themselves only when the customer pressed "Looks good" (this tab now, or the project's marker) AND this
  // tab holds the project's lock. A project that never had that press (the detailed editor) shows a button instead.
  const free = FREE_STARTS.includes(action.type);
  const enabled = screen === 'plan' || armed ? (free ? (armed || marker) && lockHeld : true) : false;
  const actionSig = JSON.stringify(action);
  const manual = screen === 'plan' && free && !armed && !marker;
  const otherTab = screen === 'plan' && free && marker && !lockHeld;

  useEffect(() => {
    if (action.type === 'done' && armed) {
      setArmed(false);
      setConfirmed({});
    }
  }, [action.type, armed]);

  // The plan is complete: clear the marker (once) so a later visit never starts anything by itself.
  useEffect(() => {
    // Also once clips exist: the same refresh that completes the plan moves the screen on to Watch, so 'plan' is never seen again.
    if (action.type !== 'done' || !marker || cleared.current || !projectId || armed) return;
    if (screen !== 'plan' && !clipsStarted(status)) return;
    cleared.current = true;
    Promise.resolve(setPlanRequested(projectId, false)).then(() => refresh?.()).catch(() => { cleared.current = false; });
  }, [action.type, marker, projectId, screen, armed, status, refresh]);

  // Nothing waits forever: a wait that lasts too long says so (and the screen offers a next step).
  const waitKey = action.type === 'wait' ? action.what.join(',') : '';
  useEffect(() => {
    setStalled(false);
    if (!waitKey) return undefined;
    const timer = setTimeout(() => setStalled(true), STALLED_MS);
    return () => clearTimeout(timer);
  }, [waitKey]);

  useEffect(() => {
    if (!enabled || error || inflight.current || !projectId) return undefined;
    const key = actionKey(action);
    if (!key || sent.current.has(key)) return undefined;
    const wait = (cool.current.get(key) || 0) - Date.now();
    if (wait > 0) {
      const timer = setTimeout(() => setTick((n) => n + 1), wait + 20);
      return () => clearTimeout(timer);
    }
    inflight.current = true;
    setBusy(true);
    (async () => {
      try {
        if (action.type === 'cast' || action.type === 'resume_cast') await startCast(projectId, action.expected);
        else if (action.type === 'pick') await pickCast(projectId, action.castId, 0);
        else if (action.type === 'build') await buildShots(projectId);
        else if (action.type === 'stills') await makeStills(projectId, action.ids, action.expected);
        else if (action.type === 'narration') await makeNarration(projectId, { expectedCredits: action.expected });
        else if (action.type === 'music') await makeMusic(projectId, { expectedCredits: action.expected });
        sent.current.add(key);
      } catch (err) {
        if (err?.status === 409 && err?.code === 'quote_changed') {
          // Not charged. The price the customer saw is out of date: forget it, read the new one, and ask again.
          setConfirmed((c) => {
            const next = { ...c };
            if (action.type === 'cast') delete next.fee;
            if (action.type === 'stills') delete next.pictures;
            if (action.type === 'narration') delete next.voice;
            if (action.type === 'music') delete next.music;
            return next;
          });
          if (action.type === 'cast') setArmed(false);
          setNote('The price changed. Check the new price, then press the button again.');
          if (alive.current) reloadQuote();
        } else if (err?.status === 409) {
          // Another tab (or an earlier request) is already doing this, or something is still being made. Not an error: say what
          // it waits for and look again after a moment.
          if (err.code === 'shots_busy') setNote('Waiting for what is being made now to finish…');
          else if (err.code === 'drafting_busy') setNote('Your script is being rewritten. This will carry on when it is done.');
          else if (err.code === 'cast_needed') setNote('Your characters need to be made first.');
          cool.current.set(key, Date.now() + COOL_MS);
        } else if (alive.current) {
          setError(err);
        }
      } finally {
        await Promise.resolve(refresh?.()).catch(() => {});
        inflight.current = false;
        if (alive.current) {
          setBusy(false);
          setTick((n) => n + 1);
        }
      }
    })();
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, actionSig, error, projectId, tick]);

  /** "Looks good, design my video": the customer confirms the quote they are looking at. */
  const design = useCallback(async () => {
    if (!quote) return;
    setError(null);
    setNote('');
    try {
      // The marker first: from now on the free parts of this plan may start by themselves, in this tab.
      await setPlanRequested(projectId, true);
    } catch (err) {
      if (alive.current) setError(err);
      return;
    }
    cleared.current = false;
    setConfirmed(confirmedFrom(quote));
    setArmed(true);
  }, [quote, projectId]);

  /** "Carry on designing": the free parts of a plan the customer did not start here (the detailed editor, or an older visit). */
  const carryOn = useCallback(async () => {
    setError(null);
    try {
      await setPlanRequested(projectId, true);
    } catch (err) {
      if (alive.current) setError(err);
      return;
    }
    cleared.current = false;
    setArmed(true);
    await Promise.resolve(refresh?.()).catch(() => {});
  }, [projectId, refresh]);

  /** Confirms the price of a part that now costs credits ("Make the pictures (2 credits)"). */
  const confirm = useCallback(async () => {
    if (action.type !== 'ask' || !Number.isInteger(action.credits)) return;
    const field = { pictures: 'pictures', voice: 'voice', music: 'music', cast: 'fee' }[action.what];
    if (!field) return;
    setError(null);
    setNote('');
    try {
      // Pressing carries the plan on: the marker lets the free parts after it start by themselves in this tab.
      await setPlanRequested(projectId, true);
    } catch (err) {
      if (alive.current) setError(err);
      return;
    }
    cleared.current = false;
    setConfirmed((c) => ({ ...c, [field]: action.credits }));
    setArmed(true);
  }, [action, projectId]);

  /** After an error: allow the stopped start again. */
  const retry = useCallback(() => {
    setError(null);
    setNote('');
    setTick((n) => n + 1);
  }, []);

  return { quote, quoteError, action, busy, armed, error, note, stalled, manual, otherTab, design, carryOn, confirm, retry, reloadQuote };
}
