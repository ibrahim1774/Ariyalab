import styles from './Stepper.module.css';

/**
 * Horizontal step tracker. Steps before `currentId` are done, `currentId` is
 * current, the rest are upcoming. A step with `stale: true` shows as stale
 * (its inputs changed after it was made) regardless of position.
 */
export default function Stepper({ steps, currentId }) {
  const currentIndex = steps.findIndex((s) => s.id === currentId);
  return (
    <ol className={styles.stepper}>
      {steps.map((step, i) => {
        let state = 'upcoming';
        if (step.stale) state = 'stale';
        else if (i < currentIndex) state = 'done';
        else if (i === currentIndex) state = 'current';
        return (
          <li
            key={step.id}
            className={`${styles.step} ${styles[state]}`}
            data-state={state}
            aria-current={state === 'current' ? 'step' : undefined}
          >
            <span className={styles.marker} aria-hidden="true">
              {state === 'done' ? '✓' : state === 'stale' ? '!' : i + 1}
            </span>
            <span className={styles.label}>{step.label}</span>
          </li>
        );
      })}
    </ol>
  );
}
