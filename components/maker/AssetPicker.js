import { useCallback, useEffect, useRef, useState } from 'react';

import Button from '../ui/Button';
import Modal from '../ui/Modal';
import { checkMedia, getAssets, uploadMedia } from '../../lib/story/client';
import { IMAGE_API_KINDS } from '../../lib/story/assetRules';
import ErrorNotice from './ErrorNotice';
import { EmptyState, Icon, Skeleton } from './Tiles';
import styles from './AssetPicker.module.css';

const KIND_WORDS = { logo: 'logo', product: 'product picture', mascot: 'mascot', image: 'picture', recording: 'screen recording', clip: 'clip' };
const ACCEPT = {
  image: '.png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp',
  video: '.mp4,.mov,video/mp4,video/quicktime',
};
const seconds = (n) => `${Math.round(n)} s`;

/** A small preview of a file: a picture, or the first frame of a clip. */
export function AssetThumb({ asset, className = '' }) {
  const isImage = IMAGE_API_KINDS.includes(asset.kind);
  return (
    <span className={`${styles.thumb} ${className}`} data-kind={asset.kind}>
      {isImage ? (
        <img src={asset.url} alt="" loading="lazy" />
      ) : (
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <video src={`${asset.url}#t=0.1`} preload="metadata" muted playsInline tabIndex={-1} aria-hidden="true" />
      )}
      {!isImage && <span className={styles.badge}>{asset.seconds ? seconds(asset.seconds) : 'Clip'}</span>}
    </span>
  );
}

/**
 * "Use my own ..." door. A button that opens a chooser of the customer's own files (newest first) with an upload at
 * the top. Picking one calls onPick(asset) (it may be async; the chooser closes when it settles without an error).
 *
 *   kinds        which kinds to list: 'logo' | 'product' | 'mascot' | 'recording' | 'clip'
 *   uploadKind   the kind a new upload is kept as (default: the first of kinds); 'image' is a neutral picture
 *   inBrandKit   a new upload also joins the brand kit (default false: only the brand page does that)
 *   label        the button's text
 *   title        the chooser's title
 *   disabled     the button is off
 *   selectedId   the file in use now (marked)
 *   onPick       (asset) => void | Promise
 *   returnTo     where the sign-in link leads back to
 */
export default function AssetPicker({ kinds, uploadKind, label = 'Use my own file', title, disabled = false, selectedId = null, inBrandKit = false, onPick, returnTo, className = '', buttonClass = '' }) {
  const [open, setOpen] = useState(false);
  const [assets, setAssets] = useState(null);
  const [error, setError] = useState(null);
  const [progress, setProgress] = useState(null);
  const [picking, setPicking] = useState('');
  const fileInput = useRef(null);
  const alive = useRef(true);
  const kind = uploadKind || kinds[0];
  const isImageUpload = IMAGE_API_KINDS.includes(kind);
  const wants = kinds.map((k) => KIND_WORDS[k]).filter(Boolean);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const load = useCallback(async () => {
    try {
      const list = await getAssets({ kinds });
      if (alive.current) { setAssets(list); setError(null); }
    } catch (err) {
      if (alive.current) setError(err);
    }
    // kinds is a fresh array every render: its text is the dependency
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kinds.join(',')]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  async function onFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const refusal = checkMedia(file, kind);
    if (refusal) { setError({ status: 422, code: 'validation_failed', serverMessage: refusal }); return; }
    setError(null);
    setProgress(0);
    try {
      const made = await uploadMedia(file, kind, { onProgress: (p) => alive.current && setProgress(p), inBrandKit });
      if (alive.current) setAssets((list) => [made, ...(list || [])]);
    } catch (err) {
      if (alive.current) setError(err);
    } finally {
      if (alive.current) setProgress(null);
    }
  }

  async function pick(asset) {
    setPicking(asset.id);
    setError(null);
    try {
      await onPick?.(asset);
      if (alive.current) setOpen(false);
    } catch (err) {
      if (alive.current) setError(err);
    } finally {
      if (alive.current) setPicking('');
    }
  }

  return (
    <>
      <button type="button" className={`${styles.trigger} ${buttonClass}`} data-asset-picker="" disabled={disabled} onClick={() => setOpen(true)}>
        <Icon name={isImageUpload ? 'image' : 'film'} size={15} />
        {label}
      </button>
      <Modal open={open} onClose={() => { if (!picking && progress === null) setOpen(false); }} title={title || label}
        footer={<Button variant="ghost" arrow={false} onClick={() => setOpen(false)} disabled={Boolean(picking) || progress !== null}>Close</Button>}>
        <div className={`${styles.panel} ${className}`}>
          <div className={styles.upload}>
            <input ref={fileInput} type="file" accept={isImageUpload ? ACCEPT.image : ACCEPT.video} className={styles.file} onChange={onFile} tabIndex={-1} aria-hidden="true" />
            <Button arrow={false} variant="ghost" onClick={() => fileInput.current?.click()} disabled={progress !== null}>
              {progress !== null ? `Uploading ${progress}%` : `Upload ${isImageUpload ? 'a picture' : 'a clip'}`}
            </Button>
            <small>{isImageUpload ? 'PNG, JPG or WebP, up to 5 MB.' : 'MP4 or MOV, up to 200 MB and 5 minutes.'}</small>
          </div>
          <ErrorNotice error={error} returnTo={returnTo} onRefresh={load} />
          {assets === null && !error && <div className={styles.wait}><Skeleton status="Loading your files" ratio="16 / 6" /></div>}
          {assets && assets.length === 0 && (
            <EmptyState icon={isImageUpload ? 'image' : 'film'} title={`No ${wants.join(' or ')} yet`} text="Upload one above and it will be here for every video you make." />
          )}
          {assets && assets.length > 0 && (
            <ul className={styles.grid} aria-label="Your files">
              {assets.map((a) => (
                <li key={a.id}>
                  <button type="button" className={`${styles.choice} ${a.id === selectedId ? styles.chosen : ''}`} aria-pressed={a.id === selectedId} disabled={Boolean(picking)} onClick={() => pick(a)}
                    aria-label={`${a.id === selectedId ? 'In use: ' : 'Use '}${a.name || KIND_WORDS[a.kind]}`}>
                    <AssetThumb asset={a} />
                    <span className={styles.name}>{a.name || KIND_WORDS[a.kind]}</span>
                    <small>{picking === a.id ? 'Using…' : a.id === selectedId ? 'In use' : KIND_WORDS[a.kind]}</small>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Modal>
    </>
  );
}
