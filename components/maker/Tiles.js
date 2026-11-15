import { useEffect, useState } from 'react';

import { STYLES } from '../../lib/story/prompts/styles';
import styles from './Tiles.module.css';

const PATHS = {
  palette: 'M12 3a9 9 0 100 18c1.2 0 2-.8 2-1.8 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-1 .8-1.8 1.8-1.8H17a4 4 0 004-4c0-4.4-4-8-9-8zM7.5 11a1.2 1.2 0 110-2.4 1.2 1.2 0 010 2.4zm3-3.5a1.2 1.2 0 110-2.4 1.2 1.2 0 010 2.4zm4 0a1.2 1.2 0 110-2.4 1.2 1.2 0 010 2.4z',
  alert: 'M12 3l10 18H2L12 3zm0 6v5m0 3v.5',
  block: 'M12 3a9 9 0 100 18 9 9 0 000-18zM5.6 5.6l12.8 12.8',
  image: 'M4 5h16v14H4V5zm0 11l5-5 4 4 3-3 4 4M9 9.5a1 1 0 110-.01',
  film: 'M4 4h16v16H4V4zm4 0v16m8-16v16M4 9h4m8 0h4M4 15h4m8 0h4',
  user: 'M12 12a4 4 0 100-8 4 4 0 000 8zm-8 9a8 8 0 0116 0',
  spark: 'M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2 2-6z',
  text: 'M5 6h14M5 11h14M5 16h9',
  mic: 'M12 3a3 3 0 00-3 3v5a3 3 0 006 0V6a3 3 0 00-3-3zM6 11a6 6 0 0012 0M12 17v4M9 21h6',
  music: 'M9 18V6l10-2v12M9 18a3 3 0 11-6 0 3 3 0 016 0zm10-2a3 3 0 11-6 0 3 3 0 016 0z',
  captions: 'M4 6h16v12H4V6zm3 4h4m-4 4h2m5-4h2m-3 4h4',
};

export function Icon({ name = 'image', size = 22 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name] || PATHS.image} />
    </svg>
  );
}

/** A designed, labelled tile: tinted patterned background, an icon, a title and a short line. `tone` neutral or error. */
export function Tile({ icon = 'image', title, text, tone = 'neutral', ratio, children, className = '', ...rest }) {
  return (
    <div className={`${styles.tile} ${tone === 'error' ? styles.error : ''} ${className}`} style={ratio ? { aspectRatio: ratio } : undefined} data-tile={tone} {...rest}>
      <span className={styles.icon}><Icon name={icon} /></span>
      {title && <strong className={styles.title}>{title}</strong>}
      {text && <span className={styles.text}>{text}</span>}
      {children}
    </div>
  );
}

/**
 * A waiting state in the card's own aspect ratio: shimmer, a status line and (for shots) the script line.
 * Static tinted tile when the customer prefers reduced motion (CSS).
 */
export function Skeleton({ status, line, ratio, image, ...rest }) {
  return (
    <div className={styles.skeleton} style={ratio ? { aspectRatio: ratio } : undefined} data-skeleton="" aria-busy="true" {...rest}>
      {image && <span className={styles.ghost} style={{ backgroundImage: `url(${image})` }} aria-hidden="true" />}
      <span className={styles.shimmerLayer} aria-hidden="true" />
      <span className={styles.skeletonText}>
        <strong>{status}</strong>
        {line && <span>{line}</span>}
      </span>
    </div>
  );
}

/** Where a style's sample image lives. */
export const styleImageSrc = (key) => `/styles/${key}.jpg`;

/** A style's sample image; a labelled tile if the file is missing. */
export function StyleImage({ styleKey, label, ratio = '1 / 1' }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [styleKey]);
  const name = label || STYLES[styleKey]?.label || 'Style';
  if (failed) return <Tile icon="palette" title={name} ratio={ratio} className={styles.styleTile} />;
  return (
    <img className={styles.styleImg} style={{ aspectRatio: ratio }} src={styleImageSrc(styleKey)} alt={name} loading="lazy" onError={() => setFailed(true)} />
  );
}

/** A designed empty list: an illustration style tile, a line of text and at most one action. */
export function EmptyState({ icon = 'film', title, text, children, ...rest }) {
  return (
    <div className={styles.empty} data-media-card="" data-empty="" {...rest}>
      <Tile icon={icon} className={styles.emptyTile} />
      <h3>{title}</h3>
      {text && <p>{text}</p>}
      {children}
    </div>
  );
}

/** Always visible on the cast and storyboard steps: every picture follows the style picked earlier. */
export function StyleNote({ project }) {
  const key = project?.style;
  if (!key) return null;
  const label = STYLES[key]?.label || 'Your own style';
  const extra = key === 'custom' && project.style_custom ? `, ${project.style_custom}` : '';
  return (
    <p className={styles.styleNote} data-testid="style-note">
      Style: {label}{extra}.<span className={styles.styleExtra}> Every picture follows it.</span>
    </p>
  );
}
