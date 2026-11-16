import { Icon } from './Tiles';
import styles from './VoicePreview.module.css';

/**
 * A voice's preview: the player when there is a sample, otherwise a designed "Preview not available" state
 * (the preset voices have no sample in real mode, and a clone whose recording is gone has none either).
 */
export default function VoicePreview({ sampleUrl, name, label = 'Voice sample', compact = false }) {
  if (sampleUrl) {
    return <audio className={styles.player} controls preload="none" src={sampleUrl} aria-label={label} />;
  }
  return (
    <div className={`${styles.none} ${compact ? styles.compact : ''}`} data-preview="none">
      <span className={styles.icon}><Icon name="mic" size={16} /></span>
      <span className={styles.words}>
        <strong>Preview not available</strong>
        {!compact && <small>{name ? `We have no sample of ${name}. Make the narration to hear it.` : 'There is no sample of this voice yet.'}</small>}
      </span>
    </div>
  );
}
