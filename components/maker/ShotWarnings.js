import styles from './ShotWarnings.module.css';

/**
 * Quiet one-line notes about characters a shot cannot fully use (the shot's `warnings`, lib/story/castWarnings.js).
 * Give one `shot` for its own lines, or `shots` for every shot's lines, each starting with the shot number.
 */
export default function ShotWarnings({ shot, shots, label = 'Notes on the shots' }) {
  const list = shot ? [shot] : (shots || []);
  const lines = list.flatMap((s) => (Array.isArray(s?.warnings) ? s.warnings : []).filter((w) => w?.message).map((w, i) => ({
    key: `${s.id}:${w.code}:${i}`,
    text: shot ? w.message : `Shot ${(s.ord ?? 0) + 1}: ${w.message}`,
  })));
  if (!lines.length) return null;
  return (
    <ul className={styles.list} aria-label={label} data-testid="shot-warnings">
      {lines.map((l) => <li key={l.key}>{l.text}</li>)}
    </ul>
  );
}
