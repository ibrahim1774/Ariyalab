import { useEffect, useRef, useState } from 'react';

import Button from '../ui/Button';
import Card from '../ui/Card';
import Pill from '../ui/Pill';
import { QUALITY_LABELS } from '../../lib/pricingConstants';
import { makeStills, retryStill, updateShot } from '../../lib/story/client';
import ErrorNotice from './ErrorNotice';
import { usePricing } from './PricingContext';
import useMediaQuery from './useMediaQuery';
import AssetPicker, { AssetThumb } from './AssetPicker';
import { Skeleton, Tile } from './Tiles';
import { INSET_RANGE } from '../../lib/story/assetRules';
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

/** A stored picture-in-picture (fractions of the frame) as the customer sees it (whole percent). */
function toPercent(inset) {
  const pick = (v, d) => (Number.isFinite(Number(v)) && v > 0 && v < 1 ? Math.round(v * 100) : d);
  return { x: pick(inset?.x, 50), y: pick(inset?.y, 30), w: pick(inset?.w, 45) };
}

/** Qualities a shot can switch between: every level makes sound, so the mode (who speaks) does not limit it. */
export function qualityChoices() {
  return ['economy', 'standard', 'pro_narrated', 'pro_talking'];
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
  const isFootage = shot.source === 'footage';
  // The footage and picture-in-picture numbers, as the customer sees them (percent, seconds); saved when they let go.
  const [trim, setTrim] = useState(String(shot.footage?.trimStart ?? 0));
  const [place, setPlace] = useState(toPercent(shot.inset));
  useEffect(() => { setTrim(String(shot.footage?.trimStart ?? 0)); }, [shot.footage?.trimStart]);
  useEffect(() => { setPlace(toPercent(shot.inset)); }, [shot.inset?.x, shot.inset?.y, shot.inset?.w]);
  const locked = BUSY.has(shot.status) || shot.status === 'still_pending' || Boolean(busy);
  const choices = qualityChoices();
  const failed = shot.status === 'failed' || shot.status === 'blocked';
  const waiting = shot.status === 'still_pending' || BUSY.has(shot.status);
  const retryNode =
    retry ??
    (editable && failed ? (
      // A blocked picture would be blocked again: the customer changes the description instead.
      shot.status === 'blocked' ? (
        <Button variant="ghost" size="sm" arrow={false} disabled={Boolean(busy)} onClick={() => setEditing(true)}>Edit description</Button>
      ) : (
        <Button variant="ghost" size="sm" arrow={false} disabled={Boolean(busy)} onClick={() => run('still', () => retryStill(project.id, shot.id))}>
          {shot.retry_credits > 0 ? `Try again (${shot.retry_credits} credits)` : 'Try again'}
        </Button>
      )
    ) : null);
  // The server says what a new picture for this shot costs; the price list is the fallback.
  const remakeCost = typeof shot.still_credits === 'number' ? shot.still_credits : pricing.stillReroll;
  const clipReady = !editable && shot.status === 'ready' && shot.clip_url;
  let media;
  if (isFootage && shot.footage_url) {
    media = (
      // eslint-disable-next-line jsx-a11y/media-has-caption
      <video className={styles.video} controls playsInline muted preload="metadata" src={`${shot.footage_url}#t=${Number(shot.footage?.trimStart) || 0.1}`} aria-label={`Your footage for shot ${shot.ord + 1}`} />
    );
  } else if (isFootage) {
    media = <Tile tone="error" icon="film" title="Pick a clip" text="This shot uses your own footage, but its clip is gone. Pick another one." />;
  } else if (clipReady) {
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

  // rethrow: the caller (a chooser that shows its own error) wants the failure back instead of a notice on the card.
  async function run(kind, fn, { rethrow = false } = {}) {
    setBusy(kind);
    setError(null);
    try {
      await fn();
      await onChanged?.();
    } catch (err) {
      if (rethrow) throw err;
      setError(err);
    } finally {
      setBusy('');
    }
  }

  const commitTrim = () => {
    const n = Number(trim);
    if (!Number.isFinite(n) || n < 0) { setTrim(String(shot.footage?.trimStart ?? 0)); return; }
    if (n !== (Number(shot.footage?.trimStart) || 0)) run('footage', () => updateShot(project.id, shot.id, { footage: { trimStart: n } }));
  };
  const commitPlace = () => {
    const was = toPercent(shot.inset);
    if (place.x !== was.x || place.y !== was.y || place.w !== was.w) run('inset', () => updateShot(project.id, shot.id, { inset: place }));
  };

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
        {shot.inset_url && shot.inset && (
          <span className={styles.inset} data-testid="inset-preview" style={{ left: `${shot.inset.x * 100}%`, top: `${shot.inset.y * 100}%`, width: `${shot.inset.w * 100}%` }}>
            {shot.inset_is_image === false ? <AssetThumb asset={{ kind: 'clip', url: shot.inset_url }} /> : <img src={shot.inset_url} alt="" />}
          </span>
        )}
        <span className={styles.number}>{shot.ord + 1}</span>
      </div>
      <div className={styles.body}>
        <div className={styles.meta}>
          {isFootage ? (
            <Pill tone="accent" data-testid="shot-status">Your footage</Pill>
          ) : (
            <>
              <Pill tone={STATUS_TONE[shot.status] || 'neutral'} data-testid="shot-status">{STATUS_LABELS[shot.status] || shot.status}</Pill>
              <Pill>{QUALITY_LABELS[shot.quality] || shot.quality}</Pill>
            </>
          )}
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
            {!isFootage && (
              <Button variant="ghost" size="sm" arrow={false} className={styles.mini} disabled={locked} title="Make a new picture for this shot"
                onClick={() => run('still', () => makeStills(project.id, [shot.id], ...(Number.isInteger(shot.still_credits) ? [shot.still_credits] : [])))}>
                {busy === 'still' ? 'Making…' : remakeCost > 0 ? `Make it again, ${remakeCost} credits` : 'Make it again'}
              </Button>
            )}
            <Button variant="ghost" size="sm" arrow={false} className={styles.mini} disabled={locked} onClick={() => setEditing(true)}>Edit description</Button>
            {!isFootage && (
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
            )}
            <AssetPicker
              kinds={['clip', 'recording']}
              uploadKind="clip"
              label={isFootage ? 'Change my footage' : 'Use my footage'}
              title="Pick your own footage"
              selectedId={shot.footage_asset_id}
              disabled={locked}
              returnTo={returnTo}
              onPick={(a) => run('footage', () => updateShot(project.id, shot.id, { source: 'footage', footage_asset_id: a.id }), { rethrow: true })}
            />
            {isFootage && (
              <Button variant="ghost" size="sm" arrow={false} className={styles.mini} disabled={locked} onClick={() => run('footage', () => updateShot(project.id, shot.id, { source: 'generated' }))}>
                Use a generated shot instead
              </Button>
            )}
            <AssetPicker
              kinds={['image', 'product', 'logo', 'mascot', 'clip', 'recording']}
              uploadKind="image"
              label={shot.inset_asset_id ? 'Change my picture-in-picture' : 'Add a picture-in-picture'}
              title="Pick a picture or clip to put over this shot"
              selectedId={shot.inset_asset_id}
              disabled={locked}
              returnTo={returnTo}
              onPick={(a) => run('inset', () => updateShot(project.id, shot.id, { inset_asset_id: a.id }), { rethrow: true })}
            />
            {shot.inset_asset_id && (
              <Button variant="ghost" size="sm" arrow={false} className={styles.mini} disabled={locked} onClick={() => run('inset', () => updateShot(project.id, shot.id, { inset_asset_id: null }))}>
                Remove the picture-in-picture
              </Button>
            )}
          </div>
        )}
        {editable && !editing && isFootage && (
          <div className={`${styles.fine} ${more ? styles.fineOpen : ''}`}>
            <label className={styles.num}>
              <span>Start at (seconds)</span>
              <input type="number" min="0" step="0.5" inputMode="decimal" value={trim} disabled={locked}
                onChange={(e) => setTrim(e.target.value)}
                onBlur={() => commitTrim()} onKeyDown={(e) => { if (e.key === 'Enter') commitTrim(); }} />
            </label>
            <label className={styles.num}>
              <span>Fit</span>
              <select value={shot.footage?.fit || 'contain'} disabled={locked} onChange={(e) => run('footage', () => updateShot(project.id, shot.id, { footage: { fit: e.target.value } }))}>
                <option value="contain">Show the whole clip</option>
                <option value="cover">Fill the frame</option>
              </select>
            </label>
          </div>
        )}
        {editable && !editing && shot.inset_asset_id && (
          <div className={`${styles.fine} ${more ? styles.fineOpen : ''}`} data-testid="inset-controls">
            {[['x', 'Across', INSET_RANGE.min, INSET_RANGE.max], ['y', 'Down', INSET_RANGE.min, INSET_RANGE.max], ['w', 'Size', INSET_RANGE.wMin, INSET_RANGE.wMax]].map(([key, text, min, max]) => (
              <label key={key} className={styles.range}>
                <span>{text}</span>
                <input type="range" min={min} max={max} step="1" value={place[key]} disabled={locked} aria-label={`Picture-in-picture ${text.toLowerCase()}`}
                  onChange={(e) => setPlace((p) => ({ ...p, [key]: Number(e.target.value) }))}
                  onPointerUp={() => commitPlace()} onKeyUp={() => commitPlace()} onBlur={() => commitPlace()} />
              </label>
            ))}
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
