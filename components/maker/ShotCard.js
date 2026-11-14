import { useEffect, useRef, useState } from 'react';

import Button from '../ui/Button';
import Card from '../ui/Card';
import Pill from '../ui/Pill';
import { QUALITY_LABELS } from '../../lib/pricingConstants';
import { makeStills, retryStill, updateShot } from '../../lib/story/client';
import ErrorNotice from './ErrorNotice';
import { usePricing } from './PricingContext';
import useMediaQuery from './useMediaQuery';
import { AssetPickerSlot } from './slots';
import { Skeleton, Tile } from './Tiles';
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
export default function ShotCard({ shot, project, onChanged, returnTo, editable = true, retry, children }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(shot.description || '');
  const [more, setMore] = useState(false);
  const [playing, setPlaying] = useState(false);
  const fieldRef = useRef(null);
  const pricing = usePricing();
  const isPhone = useMediaQuery('(max-width: 760px)');

  // Take a change made elsewhere (the chat, another tab) unless the customer is typing in the field.
  useEffect(() => {
    if (typeof document === 'undefined' || document.activeElement !== fieldRef.current) setText(shot.description || '');
  }, [shot.description]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState(null);
  const locked = BUSY.has(shot.status) || Boolean(busy);
  const choices = qualityChoices(project);
  const failed = shot.status === 'failed' || shot.status === 'blocked';
  const waiting = shot.status === 'still_pending' || BUSY.has(shot.status);
  const retryNode =
    retry ??
    (editable && failed ? (
      <Button variant="ghost" size="sm" arrow={false} disabled={Boolean(busy)} onClick={() => run('still', () => retryStill(project.id, shot.id))}>Try again</Button>
    ) : null);
  const clipReady = !editable && shot.status === 'ready' && shot.clip_url;
  let media;
  if (clipReady) {
    media =
      isPhone && !playing ? (
        <button type="button" className={styles.play} style={shot.still_url ? { backgroundImage: `url(${shot.still_url})` } : undefined} aria-label={`Play clip ${shot.ord + 1}`} onClick={() => setPlaying(true)}>
          <span aria-hidden="true">▶</span>
        </button>
      ) : (
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <video className={styles.video} controls playsInline autoPlay={isPhone} preload="none" poster={shot.still_url || undefined} src={shot.clip_url} aria-label={`Clip for shot ${shot.ord + 1}`} />
      );
  } else if (failed) {
    media = (
      <Tile tone="error" icon={shot.status === 'blocked' ? 'block' : 'alert'} title={shot.status === 'blocked' ? 'This shot was blocked' : 'This shot did not work'} text={shot.error || 'Change the description or try again.'}>
        {retryNode}
      </Tile>
    );
  } else if (waiting) {
    media = (
      <Skeleton
        status={shot.status === 'still_pending' ? 'Sketching this shot' : 'Animating this shot'}
        line={shot.line}
        image={shot.status === 'still_pending' ? null : shot.still_url}
      />
    );
  } else if (shot.still_url) {
    media = <img src={shot.still_url} alt={`Shot ${shot.ord + 1}: ${shot.description || 'picture'}`} loading="lazy" />;
  } else {
    media = <Tile icon="image" title="No picture yet" text="Make pictures to see this shot here." />;
  }

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
    <Card className={`${styles.card} ${isPhone && playing ? styles.playingCard : ''}`} padded={false} data-shot={shot.id} data-status={shot.status} data-media-card="">
      <div className={styles.still}>
        {media}
        <span className={styles.number}>{shot.ord + 1}</span>
      </div>
      <div className={styles.body}>
        <div className={styles.meta}>
          <Pill tone={STATUS_TONE[shot.status] || 'neutral'} data-testid="shot-status">{STATUS_LABELS[shot.status] || shot.status}</Pill>
          <Pill>{QUALITY_LABELS[shot.quality] || shot.quality}</Pill>
          <span className={styles.seconds}>{shot.seconds} seconds</span>
          {shot.stale && <Pill tone="accent">Needs update</Pill>}
        </div>
        {shot.line && !waiting && <p className={styles.line} title={shot.line}>{shot.line}</p>}

        {editing ? (
          <form onSubmit={saveText} className={styles.edit}>
            <label>
              <span className={styles.srOnly}>Description of shot {shot.ord + 1}</span>
              <textarea ref={fieldRef} rows={3} value={text} maxLength={600} onChange={(e) => setText(e.target.value)} />
            </label>
            <div className={styles.row}>
              <Button type="submit" size="sm" arrow={false} disabled={locked || !text.trim()}>Save</Button>
              <Button variant="ghost" size="sm" arrow={false} onClick={() => { setEditing(false); setText(shot.description || ''); }}>Cancel</Button>
            </div>
          </form>
        ) : (
          shot.description && <p className={styles.description} title={shot.description}>{shot.description}</p>
        )}


        {editable && !editing && (
          <button type="button" className={styles.moreToggle} aria-expanded={more} onClick={() => setMore((v) => !v)}>
            {more ? 'Hide options' : 'Change this shot'}
          </button>
        )}
        {editable && !editing && (
          <div className={`${styles.actions} ${more ? styles.actionsOpen : ''}`}>
            <Button variant="ghost" size="sm" arrow={false} className={styles.mini} disabled={locked} title="Make a new picture for this shot"
              onClick={() => run('still', () => makeStills(project.id, [shot.id]))}>
              {busy === 'still' ? 'Making…' : `Make it again, ${pricing.stillReroll} credits`}
            </Button>
            <Button variant="ghost" size="sm" arrow={false} className={styles.mini} disabled={locked} onClick={() => setEditing(true)}>Edit description</Button>
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
        <div className={styles.extra}>
          <ErrorNotice error={error} returnTo={returnTo} onRefresh={onChanged} />
          {children}
        </div>
      </div>
    </Card>
  );
}
