import { useState } from 'react';

import Button from '../ui/Button';
import Card from '../ui/Card';
import { buildShots, makeStills } from '../../lib/story/client';
import ErrorNotice from './ErrorNotice';
import FilesNote from './FilesNote';
import ShotCard from './ShotCard';
import { missingStills } from './steps';
import styles from './Steps.module.css';

export default function StepStoryboard({ project, shots = [], refresh, onNext, returnTo }) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState(null);

  async function run(kind, fn) {
    setBusy(kind);
    setError(null);
    try {
      await fn();
      await refresh?.();
    } catch (err) {
      setError(err);
    } finally {
      setBusy('');
    }
  }

  const missing = missingStills(shots);
  const making = shots.some((s) => s.status === 'still_pending');
  const needPictures = shots.filter((s) => (s.source || 'generated') !== 'footage' && !s.still_url && s.status !== 'still_pending');

  return (
    <div className={styles.step}>
      <div className={styles.stepHead}>
        <h2>Your <span className="accent-word">storyboard</span></h2>
        <p>One picture for every shot, in order. This step is cheap, and nothing expensive starts until you confirm.</p>
      </div>

      {shots.length === 0 ? (
        <Card>
          <div className={styles.form}>
            <p>We will split your script into shots and show them here.</p>
            <ErrorNotice error={error} returnTo={returnTo} onRefresh={refresh} />
            <div className={styles.actions}>
              <Button onClick={() => run('shots', () => buildShots(project.id))} disabled={busy === 'shots'}>
                {busy === 'shots' ? 'Building…' : 'Build my storyboard'}
              </Button>
            </div>
          </div>
        </Card>
      ) : (
        <>
          <div className={styles.toolbar}>
            {needPictures.length > 0 && (
              <Button onClick={() => run('stills', () => makeStills(project.id, needPictures.map((s) => s.id)))} disabled={busy === 'stills'}>
                {busy === 'stills' ? 'Starting…' : `Make pictures for ${needPictures.length} shot${needPictures.length === 1 ? '' : 's'}`}
              </Button>
            )}
            <p className={styles.srOnly} role="status" aria-live="polite">{making ? 'Pictures are being made' : ''}</p>
            {making && <span className={styles.hint}>Pictures are being made. This page updates by itself.</span>}
          </div>
          <ErrorNotice error={error} returnTo={returnTo} onRefresh={refresh} />
          <div className={styles.shotGrid}>
            {shots.map((shot) => (
              <ShotCard key={shot.id} shot={shot} project={project} onChanged={refresh} returnTo={returnTo} />
            ))}
          </div>
          <FilesNote project={project} />
          <div className={styles.actions}>
            <Button onClick={onNext} disabled={missing > 0}>Continue to voice and sound</Button>
            {missing > 0 && <span className={styles.hint}>{missing} shot{missing === 1 ? ' needs' : 's need'} a picture first.</span>}
          </div>
        </>
      )}
    </div>
  );
}
