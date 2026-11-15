import { useState } from 'react';

import Button from '../ui/Button';
import Card from '../ui/Card';
import { pickCast, regenCast, retryCast, startCast } from '../../lib/story/client';
import ErrorNotice from './ErrorNotice';
import StepFooter from './StepFooter';
import FilesNote from './FilesNote';
import { usePricing } from './PricingContext';
import { AssetPickerSlot } from './slots';
import { EmptyState, Skeleton, StyleNote, Tile } from './Tiles';
import styles from './Steps.module.css';

const CANDIDATE_SLOTS = 3;

/** Why a character's pictures were blocked: the server's own message from its latest blocked job. */
function blockedReason(cast, jobs) {
  const job = [...jobs].reverse().find((j) => j.kind === 'cast_image' && j.status === 'blocked' && j.payload?.castId === cast.id);
  return job?.error || 'These pictures could not be made. Describe a change and try again.';
}

function CastCard({ projectId, cast, jobs, refresh, returnTo }) {
  const [note, setNote] = useState('');
  const [change, setChange] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState(null);
  const pricing = usePricing();
  const left = Math.max(0, pricing.included.castRegenPerCharacter - (cast.regens_used || 0));
  // The prices come from the server (the same code that charges). The old derivation only stands in for a row without them.
  const regenCost = Number.isInteger(cast.regen_credits) ? cast.regen_credits : (cast.regens_used || 0) >= pricing.included.castRegenPerCharacter ? pricing.castRegen : 0;
  const retryCost = Number.isInteger(cast.retry_credits) ? cast.retry_credits : (cast.regens_used || 0) > pricing.included.castRegenPerCharacter ? pricing.castRegen : 0;

  async function run(kind, fn) {
    setBusy(kind);
    setError(null);
    try {
      await fn();
      await refresh?.();
    } catch (err) {
      setError(err);
      // A changed price or a state that moved on: show the current one.
      if (err?.status === 409) await refresh?.();
    } finally {
      setBusy('');
    }
  }

  const regenerate = (e) => {
    e?.preventDefault();
    return run('regen', async () => {
      if (Number.isInteger(cast.regen_credits)) await regenCast(projectId, cast.id, note.trim(), cast.regen_credits);
      else await regenCast(projectId, cast.id, note.trim());
      setNote('');
    });
  };
  const retry = () => run('retry', () => (Number.isInteger(cast.retry_credits) ? retryCast(projectId, cast.id, cast.retry_credits) : retryCast(projectId, cast.id)));
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
            <div key={i} className={styles.candidate} data-media-card="">
              <Skeleton ratio="3 / 4" status="Drawing your character" data-testid="candidate-pending" />
            </div>
          ))}
        </div>
      )}

      {(cast.status === 'blocked' || cast.status === 'failed') && (
        <div className={styles.candidates} data-media-card="">
          <Tile
            tone="error"
            icon={cast.status === 'blocked' ? 'block' : 'alert'}
            ratio="3 / 2"
            className={styles.wideTile}
            title={cast.status === 'blocked' ? 'These pictures were blocked' : 'These pictures did not come out'}
            text={cast.status === 'blocked' ? blockedReason(cast, jobs) : 'Try again, or describe a change below.'}
          >
            {cast.status === 'blocked' ? (
              <Button variant="ghost" size="sm" onClick={() => setChange(true)}>Describe a change</Button>
            ) : (
              <Button variant="ghost" size="sm" onClick={retry} disabled={busy === 'retry'}>
                {retryCost > 0 ? `Try again (${retryCost} credits)` : 'Try again'}
              </Button>
            )}
          </Tile>
        </div>
      )}

      {candidates.length > 0 && cast.status !== 'pending' && (
        <div className={styles.candidates}>
          {candidates.map((c, i) => {
            const chosen = cast.chosen_index === i;
            return (
              <div key={c.key || c.url || i} className={`${styles.candidate} ${chosen ? styles.candidateChosen : ''}`} data-media-card="">
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
        <button type="button" className={styles.changeToggle} aria-expanded={change} onClick={() => setChange((v) => !v)}>
          {change ? 'Hide options' : 'Change this character'}
        </button>
      )}
      {cast.status !== 'pending' && (
        <form onSubmit={regenerate} className={`${styles.regen} ${change ? styles.regenOpen : ''}`}>
          <label className={styles.field}>
            <span>Describe a change</span>
            <input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="A bit older, with round glasses." />
          </label>
          <div className={styles.actions}>
            <Button type="submit" variant="ghost" size="sm" disabled={busy === 'regen' || !note.trim()}>
              {busy === 'regen' ? 'Making new pictures…' : regenCost > 0 ? `Regenerate (${regenCost} credits)` : 'Regenerate'}
            </Button>
            <AssetPickerSlot label="Use my own image" />
          </div>
          <p className={styles.hint}>
            {left} regeneration{left === 1 ? '' : 's'} included for {cast.name}, then {pricing.castRegen} credits each.
          </p>
        </form>
      )}
      <ErrorNotice error={error} returnTo={returnTo} onRefresh={refresh} />
    </Card>
  );
}

export default function StepCast({ project, cast = [], jobs = [], refresh, onNext, returnTo }) {
  const pricing = usePricing();
  const makingCount = cast.filter((c) => c.status === 'pending').length;
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
      <StyleNote project={project} />

      {makingCount > 0 && (
        <p className={styles.srOnly} role="status" aria-live="polite">Drawing {makingCount} character{makingCount === 1 ? '' : 's'}</p>
      )}

      {cast.length === 0 && (
        <EmptyState icon="user" title="Your characters will appear here" text={`Each one gets three options to choose from.${project.fee_charged ? '' : ` The project setup fee of ${pricing.projectFee} credits is taken when the cast is first made.`}`}>
          <ErrorNotice error={error} returnTo={returnTo} onRefresh={refresh} onRetry={start} />
          <Button onClick={start} disabled={busy}>{busy ? 'Starting…' : 'Make my cast'}</Button>
        </EmptyState>
      )}

      <div className={styles.castList}>
        {cast.map((c) => (
          <CastCard key={c.id} projectId={project.id} cast={c} jobs={jobs} refresh={refresh} returnTo={returnTo} />
        ))}
      </div>

      <FilesNote project={project} />
      {cast.length > 0 && (
        <StepFooter>
          <Button onClick={onNext} disabled={!allPicked}>Continue to the storyboard</Button>
          {!allPicked && <span className={styles.hint}>Pick one option for every character to continue.</span>}
        </StepFooter>
      )}
    </div>
  );
}
