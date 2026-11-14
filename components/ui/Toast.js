import { useEffect } from 'react';
import styles from './Toast.module.css';

/** Transient message pinned to the bottom. Calls onClose after `duration` ms (0 keeps it). */
export default function Toast({ message, tone = 'neutral', onClose, duration = 4000 }) {
  useEffect(() => {
    if (!message || !duration || !onClose) return undefined;
    const t = setTimeout(onClose, duration);
    return () => clearTimeout(t);
  }, [message, duration, onClose]);

  if (!message) return null;
  return (
    <div className={`${styles.toast} ${styles[tone] || ''}`} role="status" aria-live="polite" data-tone={tone}>
      <span>{message}</span>
      {onClose && (
        <button type="button" className={styles.close} aria-label="Dismiss" onClick={onClose}>
          ×
        </button>
      )}
    </div>
  );
}
