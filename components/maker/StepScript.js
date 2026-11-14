import { useCallback, useEffect, useRef, useState } from 'react';

import Button from '../ui/Button';
import Card from '../ui/Card';
import { getScript, reviseScript, updateScene, writeScript } from '../../lib/story/client';
import ErrorNotice from './ErrorNotice';
import StepFooter from './StepFooter';
import { EmptyState } from './Tiles';
import styles from './Steps.module.css';

const SAVE_DELAY_MS = 800;
const draftOf = (scene) => ({
  title: scene.title || '',
  visual: scene.visual || '',
  lines: (scene.lines || []).map((l) => ({ speaker: l.speaker, text: l.text })),
});
const sameDraft = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function Warnings({ items }) {
  if (!items?.length) return null;
  return (
    <ul className={styles.warnings} aria-label="Notes about this part of the script">
      {items.map((v, i) => (
        <li key={`${v.rule}-${i}`} data-rule={v.rule}>{v.message}</li>
      ))}
    </ul>
  );
}

/** One scene: its own draft, a debounced save on typing and an immediate one on blur. */
function SceneEditor({ scene, index, warnings, state, error, onSave, returnTo }) {
  const [draft, setDraft] = useState(() => draftOf(scene));
  const dirty = useRef(false);
  const timer = useRef(null);
  const latest = useRef(draft);
  latest.current = draft;

  // Take the server's version unless the customer is in the middle of typing.
  useEffect(() => {
    if (!dirty.current) setDraft(draftOf(scene));
  }, [scene]);

  const flush = useCallback(() => {
    clearTimeout(timer.current);
    if (!dirty.current) return;
    dirty.current = false;
    onSave(scene.id, latest.current);
  }, [onSave, scene.id]);

  useEffect(() => () => clearTimeout(timer.current), []);

  const change = (next) => {
    dirty.current = !sameDraft(next, draftOf(scene));
    setDraft(next);
    clearTimeout(timer.current);
    if (dirty.current) timer.current = setTimeout(flush, SAVE_DELAY_MS);
  };

  const label = `Scene ${index + 1}`;
  return (
    <Card className={styles.scene} data-scene={scene.id} data-save-state={state || 'idle'}>
      <div className={styles.sceneHead}>
        <span className={styles.sceneNumber}>{label}</span>
        <input
          className={styles.sceneTitle}
          aria-label={`${label} title`}
          value={draft.title}
          onChange={(e) => change({ ...draft, title: e.target.value })}
          onBlur={flush}
        />
        <span className={styles.saveBadge} role="status" aria-live="polite">
          {state === 'saving' ? 'Saving…' : state === 'saved' ? 'Saved' : ''}
        </span>
      </div>
      <label className={styles.field}>
        <span>What we see</span>
        <textarea rows={2} aria-label={`${label} visual`} value={draft.visual} onChange={(e) => change({ ...draft, visual: e.target.value })} onBlur={flush} />
      </label>
      <div className={styles.lines}>
        {draft.lines.map((line, i) => (
          <label key={i} className={styles.line}>
            <span className={styles.speaker}>{line.speaker === 'narrator' ? 'Narrator' : line.speaker}</span>
            <textarea
              rows={2}
              aria-label={`${label} line ${i + 1}, ${line.speaker}`}
              value={line.text}
              onChange={(e) => change({ ...draft, lines: draft.lines.map((l, j) => (j === i ? { ...l, text: e.target.value } : l)) })}
              onBlur={flush}
            />
          </label>
        ))}
      </div>
      <Warnings items={warnings} />
      <ErrorNotice error={error} returnTo={returnTo} />
    </Card>
  );
}

export default function StepScript({ project, onNext, refresh, returnTo }) {
  const projectId = project.id;
  const [script, setScript] = useState(undefined); // undefined = loading, null = none yet
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');
  const [saveState, setSaveState] = useState({});
  const [sceneErrors, setSceneErrors] = useState({});

  useEffect(() => {
    let alive = true;
    getScript(projectId)
      .then((s) => alive && setScript(s))
      .catch((err) => {
        if (!alive) return;
        setScript(null);
        setError(err);
      });
    return () => {
      alive = false;
    };
  }, [projectId]);

  async function write() {
    setBusy('write');
    setError(null);
    try {
      setScript(await writeScript(projectId));
      refresh?.();
    } catch (err) {
      setError(err);
    } finally {
      setBusy('');
    }
  }

  async function revise(e) {
    e.preventDefault();
    if (!note.trim()) return;
    setBusy('revise');
    setError(null);
    try {
      const res = await reviseScript(projectId, note.trim());
      setScript(res.script);
      setNote('');
      refresh?.();
    } catch (err) {
      setError(err);
    } finally {
      setBusy('');
    }
  }

  const saveScene = useCallback(
    async (sceneId, draft) => {
      setSaveState((s) => ({ ...s, [sceneId]: 'saving' }));
      setSceneErrors((s) => ({ ...s, [sceneId]: null }));
      try {
        const res = await updateScene(projectId, sceneId, { title: draft.title, visual: draft.visual, lines: draft.lines });
        setScript(res.script);
        setSaveState((s) => ({ ...s, [sceneId]: 'saved' }));
        refresh?.();
      } catch (err) {
        setSaveState((s) => ({ ...s, [sceneId]: 'error' }));
        setSceneErrors((s) => ({ ...s, [sceneId]: err }));
      }
    },
    [projectId, refresh],
  );

  const scenes = script?.scenes || [];
  const violations = script?.violations || [];
  const forScene = (id) => violations.filter((v) => v.sceneId === id);
  const general = violations.filter((v) => !v.sceneId);

  return (
    <div className={styles.step}>
      <div className={styles.stepHead}>
        <h2>Your <span className="accent-word">script</span></h2>
        <p>Edit any line or picture description. Notes below a scene are suggestions, not blockers.</p>
      </div>

      {script === undefined && <p className={styles.muted} role="status">Loading your script…</p>}

      {script === null && (
        <EmptyState icon="text" title="Your script will appear here" text="We write it from what you told us. You can edit every line after.">
          <ErrorNotice error={error} returnTo={returnTo} onRefresh={refresh} />
          <Button onClick={write} disabled={busy === 'write'}>{busy === 'write' ? 'Writing your script…' : 'Write my script'}</Button>
          <p className={styles.srOnly} role="status" aria-live="polite">{busy === 'write' ? 'Writing your script' : ''}</p>
        </EmptyState>
      )}

      {script && (
        <>
          {general.length > 0 && (
            <div className={styles.generalNotes}>
              <strong>About the whole script</strong>
              <Warnings items={general} />
            </div>
          )}
          <div className={styles.sceneList}>
            {scenes.map((scene, i) => (
              <SceneEditor
                key={scene.id}
                scene={scene}
                index={i}
                warnings={forScene(scene.id)}
                state={saveState[scene.id]}
                error={sceneErrors[scene.id]}
                onSave={saveScene}
                returnTo={returnTo}
              />
            ))}
          </div>
          <Card>
            <form onSubmit={revise} className={styles.form}>
              <label className={styles.field}>
                <span>Revise with a note</span>
                <textarea rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Make the opening funnier." />
              </label>
              <ErrorNotice error={error} returnTo={returnTo} onRefresh={refresh} />
              <div className={styles.actions}>
                <Button type="submit" variant="ghost" disabled={busy === 'revise' || !note.trim()}>
                  {busy === 'revise' ? 'Revising…' : 'Revise script'}
                </Button>
              </div>
              <p className={styles.srOnly} role="status" aria-live="polite">{busy === 'revise' ? 'Revising your script' : ''}</p>
            </form>
          </Card>
          <StepFooter>
            <Button onClick={onNext}>Continue to the cast</Button>
          </StepFooter>
        </>
      )}
    </div>
  );
}
