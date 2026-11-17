import { useMemo, useState } from 'react';

import Button from '../ui/Button';
import Modal from '../ui/Modal';
import { pickCast, regenCast, retryCast, startGeneration } from '../../lib/story/client';
import useRebuild, { RebuildDialog } from './useRebuild';
import ErrorNotice from '../maker/ErrorNotice';
import ShotCard from '../maker/ShotCard';
import StepAudio from '../maker/StepAudio';
import { Icon, Skeleton, Tile } from '../maker/Tiles';
import { allStillsReady, isGenerated } from '../maker/steps';
import { needsRedraw, planReason, scenesOf, startableIds } from './derive';
import { Announce, Dock, NeedCredits, ScreenHead, priceText, withPrice } from './parts';
import { stageText } from './usePlanPipeline';
import useStartQuote from './useStartQuote';
import ShotWarnings from '../maker/ShotWarnings';
import styles from './Simple.module.css';

const castPicture = (c) => (c.image_url || c.candidates?.[c.chosen_index ?? 0]?.url || c.candidates?.[0]?.url || null);

/** A character: the options, and a note to change it. The existing cast calls, with the price on every button. */
function CastDialog({ open, cast, projectId, onClose, refresh, returnTo }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState(null);
  if (!cast) return null;
  const regen = Number.isInteger(cast.regen_credits) ? cast.regen_credits : 0;
  const retry = Number.isInteger(cast.retry_credits) ? cast.retry_credits : 0;

  async function run(kind, fn) {
    setBusy(kind);
    setError(null);
    try {
      await fn();
      await refresh?.();
    } catch (err) {
      setError(err);
      if (err?.status === 409) await refresh?.();
    } finally {
      setBusy('');
    }
  }
  const failed = cast.status === 'failed' || cast.status === 'blocked';

  return (
    <Modal open={open} onClose={onClose} title={cast.name} footer={<Button variant="ghost" arrow={false} onClick={onClose}>Close</Button>}>
      {cast.description && <p className={styles.hint}>{cast.description}</p>}
      {cast.status === 'pending' && <Skeleton ratio="3 / 2" status="Drawing your character" />}
      {failed && (
        <Tile tone="error" icon={cast.status === 'blocked' ? 'block' : 'alert'} title={cast.status === 'blocked' ? 'These pictures were blocked' : 'These pictures did not come out'} text="Describe a change below, or try again.">
          {cast.status === 'failed' && (
            <>
              <Button variant="ghost" size="sm" arrow={false} disabled={Boolean(busy)} onClick={() => run('retry', () => retryCast(projectId, cast.id, retry))}>
                {withPrice('Try again', retry)}
              </Button>
              <NeedCredits items={[{ price: retry }]} />
            </>
          )}
        </Tile>
      )}
      {(cast.candidates || []).length > 0 && cast.status !== 'pending' && (
        <div className={styles.optionRow}>
          {cast.candidates.map((c, i) => {
            const chosen = cast.chosen_index === i;
            return (
              <button
                key={c.key || c.url || i}
                type="button"
                className={`${styles.optionPic} ${chosen ? styles.optionOn : ''}`}
                aria-pressed={chosen}
                aria-label={chosen ? `${cast.name}, option ${i + 1}, picked` : `Pick ${cast.name}, option ${i + 1}`}
                disabled={Boolean(busy)}
                onClick={() => run('pick', () => pickCast(projectId, cast.id, i))}
              >
                <img src={c.url} alt="" loading="lazy" />
                <span>{chosen ? 'Picked' : 'Pick this one'}</span>
              </button>
            );
          })}
        </div>
      )}
      {cast.status !== 'pending' && (
        <form
          className={styles.field}
          onSubmit={(e) => {
            e.preventDefault();
            if (!note.trim()) return;
            run('regen', async () => { await regenCast(projectId, cast.id, note.trim(), regen); setNote(''); });
          }}
        >
          <label className={styles.field}>
            <span>Describe a change</span>
            <input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="A bit older, with round glasses." />
          </label>
          <Button type="submit" variant="ghost" size="sm" arrow={false} disabled={busy === 'regen' || !note.trim()}>
            {busy === 'regen' ? 'Making new pictures…' : withPrice('Make new pictures', regen)}
          </Button>
          <NeedCredits items={[{ price: regen }]} />
        </form>
      )}
      <ErrorNotice error={error} returnTo={returnTo} onRefresh={refresh} />
    </Modal>
  );
}

function ShotTile({ shot, onOpen }) {
  const waiting = shot.status === 'still_pending';
  const failed = shot.status === 'failed' || shot.status === 'blocked';
  const label = `Shot ${shot.ord + 1}${shot.line ? `: ${shot.line}` : ''}`;
  return (
    <li className={styles.shotItem}>
      <button type="button" className={styles.shotButton} onClick={() => onOpen(shot)} aria-label={`Open ${label}`} data-shot={shot.id} data-status={shot.status}>
        <span className={styles.shotImg}>
          {shot.still_url && !waiting ? <img src={shot.still_url} alt="" loading="lazy" /> : null}
          {waiting && <Skeleton status="Sketching" />}
          {failed && <span className={styles.shotFailed}><Icon name="alert" size={18} /><span>Did not work</span></span>}
          {!shot.still_url && !waiting && !failed && <span className={styles.shotEmpty}><Icon name="image" size={18} /></span>}
          <span className={styles.shotNum}>{shot.ord + 1}</span>
        </span>
        {shot.line && <span className={styles.shotLine}>{shot.line}</span>}
      </button>
    </li>
  );
}

/**
 * Screen 3, Check the plan: the characters, the storyboard pictures, the voice and the music, each one a thing to click.
 * While the pipeline still makes something it shows what; when it is ready the buttons carry the server's price:
 * "Make my video (N credits)" and "Try scene 1 first (N credits)".
 */
export default function CheckPlan({ project, shots, cast, audio, plan, refresh, returnTo }) {
  const [castOpen, setCastOpen] = useState(null);
  const [shotOpen, setShotOpen] = useState(null);
  const [audioOpen, setAudioOpen] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState(null);
  const [note, setNote] = useState('');

  const scenes = useMemo(() => scenesOf(shots), [shots]);
  const ids = useMemo(() => startableIds(shots), [shots]);
  const sceneIds = scenes[0]?.startIds || [];
  const picturesOk = allStillsReady(shots);
  const staleShots = shots.some((s) => s.needs_rebuild);
  const sig = `${project.fee_charged}|${project.seconds}|${project.quality}`;
  const all = useStartQuote(project.id, picturesOk && !staleShots ? ids : [], { key: sig });
  const first = useStartQuote(project.id, picturesOk && !staleShots && scenes.length > 1 ? sceneIds : [], { key: sig });

  const rebuild = useRebuild({ projectId: project.id, refresh });
  const reason = planReason({ project, shots, cast, jobs: [] , audio });
  const [pickBusy, setPickBusy] = useState('');
  const unpicked = cast.filter((c) => c.status === 'ready' && c.chosen_index == null && !c.image_url && (c.candidates || []).length > 0);
  async function pickLook(castId, index) {
    setPickBusy(castId);
    setError(null);
    try {
      await pickCast(project.id, castId, index);
      await refresh?.();
    } catch (err) {
      setError(err);
      if (err?.status === 409) await refresh?.();
    } finally {
      setPickBusy('');
    }
  }

  const action = plan.action;
  const progressText = stageText(action);
  const pipelineBusy = action.type === 'wait' || plan.working;
  const noCast = project.consistent_cast === false;
  const model = audio?.narration;
  // A narrator reads the narrator lines in either mode; a talking script with none has only the characters' voices.
  const narrates = audio?.applicable ? audio.applicable.narration : project.mode !== 'talking';

  async function start(quote, kind) {
    if (!quote || busy) return;
    setBusy(kind);
    setError(null);
    setNote('');
    try {
      await startGeneration(project.id, quote.shotIds || [], quote.total);
      await refresh?.();
    } catch (err) {
      if (err?.status === 409 && err?.code === 'quote_changed') {
        // Nothing started. Show the new price and ask again.
        setNote('The price changed. Check the new price, then press the button again.');
        await all.reload();
        await first.reload();
        await refresh?.();
      } else {
        setError(err);
        if (err?.status === 409) await refresh?.();
      }
    } finally {
      setBusy('');
    }
  }

  const ready = action.type === 'done';
  const canMake = Boolean(all.quote) && !busy && all.quote.shotIds?.length > 0;
  let hint = null;
  if (!ready && !canMake) hint = action.type === 'blocked' ? 'Something needs a look first. Open it above.' : action.type === 'ask' || action.type === 'stale' ? 'Answer the question above first.' : progressText || 'Getting your plan ready…';
  else if (staleShots) hint = 'Update the storyboard first.';
  else if (!all.quote && all.error && all.error.code !== 'needs_rebuild') hint = 'We could not work out the price. Try again in a moment.';
  else if (!all.quote && ids.length === 0 && picturesOk) hint = 'Every shot is already made.';

  return (
    <div className={styles.screen} data-screen="plan">
      <ScreenHead
        title="Check the plan"
        sub="Press a character, a picture, the voice or the music to change it. Or ask the chat helper."
        status={ready ? 'Ready to make' : progressText || 'Getting ready…'}
        done={ready}
      />
      <Announce>{pipelineBusy ? progressText : ''}</Announce>

      {reason && <p className={styles.reason} data-testid="plan-reason" role="status">{reason}</p>}
      {action.type === 'ask' && (
        <div className={styles.askCard} data-testid="plan-ask">
          {action.what === 'cast' ? (
            <>
              <p>{Number.isInteger(action.credits) ? 'Nothing is charged until you press the button.' : plan.quoteError ? 'We could not get the price.' : 'Working out the price…'}</p>
              {!Number.isInteger(action.credits) && plan.quoteError && <Button variant="ghost" arrow={false} onClick={plan.reloadQuote}>Try again</Button>}
              <Button disabled={!Number.isInteger(action.credits)} onClick={plan.confirm}>{Number.isInteger(action.credits) ? withPrice('Carry on designing', action.credits) : 'Carry on designing'}</Button>
              <NeedCredits items={[{ price: action.credits }]} />
            </>
          ) : (
            <>
              <p>{action.what === 'pictures' ? 'The storyboard pictures now cost credits.' : action.what === 'redraw' ? 'Drawing the characters again in the new style now costs credits.' : `The ${action.what} now costs credits.`} Nothing is charged until you press the button.</p>
              <Button onClick={plan.confirm}>{withPrice(action.what === 'pictures' ? 'Make the pictures' : action.what === 'redraw' ? 'Draw the characters again' : `Make the ${action.what}`, action.credits)}</Button>
              <NeedCredits items={[{ price: action.credits }]} />
            </>
          )}
        </div>
      )}
      {action.type === 'stale' && (
        <div className={styles.askCard} data-testid="plan-stale">
          <p>The storyboard needs updating to match your changes. Update it so the pictures match.</p>
          <Button onClick={() => rebuild.run()} disabled={rebuild.busy}>{rebuild.busy ? 'Updating…' : 'Update the storyboard'}</Button>
        </div>
      )}
      {action.type === 'blocked' && (
        <p className={styles.planNote} role="status" data-testid="plan-blocked">Something needs a look: {action.what.join(', ')}. Open it below to fix it or try again.</p>
      )}
      {plan.manual && (
        <div className={styles.askCard} data-testid="plan-manual">
          <p>Some parts of your plan are not made yet. Nothing starts until you press the button.</p>
          <Button onClick={plan.carryOn}>{withPrice('Carry on designing', 0)}</Button>
        </div>
      )}
      {plan.otherTab && <p className={styles.planNote} role="status">Another tab is finishing this plan. This page updates by itself.</p>}
      {plan.stalled && (
        <div className={styles.askCard} role="status" data-testid="plan-stalled">
          <p>This is taking longer than usual. Look again, or open the Detailed editor to see what is happening.</p>
          <Button variant="ghost" arrow={false} onClick={refresh}>Look again</Button>
        </div>
      )}
      {plan.tired && (
        <div className={styles.askCard} role="status" data-testid="plan-tired">
          <p>This part did not get going. Nothing was charged. Try it again, or look again in a moment.</p>
          <Button variant="ghost" arrow={false} onClick={plan.retry}>Try again</Button>
        </div>
      )}
      {plan.note && <p className={styles.planNote} data-testid="plan-note" role="status">{plan.note}</p>}
      <ErrorNotice error={plan.error} returnTo={returnTo} onRefresh={refresh} />
      {plan.error && plan.error.status !== 402 && <div><Button variant="ghost" arrow={false} size="sm" onClick={plan.retry}>Try again</Button></div>}

      <section className={styles.block} aria-labelledby="plan-chars">
        <h3 id="plan-chars" className={styles.blockTitle}>Characters</h3>
        {noCast ? (
          <p className={styles.hint}>Different people in every scene, so there are no characters to pick. Each scene is pictured on its own.</p>
        ) : cast.length === 0 ? (
          <div className={styles.castRow}>{[0, 1].map((i) => <div key={i} className={styles.castCard}><Skeleton ratio="3 / 4" status="Drawing" /></div>)}</div>
        ) : (
          <ul className={styles.castRow}>
            {cast.map((c) => (
              <li key={c.id} className={styles.castCard}>
                <button type="button" className={styles.castButton} onClick={() => setCastOpen(c.id)} aria-label={`${c.name}, change this character`} data-cast={c.id} data-status={c.status}>
                  <span className={styles.castImg}>
                    {c.status === 'pending' ? <Skeleton ratio="3 / 4" status="Drawing" /> : castPicture(c) ? <img src={castPicture(c)} alt="" loading="lazy" /> : <span className={styles.shotEmpty}><Icon name="user" size={20} /></span>}
                  </span>
                  <span className={styles.castName}>{c.name}</span>
                  <span className={styles.castRole}>{c.status === 'failed' || c.status === 'blocked' ? 'Needs a look' : needsRedraw(c) ? 'Needs new pictures' : c.status === 'pending' ? 'Drawing…' : c.description}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {unpicked.map((c) => (
        <div key={c.id} className={styles.askCard} data-testid="pick-look">
          <p><strong>Pick a look for {c.name}</strong></p>
          <div className={styles.optionRow}>
            {c.candidates.map((o, i) => (
              <button key={o.key || o.url || i} type="button" className={styles.optionPic} aria-label={`Pick ${c.name}, option ${i + 1}`} disabled={Boolean(pickBusy)} onClick={() => pickLook(c.id, i)}>
                <img src={o.url} alt="" loading="lazy" />
                <span>Pick this one</span>
              </button>
            ))}
          </div>
        </div>
      ))}

      <section className={styles.block} aria-labelledby="plan-sound">
        <h3 id="plan-sound" className={styles.blockTitle}>Voice and music</h3>
        <div className={styles.soundRow}>
          <button type="button" className={styles.pill} onClick={() => setAudioOpen(true)} data-pill="voice">
            <Icon name="mic" size={15} />
            <span><strong>{narrates ? 'Narrator' : 'Voices'}</strong> {!narrates ? 'The people speak' : model?.status === 'ready' ? 'Ready' : model?.status === 'pending' ? 'Recording…' : model?.status === 'failed' ? 'Needs a look' : 'Included'}</span>
          </button>
          <button type="button" className={styles.pill} onClick={() => setAudioOpen(true)} data-pill="music">
            <Icon name="music" size={15} />
            <span><strong>Music</strong> {audio?.music?.type === 'none' ? 'Off' : audio?.music?.status === 'ready' ? 'Ready' : audio?.music?.status === 'pending' ? 'Composing…' : audio?.music?.status === 'failed' ? 'Needs a look' : 'Included'}</span>
          </button>
        </div>
      </section>

      <section className={styles.block} aria-labelledby="plan-shots">
        <h3 id="plan-shots" className={styles.blockTitle}>Storyboard</h3>
        {shots.length === 0 ? (
          <div className={styles.shotGrid}>{[0, 1, 2, 3].map((i) => <div key={i} className={styles.shotImg}><Skeleton status={i === 0 ? 'Planning your shots' : ''} /></div>)}</div>
        ) : (
          <ol className={styles.shotGrid} aria-label="Shots">
            {shots.filter(isGenerated).map((s) => <ShotTile key={s.id} shot={s} onOpen={(x) => setShotOpen(x.id)} />)}
          </ol>
        )}
        <ShotWarnings shots={shots.filter(isGenerated)} />
      </section>

      {all.quote && (all.quote.lines || []).length > 1 && (
        <ul className={styles.planLines} aria-label="What making the video costs">
          {all.quote.lines.map((l, i) => <li key={`${l.label}-${i}`}><span>{l.label}</span><span>{priceText(l.credits)}</span></li>)}
        </ul>
      )}
      {note && <p className={styles.planNote} data-testid="plan-note" role="status">{note}</p>}
      <ErrorNotice error={error} returnTo={returnTo} onRefresh={refresh} />

      <Dock
        label="Making the video"
        total={all.quote ? all.quote.total : undefined}
        meta={all.quote ? `${scenes.length} ${scenes.length === 1 ? 'scene' : 'scenes'}, ${shots.filter(isGenerated).length} shots` : undefined}
        hint={hint}
        needs={all.quote ? <NeedCredits items={[{ price: all.quote.total, label: 'Make my video' }, ...(first.quote && scenes.length > 1 ? [{ price: first.quote.total, label: 'Try scene 1 first' }] : [])]} /> : null}
      >
        {first.quote && scenes.length > 1 && (
          <Button variant="ghost" arrow={false} disabled={Boolean(busy)} onClick={() => start(first.quote, 'first')}>
            {busy === 'first' ? 'Starting…' : withPrice('Try scene 1 first', first.quote.total)}
          </Button>
        )}
        <Button disabled={!canMake} onClick={() => start(all.quote, 'all')}>
          {busy === 'all' ? 'Starting…' : all.quote ? withPrice('Make my video', all.quote.total) : 'Make my video'}
        </Button>
      </Dock>

      <ErrorNotice error={rebuild.error} returnTo={returnTo} onRefresh={refresh} />
      <RebuildDialog rebuild={rebuild} />
      <CastDialog open={Boolean(castOpen)} cast={cast.find((c) => c.id === castOpen)} projectId={project.id} onClose={() => setCastOpen(null)} refresh={refresh} returnTo={returnTo} />
      <Modal open={Boolean(shotOpen)} onClose={() => setShotOpen(null)} title={shotOpen ? `Shot ${(shots.find((s) => s.id === shotOpen)?.ord ?? 0) + 1}` : ''} footer={<Button variant="ghost" arrow={false} onClick={() => setShotOpen(null)}>Close</Button>}>
        {shotOpen && shots.find((s) => s.id === shotOpen) && (
          <ShotCard shot={shots.find((s) => s.id === shotOpen)} project={project} onChanged={refresh} returnTo={returnTo} />
        )}
      </Modal>
      <Modal open={audioOpen} onClose={() => setAudioOpen(false)} title="Voice and music" footer={<Button variant="ghost" arrow={false} onClick={() => setAudioOpen(false)}>Close</Button>}>
        {audioOpen && <StepAudio project={project} refresh={refresh} onNext={() => setAudioOpen(false)} doneLabel="Done" returnTo={returnTo} />}
      </Modal>
    </div>
  );
}

