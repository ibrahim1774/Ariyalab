import { useState } from 'react';

import Button from '../ui/Button';
import Card from '../ui/Card';
import { DEFAULTS } from '../../lib/pricingConstants';
import { pickCast, regenCast, startCast } from '../../lib/story/client';
import ErrorNotice from './ErrorNotice';
import FilesNote from './FilesNote';
import { AssetPickerSlot } from './slots';
import styles from './Steps.module.css';

const CANDIDATE_SLOTS = 3;

/** Why a character's pictures were blocked: the server's own message from its latest blocked job. */
function blockedReason(cast, jobs) {
  const job = [...jobs].reverse().find((j) => j.kind === 'cast_image' && j.status === 'blocked' && j.payload?.castId === cast.id);
  return job?.error || 'These pictures could not be made. Describe a change and try again.';
}

function CastCard({ projectId, cast, jobs, refresh, returnTo }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState(null);
  const left = Math.max(0, DEFAULTS.included.castRegenPerCharacter - (cast.regens_used || 0));

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

  const regenerate = (e) => {
    e?.preventDefault();
    return run('regen', async () => {
      await regenCast(projectId, cast.id, note.trim());
      setNote('');
    });
  };
  const pending = cast.status === 'pending';
  const candidates = cast.candidates || [];

  return (
    <Card className={styles.castCard} data-cast={cast.id} data-status={cast.status}>
      <div className={styles.castHead}>
        <h3>{cast.name}</h3>
        {cast.description && <p>{cast.description}</p>}
      </div>

      {pending && (
        <div className={styles.candidates} aria-busy="true">
          {Array.from({ length: CANDIDATE_SLOTS }).map((_, i) => (
            <div key={i} className={`${styles.candidate} ${styles.shimmer}`} data-testid="candidate-pending" aria-label={`Option ${i + 1} is being made`} />
          ))}
          <p className={styles.srOnly} role="status" aria-live="polite">Making pictures for {cast.name}</p>
        </div>
      )}

      {cast.status === 'blocked' && (
        <p className={styles.blocked} role="alert">{blockedReason(cast, jobs)}</p>
      )}

      {cast.status === 'failed' && (
        <div className={styles.failed} role="alert">
          <span>These pictures did not come out. Try again.</span>
          <Button variant="ghost" size="sm" onClick={regenerate} disabled={busy === 'regen'}>Try again</Button>
        </div>
      )}

      {candidates.length > 0 && cast.status !== 'pending' && (
        <div className={styles.candidates}>
          {candidates.map((c, i) => {
            const chosen = cast.chosen_index === i;
            return (
              <div key={c.key || c.url || i} className={`${styles.candidate} ${chosen ? styles.candidateChosen : ''}`}>
                <img src={c.url} alt={`${cast.name}, option ${i + 1}`} loading="lazy" />
                <button
                  type="button"
                  className={styles.pickButton}
                  aria-pressed={chosen}
                  aria-label={chosen ? `${cast.name}, option ${i + 1}, picked` : `Pick ${cast.name}, option ${i + 1}`}
                  disabled={Boolean(busy)}
                  onClick={() => run('pick', () => pickCast(projectId, cast.id, i))}
                >
                  {chosen ? 'Picked' : 'Pick this one'}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {cast.status !== 'pending' && (
        <form onSubmit={regenerate} className={styles.regen}>
          <label className={styles.field}>
            <span>Describe a change</span>
            <input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="A bit older, with round glasses." />
          </label>
          <div className={styles.actions}>
            <Button type="submit" variant="ghost" size="sm" disabled={busy === 'regen' || !note.trim()}>
              {busy === 'regen' ? 'Making new pictures…' : 'Regenerate'}
            </Button>
            <AssetPickerSlot label="Use my own image" />
          </div>
          <p className={styles.hint}>
            {left} regeneration{left === 1 ? '' : 's'} included for {cast.name}, then {DEFAULTS.castRegen} credits each.
          </p>
        </form>
      )}
      <ErrorNotice error={error} returnTo={returnTo} onRefresh={refresh} />
    </Card>
  );
}

export default function StepCast({ project, cast = [], jobs = [], refresh, onNext, returnTo }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      await startCast(project.id);
      await refresh?.();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const allPicked = cast.length > 0 && cast.every((c) => c.chosen_index != null || c.image_url);

  return (
    <div className={styles.step}>
      <div className={styles.stepHead}>
        <h2>Meet your <span className="accent-word">cast</span></h2>
        <p>Each character gets three options. Pick one, or describe a change and make new ones.</p>
      </div>

      {cast.length === 0 && (
        <Card>
          <div className={styles.form}>
            <p>
              Ready to make your characters?
              {!project.fee_charged && ` The project setup fee of ${DEFAULTS.projectFee} credits is taken when the cast is first made.`}
            </p>
            <ErrorNotice error={error} returnTo={returnTo} onRefresh={refresh} />
            <div className={styles.actions}>
              <Button onClick={start} disabled={busy}>{busy ? 'Starting…' : 'Make my cast'}</Button>
            </div>
          </div>
        </Card>
      )}

      <div className={styles.castList}>
        {cast.map((c) => (
          <CastCard key={c.id} projectId={project.id} cast={c} jobs={jobs} refresh={refresh} returnTo={returnTo} />
        ))}
      </div>

      <FilesNote project={project} />
      {cast.length > 0 && (
        <div className={styles.actions}>
          <Button onClick={onNext} disabled={!allPicked}>Continue to the storyboard</Button>
          {!allPicked && <span className={styles.hint}>Pick one option for every character to continue.</span>}
        </div>
      )}
    </div>
  );
}
