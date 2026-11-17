import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { buildShots, getPlanQuote, makeMusic, makeNarration, makeStills, startCast } from '../../lib/story/client';
import { actionKey, confirmedFrom, nextPlanAction } from './derive';

const COOL_MS = 4000;

/** What the pipeline says it is doing, in plain words, for the progress line and the screen reader. */
export function stageText(action) {
  if (!action) return '';
  if (action.type === 'cast') return 'Starting your characters';
  if (action.type === 'build') return 'Planning your shots';
  if (action.type === 'stills') return 'Drawing the storyboard pictures';
  if (action.type === 'narration') return 'Recording the narration';
  if (action.type === 'music') return 'Composing the music';
  if (action.type === 'wait') {
    const w = action.what || [];
    if (w.includes('characters')) return 'Drawing your characters';
    if (w.includes('looks')) return 'Picking a look for each character';
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
  useEffect(() => {
    if (screen === 'script' && projectId) reloadQuote();
  }, [screen, projectId, quoteKey, reloadQuote]);

  const action = useMemo(() => nextPlanAction(status, { confirmed }), [status, confirmed]);
  const enabled = armed || screen === 'plan';
  const actionSig = JSON.stringify(action);

  useEffect(() => {
    if (action.type === 'done' && armed) {
      setArmed(false);
      setConfirmed({});
    }
  }, [action.type, armed]);

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
        if (action.type === 'cast') await startCast(projectId, action.expected);
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
          // Another tab (or an earlier request) is already doing this. Not an error: look again after a moment.
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
  const design = useCallback(() => {
    if (!quote) return;
    setError(null);
    setNote('');
    setConfirmed(confirmedFrom(quote));
    setArmed(true);
  }, [quote]);

  /** Confirms the price of a part that now costs credits ("Make the pictures (2 credits)"). */
  const confirm = useCallback(() => {
    if (action.type !== 'ask') return;
    const field = { pictures: 'pictures', voice: 'voice', music: 'music' }[action.what];
    if (!field) return;
    setError(null);
    setNote('');
    setConfirmed((c) => ({ ...c, [field]: action.credits }));
    setArmed(true);
  }, [action]);

  /** After an error: allow the stopped start again. */
  const retry = useCallback(() => {
    setError(null);
    setNote('');
    setTick((n) => n + 1);
  }, []);

  return { quote, quoteError, action, busy, armed, error, note, design, confirm, retry, reloadQuote };
}
