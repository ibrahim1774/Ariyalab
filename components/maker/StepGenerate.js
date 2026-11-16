import { useMemo, useState } from 'react';

import Button from '../ui/Button';
import Card from '../ui/Card';
import FilesNote from './FilesNote';
import StepFooter from './StepFooter';
import GenerateConfirm from './GenerateConfirm';
import ShotCard from './ShotCard';
import { EmptyState } from './Tiles';
import { allStillsReady, isGenerated, missingStills } from './steps';
import styles from './Steps.module.css';

const IN_FLIGHT = new Set(['queued', 'generating']);

/**
 * Shots that can be started now: generated ones that are not already running or finished. The server's clip_credits
 * (null when a shot has nothing to generate) wins when present; a ready clip that went stale counts again.
 */
export const startable = (shots) => shots.filter((s) => isGenerated(s) && s.still_url && !IN_FLIGHT.has(s.status) && s.status !== 'still_pending'
  && (s.clip_credits !== undefined ? s.clip_credits !== null : s.status !== 'ready' || s.stale));

export default function StepGenerate({ project, shots = [], refresh, onNext, goTo, returnTo }) {
  const [confirmIds, setConfirmIds] = useState(null);
  const generated = shots.filter(isGenerated);
  const ready = generated.filter((s) => s.status === 'ready').length;
  const running = generated.filter((s) => IN_FLIGHT.has(s.status)).length;
  const toStart = useMemo(() => startable(shots), [shots]);
  const stillsOk = allStillsReady(shots);
  const missing = missingStills(shots);
  const started = ready > 0 || running > 0;
  const pct = generated.length ? Math.round((ready / generated.length) * 100) : 0;

  return (
    <div className={styles.step}>
      <div className={styles.stepHead}>
        <h2>Make the <span className="accent-word">video</span></h2>
        <p>You will see the exact cost and confirm it before anything starts. You can close this page and come back.</p>
      </div>

      {started && (
        <Card>
          <div className={styles.progressBox}>
            <div className={styles.progress} role="progressbar" aria-label="Video progress" aria-valuemin={0} aria-valuemax={generated.length} aria-valuenow={ready}>
              <span style={{ width: `${pct}%` }} />
            </div>
            <p className={styles.hint} role="status" aria-live="polite" data-testid="generate-progress">
              {ready} of {generated.length} shots ready{running > 0 ? `, ${running} in progress` : ''}
            </p>
          </div>
        </Card>
      )}

      {shots.length === 0 ? (
        <EmptyState icon="film" title="Your shots will appear here" text="Build your storyboard first, then come back to generate.">
          {goTo && <Button variant="ghost" onClick={() => goTo('storyboard')}>Go to the storyboard</Button>}
        </EmptyState>
      ) : (
        <div className={styles.shotGrid}>
          {shots.map((shot) => {
            const failed = shot.status === 'failed' || shot.status === 'blocked';
            return (
              <ShotCard
                key={shot.id}
                shot={shot}
                project={project}
                editable={false}
                onChanged={refresh}
                returnTo={returnTo}
                retry={failed ? <Button variant="ghost" size="sm" arrow={false} onClick={() => setConfirmIds([shot.id])}>Try again</Button> : undefined}
              >
                {!failed && startable([shot]).length > 0 && started && (
                  <Button variant="ghost" size="sm" arrow={false} onClick={() => setConfirmIds([shot.id])}>Generate this shot</Button>
                )}
              </ShotCard>
            );
          })}
        </div>
      )}

      <FilesNote project={project} />
      <StepFooter>
        <Button onClick={() => setConfirmIds(toStart.map((s) => s.id))} disabled={!stillsOk || toStart.length === 0} data-testid="generate-all">
          {started ? 'Generate the rest' : 'Generate video'}
        </Button>
        {!stillsOk && (
          <span className={styles.hint} data-testid="generate-blocked">
            {generated.length === 0 ? 'Build your storyboard first.' : `${missing} shot${missing === 1 ? ' needs' : 's need'} a picture before you can generate.`}
          </span>
        )}
        {generated.length > 0 && ready === generated.length && <Button variant="ghost" onClick={onNext}>Continue to review</Button>}
      </StepFooter>

      {confirmIds && (
        <GenerateConfirm
          open
          project={project}
          shotIds={confirmIds}
          returnTo={returnTo}
          onClose={() => setConfirmIds(null)}
          onStarted={refresh}
        />
      )}
    </div>
  );
}
