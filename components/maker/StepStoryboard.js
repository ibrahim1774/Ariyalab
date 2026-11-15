import { useState } from 'react';

import Button from '../ui/Button';
import Modal from '../ui/Modal';
import { buildShots, makeStills } from '../../lib/story/client';
import ErrorNotice from './ErrorNotice';
import StepFooter from './StepFooter';
import FilesNote from './FilesNote';
import ShotCard from './ShotCard';
import { EmptyState, StyleNote } from './Tiles';
import { missingStills } from './steps';
import styles from './Steps.module.css';

export default function StepStoryboard({ project, shots = [], refresh, onNext, returnTo }) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState(null);
  // Finished clips a rebuild would replace (the server asked to confirm), or null.
  const [clipsToReplace, setClipsToReplace] = useState(null);

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

  // Builds or rebuilds the shot list. A rebuild that would replace finished clips asks first: the server keeps the
  // plan it showed and hands back a token, and "Rebuild anyway" sends that token so exactly that plan is applied.
  // If anything changed meanwhile the server asks again with a new token.
  const rebuild = (confirm) => run('shots', async () => {
    try {
      await (confirm ? buildShots(project.id, { confirm }) : buildShots(project.id));
    } catch (err) {
      if (err?.code !== 'rebuild_loses_clips') throw err;
      setClipsToReplace({ count: Number(err.body?.count) || 0, token: err.body?.token || null });
    }
  });
  const confirmRebuild = () => {
    const token = clipsToReplace?.token;
    setClipsToReplace(null);
    rebuild(token);
  };

  const missing = missingStills(shots);
  // Only when a rebuild would do something: a scene changed (needs_rebuild), or a shot is stale for its scene
  // alone (a rebuild clears that). A clip that no longer matches its own shot needs a new clip, not a rebuild.
  const anyStale = shots.some((s) => s.needs_rebuild || (s.stale && !s.clip_mismatch));
  // Removing scenes keeps the other shots as they are, so the total can drift from the length picked.
  const totalSeconds = shots.reduce((n, s) => n + (Number(s.seconds) || 0), 0);
  const target = Number(project.seconds) || 0;
  const offLength = shots.length > 0 && target > 0 && (totalSeconds < Math.ceil(target * 0.9) || totalSeconds > Math.floor(target * 1.1));
  const making = shots.some((s) => s.status === 'still_pending');
  // Blocked shots need a new description first, so the batch leaves them out.
  const needPictures = shots.filter((s) => (s.source || 'generated') !== 'footage' && !s.still_url && s.status !== 'still_pending' && s.status !== 'blocked');
  // Pictures are free the first time; a shot that already had one (or replaces one) costs a re-roll. The server says which.
  const picturesCost = needPictures.reduce((n, s) => n + (Number(s.still_credits) || 0), 0);

  return (
    <div className={styles.step}>
      <div className={styles.stepHead}>
        <h2>Your <span className="accent-word">storyboard</span></h2>
        <p>One picture for every shot, in order. This step is cheap, and nothing expensive starts until you confirm.</p>
      </div>
      <StyleNote project={project} />

      {shots.length === 0 ? (
        <EmptyState icon="film" title="Your shots will appear here once the cast is picked" text="We split your script into shots and show each one as a picture.">
          <ErrorNotice error={error} returnTo={returnTo} onRefresh={refresh} />
          <Button onClick={() => rebuild()} disabled={busy === 'shots'}>
            {busy === 'shots' ? 'Building…' : 'Build my storyboard'}
          </Button>
        </EmptyState>
      ) : (
        <>
          <div className={styles.toolbar}>
            {needPictures.length > 0 && (
              <Button onClick={() => run('stills', () => makeStills(project.id, needPictures.map((s) => s.id)))} disabled={busy === 'stills'}>
                {busy === 'stills' ? 'Starting…' : `Make pictures for ${needPictures.length} shot${needPictures.length === 1 ? '' : 's'}${picturesCost > 0 ? `, ${picturesCost} credits` : ''}`}
              </Button>
            )}
            {anyStale && (
              <Button variant="ghost" onClick={() => rebuild()} disabled={busy === 'shots'}>{busy === 'shots' ? 'Rebuilding…' : 'Rebuild storyboard'}</Button>
            )}
            <p className={styles.srOnly} role="status" aria-live="polite">{making ? 'Pictures are being made' : ''}</p>
            {making && <span className={styles.hint}>Pictures are being made. This page updates by itself.</span>}
          </div>
          {offLength && (
            <p className={styles.hint} data-testid="length-note">
              Your video is now {totalSeconds} s, {totalSeconds < target ? 'shorter' : 'longer'} than the {target} s you picked
            </p>
          )}
          <ErrorNotice error={error} returnTo={returnTo} onRefresh={refresh} />
          <div className={styles.shotGrid}>
            {shots.map((shot) => (
              <ShotCard key={shot.id} shot={shot} project={project} onChanged={refresh} returnTo={returnTo} />
            ))}
          </div>
          <FilesNote project={project} />
          <StepFooter>
            <Button onClick={onNext} disabled={missing > 0}>Continue to voice and sound</Button>
            {missing > 0 && <span className={styles.hint}>{missing} shot{missing === 1 ? ' needs' : 's need'} a picture first.</span>}
          </StepFooter>
        </>
      )}
      <Modal
        open={clipsToReplace !== null}
        onClose={() => setClipsToReplace(null)}
        title="Rebuild the storyboard?"
        footer={(
          <>
            <Button variant="ghost" arrow={false} onClick={() => setClipsToReplace(null)}>Cancel</Button>
            <Button arrow={false} onClick={confirmRebuild}>Rebuild anyway</Button>
          </>
        )}
      >
        <p>This rebuild replaces {clipsToReplace?.count} finished {clipsToReplace?.count === 1 ? 'clip' : 'clips'}. Rebuild anyway?</p>
      </Modal>
    </div>
  );
}
