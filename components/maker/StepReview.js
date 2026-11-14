import { useState } from 'react';

import Button from '../ui/Button';
import { rerollShot } from '../../lib/story/client';
import ErrorNotice from './ErrorNotice';
import { usePricing } from './PricingContext';
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
  const pricing = usePricing();
  const info = rerollInfo(status, shot, pricing);
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
      {shot.status === 'ready' && (
        <>
          <Button variant="ghost" size="sm" arrow={false} onClick={reroll} disabled={busy || inFlight}>
            {busy ? 'Making it again…' : 'Make it again'}
          </Button>
          <span className={styles.hint} data-testid="reroll-info">{info.text}</span>
        </>
      )}
      <ErrorNotice error={error} returnTo={returnTo} onRefresh={refresh} />
    </div>
  );
}

/** `status` is the whole /status payload (needed for the allowance of tries). */
export default function StepReview({ project, shots = [], status, refresh, onNext, goTo, returnTo }) {
  const [retryIds, setRetryIds] = useState(null);
  const generated = shots.filter(isGenerated);
  return (
    <div className={styles.step}>
      <div className={styles.stepHead}>
        <h2>Review <span className="accent-word">every shot</span></h2>
        <p>Play each clip. Use Make it again on any shot you want to redo.</p>
      </div>
      {shots.length === 0 ? (
        <EmptyState icon="film" title="Your clips will appear here" text="Once your shots are made you can play each one and make it again if you want.">
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
