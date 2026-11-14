import { useMemo, useState } from 'react';

import Button from '../ui/Button';
import Card from '../ui/Card';
import FilesNote from './FilesNote';
import GenerateConfirm from './GenerateConfirm';
import ShotCard from './ShotCard';
import { allStillsReady, isGenerated, missingStills } from './steps';
import styles from './Steps.module.css';

const IN_FLIGHT = new Set(['queued', 'generating']);

/** Shots that can be started now: generated ones that are not already running or finished. */
export const startable = (shots) => shots.filter((s) => isGenerated(s) && s.still_url && !IN_FLIGHT.has(s.status) && s.status !== 'ready');

export default function StepGenerate({ project, shots = [], refresh, onNext, returnTo }) {
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

      <Card>
        <div className={styles.form}>
          <div className={styles.actions}>
            <Button onClick={() => setConfirmIds(toStart.map((s) => s.id))} disabled={!stillsOk || toStart.length === 0} data-testid="generate-all">
              {started ? 'Generate the rest' : 'Generate video'}
            </Button>
            {!stillsOk && (
              <span className={styles.hint} data-testid="generate-blocked">
                {generated.length === 0 ? 'Build your storyboard first.' : `${missing} shot${missing === 1 ? ' needs' : 's need'} a picture before you can generate.`}
              </span>
            )}
          </div>
          {started && (
            <div>
              <div className={styles.progress} role="progressbar" aria-label="Video progress" aria-valuemin={0} aria-valuemax={generated.length} aria-valuenow={ready}>
                <span style={{ width: `${pct}%` }} />
              </div>
              <p className={styles.hint} role="status" aria-live="polite" data-testid="generate-progress">
                {ready} of {generated.length} shots ready{running > 0 ? `, ${running} in progress` : ''}
              </p>
            </div>
          )}
        </div>
      </Card>

      <div className={styles.shotGrid}>
        {shots.map((shot) => (
          <ShotCard key={shot.id} shot={shot} project={project} editable={false} onChanged={refresh} returnTo={returnTo}>
            {startable([shot]).length > 0 && (shot.status === 'failed' || shot.status === 'blocked' || started) && (
              <Button variant="ghost" size="sm" arrow={false} onClick={() => setConfirmIds([shot.id])}>
                {shot.status === 'failed' || shot.status === 'blocked' ? 'Try again' : 'Generate this shot'}
              </Button>
            )}
          </ShotCard>
        ))}
      </div>

      <FilesNote project={project} />
      {generated.length > 0 && ready === generated.length && (
        <div className={styles.actions}>
          <Button onClick={onNext}>Continue to review</Button>
        </div>
      )}

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
