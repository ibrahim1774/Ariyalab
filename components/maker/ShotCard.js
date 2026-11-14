import { useState } from 'react';

import Button from '../ui/Button';
import Card from '../ui/Card';
import Pill from '../ui/Pill';
import { DEFAULTS, QUALITY_LABELS } from '../../lib/pricingConstants';
import { makeStills, updateShot } from '../../lib/story/client';
import ErrorNotice from './ErrorNotice';
import { AssetPickerSlot } from './slots';
import styles from './ShotCard.module.css';

export const STATUS_LABELS = {
  draft: 'Draft',
  still_pending: 'Making the picture',
  still_ready: 'Picture ready',
  queued: 'Waiting to start',
  generating: 'Making the video',
  ready: 'Ready',
  failed: 'Did not work',
  blocked: 'Blocked',
};
const STATUS_TONE = { ready: 'success', still_ready: 'success', generating: 'accent', queued: 'accent', still_pending: 'accent' };
const BUSY = new Set(['queued', 'generating']);

/** Qualities a shot can switch between: a talking project stays on pro talking, a narrated one never uses it. */
export function qualityChoices(project) {
  return project?.mode === 'talking' ? ['pro_talking'] : ['standard', 'pro_narrated'];
}

/**
 * One shot in the storyboard grid: still, line, seconds, quality, status. With `editable` it also has re-roll still,
 * edit description, change quality and the "my footage" slot. `children` is extra content (the review step puts the clip there).
 */
export default function ShotCard({ shot, project, onChanged, returnTo, editable = true, children }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(shot.description || '');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState(null);
  const locked = BUSY.has(shot.status) || Boolean(busy);
  const choices = qualityChoices(project);

  async function run(kind, fn) {
    setBusy(kind);
    setError(null);
    try {
      await fn();
      await onChanged?.();
    } catch (err) {
      setError(err);
    } finally {
      setBusy('');
    }
  }

  const saveText = (e) => {
    e.preventDefault();
    run('edit', async () => {
      await updateShot(project.id, shot.id, { description: text.trim() });
      setEditing(false);
    });
  };

  return (
    <Card className={styles.card} padded={false} data-shot={shot.id} data-status={shot.status}>
      <div className={styles.still}>
        {shot.still_url ? (
          <img src={shot.still_url} alt={`Shot ${shot.ord + 1}: ${shot.description || 'picture'}`} loading="lazy" />
        ) : (
          <div className={`${styles.placeholder} ${shot.status === 'still_pending' ? styles.shimmer : ''}`} role="img" aria-label={`Shot ${shot.ord + 1} has no picture yet`}>
            <span>{shot.status === 'still_pending' ? 'Making the picture' : 'No picture yet'}</span>
          </div>
        )}
        <span className={styles.number}>{shot.ord + 1}</span>
      </div>
      <div className={styles.body}>
        <div className={styles.meta}>
          <Pill tone={STATUS_TONE[shot.status] || 'neutral'} data-testid="shot-status">{STATUS_LABELS[shot.status] || shot.status}</Pill>
          <Pill>{QUALITY_LABELS[shot.quality] || shot.quality}</Pill>
          <span className={styles.seconds}>{shot.seconds} seconds</span>
          {shot.stale && <Pill tone="accent">Needs update</Pill>}
        </div>
        {shot.line && <p className={styles.line}>{shot.line}</p>}

        {editing ? (
          <form onSubmit={saveText} className={styles.edit}>
            <label>
              <span className={styles.srOnly}>Description of shot {shot.ord + 1}</span>
              <textarea rows={3} value={text} maxLength={600} onChange={(e) => setText(e.target.value)} />
            </label>
            <div className={styles.row}>
              <Button type="submit" size="sm" arrow={false} disabled={locked || !text.trim()}>Save</Button>
              <Button variant="ghost" size="sm" arrow={false} onClick={() => { setEditing(false); setText(shot.description || ''); }}>Cancel</Button>
            </div>
          </form>
        ) : (
          shot.description && <p className={styles.description}>{shot.description}</p>
        )}

        {(shot.status === 'failed' || shot.status === 'blocked') && shot.error && (
          <p className={styles.reason} role="alert">{shot.error}</p>
        )}

        {editable && !editing && (
          <div className={styles.actions}>
            <Button variant="ghost" size="sm" arrow={false} disabled={locked}
              onClick={() => run('still', () => makeStills(project.id, [shot.id]))}>
              {busy === 'still' ? 'Making a new picture…' : `Re-roll picture (${DEFAULTS.stillReroll} credits)`}
            </Button>
            <Button variant="ghost" size="sm" arrow={false} disabled={locked} onClick={() => setEditing(true)}>Edit description</Button>
            <label className={styles.quality}>
              <span>Quality</span>
              <select
                value={shot.quality}
                disabled={locked || choices.length < 2}
                onChange={(e) => run('quality', () => updateShot(project.id, shot.id, { quality: e.target.value }))}
              >
                {[...new Set([shot.quality, ...choices])].map((q) => (
                  <option key={q} value={q}>{QUALITY_LABELS[q] || q}</option>
                ))}
              </select>
            </label>
            <AssetPickerSlot label="Use my footage" />
          </div>
        )}
        <ErrorNotice error={error} returnTo={returnTo} onRefresh={onChanged} />
        {children}
      </div>
    </Card>
  );
}
