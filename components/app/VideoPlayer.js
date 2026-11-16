import { useEffect, useState } from 'react';
import styles from './VideoPlayer.module.css';

const RATIOS = { '9:16': [9, 16], '1:1': [1, 1], '16:9': [16, 9] };

/**
 * The finished video: a native player at the video's own shape. Portrait videos are held to a sensible height so
 * they never push the controls off a laptop screen. When the file cannot be played here it says so in plain words.
 */
export default function VideoPlayer({ src, poster, aspect = '16:9', title = 'Your video' }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [src]);
  const [w, h] = RATIOS[aspect] || RATIOS['16:9'];
  return (
    <div className={styles.player} data-player="" data-aspect={RATIOS[aspect] ? aspect : '16:9'} style={{ '--ratio': w / h, aspectRatio: `${w} / ${h}` }}>
      {failed ? (
        <p className={styles.failed} role="alert">This video could not be played here. Download it to watch it on your device.</p>
      ) : (
        <video
          className={styles.video}
          controls
          playsInline
          preload="metadata"
          poster={poster || undefined}
          src={src}
          aria-label={title}
          onError={() => setFailed(true)}
        />
      )}
    </div>
  );
}
