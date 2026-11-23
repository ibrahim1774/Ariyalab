import { useState } from 'react';

import Button from '../ui/Button';
import Card from '../ui/Card';
import { drawLikePicture, pickCast, regenCast, retryCast, setCastImage, startCast } from '../../lib/story/client';
import ErrorNotice from './ErrorNotice';
import { NeedCredits } from './NeedCredits';
import StepFooter from './StepFooter';
import FilesNote from './FilesNote';
import { projectFeeFor } from '../../lib/pricingConstants';
import { usePricing } from './PricingContext';
import AssetPicker from './AssetPicker';
import LookLike from './LookLike';
import PictureFix from './PictureFix';
import { EmptyState, Skeleton, StyleNote, Tile } from './Tiles';
import styles from './Steps.module.css';

// A new round draws one picture (the server picks it); a round made before that holds 3 options and keeps its pick buttons.
const CANDIDATE_SLOTS = 1;

/** Why a character's picture was blocked: the server's own message from its latest blocked job. */
function blockedReason(cast, jobs) {
  const job = [...jobs].reverse().find((j) => j.kind === 'cast_image' && j.status === 'blocked' && j.payload?.castId === cast.id);
  return job?.error || 'This picture could not be made. Describe a change and try again.';
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
  // "Make them look like a picture": always paid, from the same server code that charges (look_credits).
  const lookCost = Number.isInteger(cast.look_credits) ? cast.look_credits : pricing.castFromPicture;
  const retryCost = Number.isInteger(cast.retry_credits) ? cast.retry_credits : (cast.regens_used || 0) > pricing.included.castRegenPerCharacter ? pricing.castRegen : 0;

  // rethrow: the caller shows the error (the chooser). report: show it here and also throw, so the caller keeps its state.
  async function run(kind, fn, { rethrow = false, report = false } = {}) {
    setBusy(kind);
    setError(null);
    try {
      await fn();
      await refresh?.();
    } catch (err) {
      if (rethrow && !report) throw err;
      setError(err);
      // A changed price or a state that moved on: show the current one.
      if (err?.status === 409) await refresh?.();
      if (report) throw err;
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
  // The picture the customer chose is drawn from; a changed price (409) is refreshed by run(), and the picture stays for another press.
  const drawLike = (assetId, text) => run('look', async () => {
    if (Number.isInteger(lookCost)) await drawLikePicture(projectId, cast.id, assetId, text, lookCost);
    else await drawLikePicture(projectId, cast.id, assetId, text);
  }, { report: true });
  const retry = () => run('retry', () => (Number.isInteger(cast.retry_credits) ? retryCast(projectId, cast.id, cast.retry_credits) : retryCast(projectId, cast.id)));
  const pending = cast.status === 'pending';
  const candidates = cast.candidates || [];

  return (
    <Card className={styles.castCard} data-cast={cast.id} data-status={cast.status}>
      <div className={styles.castHead}>
        <h3>{cast.name}</h3>
        {cast.description && <p>{cast.description}</p>}
        {cast.style_stale && cast.status === 'ready' && !cast.image_url && !(cast.candidates || []).length && (
          <>
            <p role="note"><small>The art style changed, so {cast.name} needs new pictures.</small></p>
            <Button size="sm" disabled={Boolean(busy)} onClick={() => run('redraw', async () => { await regenCast(projectId, cast.id, '', regenCost); })}>
              {busy === 'redraw' ? 'Drawing…' : regenCost > 0 ? `Draw again in the new style (${regenCost} credits)` : 'Draw again in the new style (included)'}
            </Button>
            <NeedCredits items={[{ price: regenCost }]} />
          </>
        )}
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
            title={cast.status === 'blocked' ? 'This picture was blocked' : 'This picture did not come out'}
            text={cast.status === 'blocked' ? blockedReason(cast, jobs) : 'Try again, or describe a change below.'}
          >
            {cast.status === 'blocked' ? (
              <Button variant="ghost" size="sm" onClick={() => setChange(true)}>Describe a change</Button>
            ) : (
              <>
                <Button variant="ghost" size="sm" onClick={retry} disabled={busy === 'retry'}>
                  {retryCost > 0 ? `Try again (${retryCost} credits)` : 'Try again'}
                </Button>
                <NeedCredits items={[{ price: retryCost }]} />
              </>
            )}
          </Tile>
        </div>
      )}

      {cast.asset_id && cast.image_url && cast.status !== 'pending' && (
        <div className={styles.candidates} data-own-image="">
          <div className={`${styles.candidate} ${styles.candidateChosen}`} data-media-card="">
            <img src={cast.image_url} alt={`${cast.name}, your own picture`} loading="lazy" />
            <span className={styles.pickButton} aria-label={`${cast.name} uses your own picture`}>Your picture</span>
          </div>
        </div>
      )}

      {/* One picture: shown as it is, with nothing to choose. A round made with 3 options (older projects) keeps its pick buttons. */}
      {candidates.length === 1 && !cast.asset_id && cast.status !== 'pending' && (
        <div className={styles.candidates} data-single-picture="">
          <div className={styles.candidate} data-media-card="">
            <img src={candidates[0].url} alt={cast.name} loading="lazy" />
          </div>
        </div>
      )}

      {candidates.length > 1 && cast.status !== 'pending' && (
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

      <PictureFix cast={cast} disabled={Boolean(busy)} hintClass={styles.hint} onPick={(index) => run('pick', () => pickCast(projectId, cast.id, index))} />

      {cast.look_asset_id && cast.image_url && !cast.asset_id && cast.status === 'ready' && (
        <p className={styles.hint} data-testid="look-note">Drawn to look like a picture you chose.</p>
      )}

      {cast.status !== 'pending' && (
        <button type="button" className={styles.changeToggle} aria-expanded={change} onClick={() => setChange((v) => !v)}>
          {change ? 'Hide options' : 'Change this character'}
        </button>
      )}
      {cast.status !== 'pending' && (
        <div className={`${styles.regen} ${change ? styles.regenOpen : ''}`}>
          <form onSubmit={regenerate} className={styles.regenForm}>
            <label className={styles.field}>
              <span>Describe a change</span>
              <input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="A bit older, with round glasses." />
            </label>
            <div className={styles.actions}>
              <Button type="submit" variant="ghost" size="sm" disabled={busy === 'regen'}>
                {busy === 'regen' ? 'Drawing…' : regenCost > 0 ? `Draw again (${regenCost} credits)` : 'Draw again (included)'}
              </Button>
              <NeedCredits items={[{ price: regenCost }]} />
            </div>
            <p className={styles.hint}>
              {left} redraw{left === 1 ? '' : 's'} included for {cast.name}, then {pricing.castRegen} credits each.
            </p>
          </form>
          <LookLike name={cast.name} price={lookCost} disabled={Boolean(busy)} busy={busy === 'look'} returnTo={returnTo} onDraw={drawLike} />
          <div className={styles.actions}>
            <AssetPicker
              kinds={['image', 'mascot', 'product', 'logo']}
              uploadKind="image"
              label="Use my own image"
              title={`Use your own picture for ${cast.name}`}
              selectedId={cast.asset_id}
              disabled={Boolean(busy)}
              returnTo={returnTo}
              onPick={(a) => run('own', () => setCastImage(projectId, cast.id, a.id), { rethrow: true })}
            />
          </div>
        </div>
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

  // The fee the page shows is the fee it asks for: a different price on the server is 409 and nothing is charged.
  // After a 409 the server's own number (quotedFee) is the price on the button, so one refresh ends the disagreement.
  const [quotedFee, setQuotedFee] = useState(null);
  const shownFee = quotedFee !== null ? quotedFee : project.fee_charged ? 0 : projectFeeFor(pricing, project.seconds);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      await startCast(project.id, shownFee);
      await refresh?.();
    } catch (err) {
      if (err?.status === 409 && Number.isInteger(err?.body?.total)) {
        setQuotedFee(err.body.total);
        await refresh?.();
      } else {
        setError(err);
        if (err?.status === 409) await refresh?.();
      }
    } finally {
      setBusy(false);
    }
  }

  // Different people in every scene: there is no cast to make, and the setup fee is taken with the clips.
  const noCast = project.consistent_cast === false;
  const allPicked = cast.length > 0 && cast.every((c) => c.chosen_index != null || c.image_url);

  return (
    <div className={styles.step}>
      <div className={styles.stepHead}>
        <h2>Meet your <span className="accent-word">cast</span></h2>
        <p>We drew each character. Draw again if you want a different one.</p>
      </div>
      <StyleNote project={project} />

      {makingCount > 0 && (
        <p className={styles.srOnly} role="status" aria-live="polite">Drawing {makingCount} character{makingCount === 1 ? '' : 's'}</p>
      )}

      {noCast && (
        <EmptyState icon="user" title="No cast needed" text="This video shows different people in every scene, so there are no characters to pick. Each scene is pictured on its own.">
          <Button onClick={onNext}>Continue to the storyboard</Button>
        </EmptyState>
      )}

      {!noCast && cast.length === 0 && (
        <EmptyState icon="user" title="Your characters will appear here" text={`Each one gets a picture, drawn for you.${project.fee_charged || shownFee === 0 ? '' : ` The project setup fee of ${shownFee} credits is taken when the cast is first made.`}`}>
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
      {!noCast && cast.length > 0 && (
        <StepFooter>
          <Button onClick={onNext} disabled={!allPicked}>Continue to the storyboard</Button>
          {!allPicked && <span className={styles.hint}>Every character needs a picture to continue.</span>}
        </StepFooter>
      )}
    </div>
  );
}
