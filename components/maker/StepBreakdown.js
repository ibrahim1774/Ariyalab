import { useCallback, useEffect, useRef, useState } from 'react';

import Button from '../ui/Button';
import Card from '../ui/Card';
import { getReference } from '../../lib/story/client';
import ErrorNotice from './ErrorNotice';
import StepFooter from './StepFooter';
import StepReference from './StepReference';
import { Icon, Skeleton, Tile } from './Tiles';
import steps from './Steps.module.css';
import styles from './Reference.module.css';

const POLL_MS = 3000;
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const span = (b) => `${clock(b.start)} to ${clock(b.end)}`;
const WAIT = { status: 'Watching your video shot by shot', line: 'This takes about a minute. The page updates by itself.' };

function Head() {
  return (
    <div className={steps.stepHead}>
      <h2>Breakdown of <span className="accent-word">your video</span></h2>
      <p>How the reference is built, moment by moment. Your script keeps this shape with new lines, characters and setting.</p>
    </div>
  );
}

function Beat({ beat }) {
  return (
    <li className={styles.beat} aria-label={`Beat ${beat.ord}, ${span(beat)}`} data-beat={beat.ord}>
      <div className={styles.thumb}>
        {beat.thumb ? (
          <img src={beat.thumb} alt={`Beat ${beat.ord} at ${clock(beat.start)}`} loading="lazy" />
        ) : (
          <Tile icon="film" title={`Beat ${beat.ord}`} className={styles.thumbTile} />
        )}
      </div>
      <div className={styles.beatBody}>
        <p className={styles.beatHead}>
          <strong>Beat {beat.ord}</strong>
          <time>{span(beat)}</time>
        </p>
        <p className={styles.visual}>{beat.visual}</p>
        {beat.said ? <p className={styles.said}>“{beat.said}”</p> : <p className={styles.silent}>No words in this beat</p>}
        {beat.why && <p className={styles.why}><span>Why it works: </span><span data-why="">{beat.why}</span></p>}
      </div>
    </li>
  );
}

function Summary({ reference }) {
  const told = reference.mode === 'talking' ? 'People talk on screen' : 'Told with a voice over';
  return (
    <Card className={styles.summary}>
      <ul className={styles.facts} aria-label="About this video">
        <li><Icon name="film" size={16} />{reference.beats.length} {reference.beats.length === 1 ? 'beat' : 'beats'}</li>
        {reference.duration ? <li><Icon name="clock" size={16} />{clock(reference.duration)} long</li> : null}
        <li><Icon name={reference.mode === 'talking' ? 'user' : 'mic'} size={16} />{told}</li>
      </ul>
      <dl className={styles.reading}>
        {reference.hook && (<div><dt>Hook</dt><dd>{reference.hook}</dd></div>)}
        {reference.structure && (<div><dt>Shape</dt><dd>{reference.structure}</dd></div>)}
        {reference.mood && (<div><dt>Music</dt><dd>{reference.mood}</dd></div>)}
      </dl>
    </Card>
  );
}

/** Step 5 (only for a project started from a video): the reference's beat sheet, read only. */
export default function StepBreakdown({ project, onNext, refresh, returnTo }) {
  const [reference, setReference] = useState(undefined); // undefined while loading, null when there is none
  const [loadError, setLoadError] = useState(null);
  const [replacing, setReplacing] = useState(false);
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const next = await getReference(project.id);
      if (!alive.current) return;
      setReference(next);
      setLoadError(null);
    } catch (err) {
      if (alive.current) setLoadError(err);
    }
  }, [project.id]);

  useEffect(() => {
    alive.current = true;
    load();
    return () => { alive.current = false; };
  }, [load]);

  const pending = reference?.status === 'pending';
  useEffect(() => {
    if (!pending) return undefined;
    const timer = setInterval(() => { if (!document.hidden) load(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [pending, load]);

  const started = async (_id, next) => {
    setReplacing(false);
    if (next) setReference(next);
    await refresh?.();
  };
  const form = (title) => (
    <StepReference title={title} ensureProject={async () => project.id} onStarted={started} returnTo={returnTo} />
  );

  if (reference === undefined) {
    return (
      <div className={steps.step}>
        <Head />
        {loadError ? <ErrorNotice error={loadError} returnTo={returnTo} onRefresh={load} onRetry={load} /> : <Skeleton status="Loading the breakdown" ratio="16 / 5" />}
      </div>
    );
  }

  let body;
  let canContinue = false;
  let hint = null;
  if (!reference || replacing) {
    body = (
      <>
        {form(reference?.status === 'ready' ? 'Use a different video' : 'Start from a video')}
        {replacing && <div className={styles.actions}><Button variant="ghost" arrow={false} onClick={() => setReplacing(false)}>Keep this breakdown</Button></div>}
      </>
    );
    canContinue = Boolean(reference && reference.status === 'ready');
  } else if (pending) {
    body = (
      <>
        <p className={steps.srOnly} role="status" aria-live="polite">{WAIT.status}</p>
        <ol className={styles.beats} aria-label="Beats, being made">
          {[1, 2, 3].map((n) => (
            <li key={n} className={styles.beatWait}><Skeleton status={n === 1 ? WAIT.status : `Beat ${n}`} line={n === 1 ? WAIT.line : null} /></li>
          ))}
        </ol>
      </>
    );
    hint = 'The breakdown is still being made. It takes about a minute.';
  } else if (reference.status === 'failed') {
    body = (
      <>
        <Tile icon="alert" tone="error" title="We could not break this video down" text={reference.error} className={styles.state} />
        <div className={styles.actions}>
          <Button arrow={false} onClick={() => setReplacing(true)}>Try another video</Button>
          <Button variant="ghost" arrow={false} onClick={onNext}>Continue without it</Button>
        </div>
        <p className={steps.hint}>Without a breakdown, the script is written from your brief.</p>
      </>
    );
  } else {
    canContinue = true;
    body = (
      <>
        <Summary reference={reference} />
        <ol className={styles.beats} aria-label="Beats">
          {reference.beats.map((b) => <Beat key={b.ord} beat={b} />)}
        </ol>
        <div className={styles.actions}>
          <Button variant="ghost" arrow={false} onClick={() => setReplacing(true)}>Use a different video</Button>
        </div>
      </>
    );
    hint = 'Your script keeps the same order and pacing, with new lines, characters and setting.';
  }

  return (
    <div className={steps.step}>
      <Head />
      {body}
      {(canContinue || pending) && (
        <StepFooter>
          <Button onClick={onNext} disabled={!canContinue}>Continue to the script</Button>
          {hint && <span className={steps.hint}>{hint}</span>}
        </StepFooter>
      )}
    </div>
  );
}
