import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';

import Button from '../ui/Button';
import ErrorNotice from './ErrorNotice';
import { signInHref } from './errors';
import MakerLayout from './MakerLayout';
import { MakerNavProvider } from './MakerNav';
import { PricingProvider } from './PricingContext';
import QuoteBar from './QuoteBar';
import StepCast from './StepCast';
import StepGenerate from './StepGenerate';
import StepLength from './StepLength';
import StepPurpose from './StepPurpose';
import StepReview from './StepReview';
import StepScript from './StepScript';
import StepStart from './StepStart';
import StepStoryboard from './StepStoryboard';
import StepStyle from './StepStyle';
import { FinishSlot, ReferenceBreakdownSlot, VoiceSoundSlot } from './slots';
import { furthestId, nextId, staleIds, stepsFor } from './steps';
import useProject from './useProject';
import styles from './Steps.module.css';

/** The maker for one project: stepper, the current step, the quote bar, and the chat slot. */
function MakerPageInner({ id, returnTo }) {
  const data = useProject(id);
  const { project, shots, cast, jobs, loading, error, refresh, save } = data;
  const [view, setView] = useState(null);
  const [reachedLocal, setReachedLocal] = useState(null);
  const lastFurthest = useRef(null);

  const list = stepsFor(project);
  const index = (stepId) => list.findIndex((s) => s.id === stepId);
  const furthest = project ? furthestId(project) : null;
  const reachedId = [furthest, reachedLocal].filter(Boolean).sort((a, b) => index(b) - index(a))[0] || null;

  // Follow the server forward when the customer was on the furthest step; otherwise leave them where they are.
  useEffect(() => {
    if (!furthest) return;
    setView((v) => (v === null || v === lastFurthest.current ? furthest : v));
    lastFurthest.current = furthest;
  }, [furthest]);

  useEffect(() => {
    if (error?.status === 401 && typeof window !== 'undefined') window.location.assign(signInHref(returnTo));
  }, [error, returnTo]);

  const goTo = useCallback((stepId) => setView(stepId), []);
  const next = useCallback(() => {
    const target = nextId(project, view);
    setReachedLocal((r) => (index(r) >= index(target) ? r : target));
    setView(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, view]);

  if (!project) {
    return (
      <MakerNavProvider value={{ goTo }}>
      <MakerLayout title="Your video" steps={stepsFor(null).map((s) => ({ id: s.id, label: s.label, locked: true }))} currentId="start">
        {loading ? (
          <p className={styles.muted} role="status">Loading your video…</p>
        ) : (
          <>
            <ErrorNotice error={error} returnTo={returnTo} onRefresh={refresh} />
            <Link href="/app">Back to your videos</Link>
          </>
        )}
      </MakerLayout>
      </MakerNavProvider>
    );
  }

  const stale = staleIds(project, shots);
  const steps = list.map((s) => ({ id: s.id, label: s.label, stale: stale.has(s.id), locked: index(s.id) > index(reachedId) }));
  const current = view || furthest;
  const common = { project, returnTo, refresh, onNext: next, goTo };
  const showQuote = index(current) >= index('length');
  const reloadKey = `${project.step}:${jobs.filter((j) => j.status === 'done').length}`;

  let body;
  switch (current) {
    case 'start': body = <StepStart {...common} save={save} />; break;
    case 'purpose': body = <StepPurpose {...common} save={save} />; break;
    case 'style': body = <StepStyle {...common} save={save} />; break;
    case 'length': body = <StepLength {...common} save={save} />; break;
    case 'breakdown': body = <ReferenceBreakdownSlot project={project} />; break;
    case 'script': body = <StepScript {...common} />; break;
    case 'cast': body = <StepCast {...common} cast={cast} jobs={jobs} />; break;
    case 'storyboard': body = <StepStoryboard {...common} shots={shots} />; break;
    case 'audio':
      body = (
        <div className={styles.step}>
          <VoiceSoundSlot project={project} />
          <div className={styles.actions}><Button onClick={next}>Continue to generate</Button></div>
        </div>
      );
      break;
    case 'generate': body = <StepGenerate {...common} shots={shots} />; break;
    case 'review': body = <StepReview {...common} shots={shots} status={data} />; break;
    case 'finish': body = <FinishSlot project={project} />; break;
    default: body = null;
  }

  return (
    <MakerNavProvider value={{ goTo }}>
    <MakerLayout
      title={project.title}
      steps={steps}
      currentId={current}
      onSelect={goTo}
      notice={error ? <ErrorNotice error={error} returnTo={returnTo} onRefresh={refresh} /> : null}
      quote={showQuote ? <QuoteBar project={project} shots={shots} reloadKey={reloadKey} /> : null}
    >
      {body}
    </MakerLayout>
    </MakerNavProvider>
  );
}

/** The maker for one project: stepper, the current step, the quote bar, and the chat slot. */
export default function MakerPage(props) {
  return (
    <PricingProvider>
      <MakerPageInner {...props} />
    </PricingProvider>
  );
}
