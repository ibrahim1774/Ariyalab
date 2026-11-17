import { useCallback, useEffect, useState } from 'react';

import Button from '../ui/Button';
import { getScript, updateScene } from '../../lib/story/client';
import ErrorNotice from '../maker/ErrorNotice';
import { Announce, Dock, ScreenHead, priceText, withPrice } from './parts';
import { stageText } from './usePlanPipeline';
import styles from './Simple.module.css';

const draftOf = (scene) => ({ visual: scene.visual || '', lines: (scene.lines || []).map((l) => ({ speaker: l.speaker, text: l.text })) });
const speakerName = (s) => (s === 'narrator' ? 'Narrator' : s);

/** One scene: its lines as text, and an Edit button that opens the visual and the lines for changing (the existing scene edit call). */
function Scene({ scene, n, notes, onSave, returnTo }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => draftOf(scene));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => { if (!editing) setDraft(draftOf(scene)); }, [scene, editing]);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await onSave(scene.id, draft);
      setEditing(false);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className={styles.sceneRow} data-scene={scene.id}>
      <span className={styles.sceneTag}>Scene {n}</span>
      <div className={styles.sceneBody}>
        {editing ? (
          <div className={styles.sceneEdit}>
            <label className={styles.field}>
              <span>What we see</span>
              <textarea rows={2} aria-label={`Scene ${n} visual`} value={draft.visual} onChange={(e) => setDraft({ ...draft, visual: e.target.value })} />
            </label>
            {draft.lines.map((line, i) => (
              <label key={i} className={styles.field}>
                <span>{speakerName(line.speaker)}</span>
                <textarea
                  rows={2}
                  aria-label={`Scene ${n} line ${i + 1}, ${line.speaker}`}
                  value={line.text}
                  onChange={(e) => setDraft({ ...draft, lines: draft.lines.map((l, j) => (j === i ? { ...l, text: e.target.value } : l)) })}
                />
              </label>
            ))}
            <ErrorNotice error={error} returnTo={returnTo} />
            <span className={styles.rowButtons}>
              <Button size="sm" arrow={false} aria-label={`Save scene ${n}`} disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</Button>
              <Button size="sm" variant="ghost" arrow={false} aria-label={`Cancel editing scene ${n}`} onClick={() => { setEditing(false); setError(null); }}>Cancel</Button>
            </span>
          </div>
        ) : (
          <>
            {(scene.lines || []).length > 0 ? (
              (scene.lines || []).map((l, i) => (
                <p key={i} className={styles.sceneText}>
                  {l.speaker !== 'narrator' && <strong className={styles.speaker}>{l.speaker}: </strong>}
                  <span>{l.text}</span>
                </p>
              ))
            ) : (
              <p className={styles.sceneText}>No words in this scene.</p>
            )}
            {scene.visual && <p className={styles.sceneVisual}>{scene.visual}</p>}
            {notes.length > 0 && (
              <ul className={styles.notes} aria-label={`Notes about scene ${n}`}>
                {notes.map((v, i) => <li key={`${v.rule}-${i}`}>{v.message}</li>)}
              </ul>
            )}
          </>
        )}
      </div>
      {!editing && (
        <button type="button" className={styles.rowAction} aria-label={`Edit scene ${n}`} onClick={() => setEditing(true)}>Edit</button>
      )}
    </li>
  );
}

/**
 * Screen 2, Check the script: the scenes (editable in place), and "Looks good, design my video (N credits)", N from the
 * server's quote (/quote-plan). Pressing it starts the plan pipeline (usePlanPipeline), which the page keeps running.
 */
export default function CheckScript({ project, plan, refresh, returnTo, revisit = null }) {
  const [script, setScript] = useState(undefined);
  const [loadError, setLoadError] = useState(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoadError(null);
    getScript(project.id)
      .then((s) => alive && setScript(s))
      .catch((err) => alive && setLoadError(err));
    return () => { alive = false; };
  }, [project.id, attempt]);

  const save = useCallback(async (sceneId, draft) => {
    const res = await updateScene(project.id, sceneId, { visual: draft.visual, lines: draft.lines });
    setScript(res.script);
    refresh?.();
    plan.reloadQuote?.();
  }, [project.id, refresh, plan]);

  const scenes = script?.scenes || [];
  const violations = script?.violations || [];
  const general = violations.filter((v) => !v.sceneId);
  const q = plan.quote;
  const working = plan.armed || plan.busy;
  const stage = stageText(plan.action);

  return (
    <div className={styles.screen} data-screen="script">
      <ScreenHead
        title="Check the script"
        sub="Read it through. Press Edit on a scene to change it, or ask the chat helper."
        status={script ? `${scenes.length} ${scenes.length === 1 ? 'scene' : 'scenes'}, ${project.seconds === 120 ? '2 min' : `${project.seconds} s`}` : 'Loading…'}
        done={Boolean(script)}
      />

      {loadError && <ErrorNotice error={loadError} returnTo={returnTo} onRefresh={() => setAttempt((n) => n + 1)} onRetry={() => setAttempt((n) => n + 1)} />}
      {script === undefined && !loadError && <p className={styles.muted} role="status">Loading your script…</p>}
      {script === null && <p className={styles.muted}>There is no script yet. Go back to Describe it and write one.</p>}

      {general.length > 0 && (
        <ul className={styles.notes} aria-label="Notes about the whole script">
          {general.map((v, i) => <li key={`${v.rule}-${i}`}>{v.message}</li>)}
        </ul>
      )}
      {scenes.length > 0 && (
        <ol className={styles.sceneList} aria-label="Scenes">
          {scenes.map((scene, i) => (
            <Scene key={scene.id} scene={scene} n={i + 1} notes={violations.filter((v) => v.sceneId === scene.id)} onSave={save} returnTo={returnTo} />
          ))}
        </ol>
      )}

      {q && !revisit && (
        <ul className={styles.planLines} data-testid="plan-lines" aria-label="What designing your video costs">
          {q.lines.filter((l) => l.label).map((l) => (
            <li key={l.key}><span>{l.label}</span><span>{priceText(l.credits)}</span></li>
          ))}
        </ul>
      )}

      {plan.note && <p className={styles.planNote} data-testid="plan-note" role="status">{plan.note}</p>}
      <ErrorNotice error={plan.error || (plan.quoteError && !q ? plan.quoteError : null)} returnTo={returnTo} onRefresh={plan.reloadQuote} />
      <Announce>{working ? stage : ''}</Announce>

      {revisit ? (
        <Dock label="Nothing is charged here" hint="Changes you make to the script update your storyboard.">
          <Button onClick={revisit.onBack}>{revisit.label}</Button>
        </Dock>
      ) : (
      <Dock
        label="Designing your video"
        total={q ? q.total : undefined}
        meta={q ? 'Characters, storyboard, voice and music' : undefined}
        hint={working ? stage || 'Getting started…' : !q && !plan.quoteError ? 'Working out the price…' : null}
      >
        <Button disabled={!q || working || script === undefined || scenes.length === 0} onClick={plan.design}>
          {working ? 'Designing your video…' : q ? withPrice('Looks good, design my video', q.total) : 'Looks good, design my video'}
        </Button>
      </Dock>
      )}
    </div>
  );
}
