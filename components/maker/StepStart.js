import { useState } from 'react';

import Button from '../ui/Button';
import Card from '../ui/Card';
import ErrorNotice from './ErrorNotice';
import { useMakerNav } from './MakerNav';
import StepReference from './StepReference';
import { Tile } from './Tiles';
import styles from './Steps.module.css';

export function titleFromIdea(idea) {
  const firstLine = String(idea || '').trim().split(/\n/)[0].trim();
  const cut = firstLine.length > 60 ? `${firstLine.slice(0, 57).trimEnd()}...` : firstLine;
  return cut || 'Untitled video';
}

/**
 * Step 1. Without a project (/app/new) it takes the idea and calls onCreate({ title, offer }); the project
 * is only created when the customer submits. With a project it renames it.
 * The second door, "Start from a video" (StepReference): on /app/new, onCreateForVideo() makes the project once
 * the video checks out and onOpenProject(id) opens it; on a project without a reference it starts the analysis
 * for that project and refreshes it.
 */
export default function StepStart({ project, onCreate, onCreateForVideo, onOpenProject, save, onNext, refresh, returnTo }) {
  const { goTo } = useMakerNav();
  const [idea, setIdea] = useState('');
  const [title, setTitle] = useState(project?.title || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (project) {
        const next = title.trim();
        if (next && next !== project.title) await save({ title: next });
        onNext?.();
      } else {
        const text = idea.trim().slice(0, 1000);
        await onCreate({ title: titleFromIdea(text), ...(text ? { offer: text } : {}) });
      }
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.step}>
      <div className={styles.stepHead}>
        <h2>Start with <span className="accent-word">an idea</span></h2>
        <p>Describe the video in a sentence or two. You can change everything later.</p>
      </div>
      <Card>
        <form onSubmit={submit} className={styles.form}>
          {project ? (
            <label className={styles.field}>
              <span>Name of this video</span>
              <input value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
            </label>
          ) : (
            <label className={styles.field}>
              <span>Describe it</span>
              <textarea
                rows={5}
                maxLength={1000}
                value={idea}
                onChange={(e) => setIdea(e.target.value)}
                placeholder="A small bakery owner finds out her sourdough starter can talk."
              />
            </label>
          )}
          <ErrorNotice error={error} returnTo={returnTo} />
          <div className={styles.actions}>
            <Button type="submit" disabled={busy || (!project && !idea.trim())}>
              {busy ? 'Starting…' : project ? 'Continue' : 'Start my video'}
            </Button>
          </div>
        </form>
      </Card>
      {project?.reference_id ? (
        <Tile icon="film" title="Started from a video" text="Its breakdown waits for you after the length step." className={styles.referenceNote}>
          {goTo && <button type="button" className={styles.errorAction} onClick={() => goTo('breakdown')}>See the breakdown</button>}
        </Tile>
      ) : (
        <StepReference
          ensureProject={project ? async () => project.id : onCreateForVideo}
          onStarted={project ? async () => { await refresh?.(); } : async (id) => { await onOpenProject?.(id); }}
          returnTo={returnTo}
        />
      )}
    </div>
  );
}
