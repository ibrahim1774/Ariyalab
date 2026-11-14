import { useState } from 'react';

import Button from '../ui/Button';
import { rerollShot } from '../../lib/story/client';
import ErrorNotice from './ErrorNotice';
import StepFooter from './StepFooter';
import FilesNote from './FilesNote';
import GenerateConfirm from './GenerateConfirm';
import ShotCard from './ShotCard';
import { EmptyState } from './Tiles';
import { isGenerated, rerollInfo } from './steps';
import styles from './Steps.module.css';

function ClipActions({ shot, project, status, refresh, returnTo }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const info = rerollInfo(status, shot);
  const inFlight = shot.status === 'queued' || shot.status === 'generating';

  async function reroll() {
    setBusy(true);
    setError(null);
    try {
      await rerollShot(project.id, shot.id);
      await refresh?.();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.clipActions}>
      {shot.status === 'ready' && shot.clip_url && (
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <video className={styles.clip} controls preload="metadata" poster={shot.still_url || undefined} src={shot.clip_url} aria-label={`Clip for shot ${shot.ord + 1}`} />
      )}
      {shot.status === 'ready' && (
        <>
          <Button variant="ghost" size="sm" arrow={false} onClick={reroll} disabled={busy || inFlight}>
            {busy ? 'Re-rolling…' : 'Re-roll this shot'}
          </Button>
          <span className={styles.hint} data-testid="reroll-info">{info.text}</span>
        </>
      )}
      <ErrorNotice error={error} returnTo={returnTo} onRefresh={refresh} />
    </div>
  );
}

/** `status` is the whole /status payload (needed for the re-roll allowance). */
export default function StepReview({ project, shots = [], status, refresh, onNext, goTo, returnTo }) {
  const [retryIds, setRetryIds] = useState(null);
  const generated = shots.filter(isGenerated);
  return (
    <div className={styles.step}>
      <div className={styles.stepHead}>
        <h2>Review <span className="accent-word">every shot</span></h2>
        <p>Play each clip. Re-roll any shot you want to try again.</p>
      </div>
      {shots.length === 0 ? (
        <EmptyState icon="film" title="Your clips will appear here" text="Once your shots are made you can play and re-roll each one.">
          {goTo && <Button variant="ghost" onClick={() => goTo('generate')}>Go to generate</Button>}
        </EmptyState>
      ) : (
        <div className={styles.shotGrid}>
          {shots.map((shot) => (
            <ShotCard
              key={shot.id}
              shot={shot}
              project={project}
              editable={false}
              onChanged={refresh}
              returnTo={returnTo}
              retry={shot.status === 'failed' || shot.status === 'blocked' ? <Button variant="ghost" size="sm" arrow={false} onClick={() => setRetryIds([shot.id])}>Try again</Button> : undefined}
            >
              <ClipActions shot={shot} project={project} status={status} refresh={refresh} returnTo={returnTo} />
            </ShotCard>
          ))}
        </div>
      )}
      <FilesNote project={project} />
      <StepFooter>
        <Button onClick={onNext} disabled={generated.length === 0 || generated.some((s) => s.status !== 'ready')}>Continue to finish</Button>
      </StepFooter>
      {retryIds && (
        <GenerateConfirm open project={project} shotIds={retryIds} returnTo={returnTo} onClose={() => setRetryIds(null)} onStarted={refresh} />
      )}
    </div>
  );
}
