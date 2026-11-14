import { useEffect, useRef } from 'react';

import styles from './Stepper.module.css';

/**
 * Horizontal step tracker. Steps before `currentId` are done, `currentId` is
 * current, the rest are upcoming. A step with `stale: true` shows as stale
 * (its inputs changed after it was made) regardless of position, with a
 * visible "Needs update" badge.
 *
 * Passing `onSelect(id)` makes each step a button; a step with `locked: true`
 * stays disabled. Without `onSelect` it is a plain list, as before.
 */
export default function Stepper({ steps, currentId, onSelect }) {
  const currentIndex = steps.findIndex((s) => s.id === currentId);
  const currentRef = useRef(null);
  // On a phone the list scrolls sideways: keep the current step in view.
  useEffect(() => {
    currentRef.current?.scrollIntoView?.({ inline: 'center', block: 'nearest' });
  }, [currentId]);

  return (
    <ol className={styles.stepper}>
      {steps.map((step, i) => {
        let state = 'upcoming';
        if (step.stale) state = 'stale';
        else if (i < currentIndex) state = 'done';
        else if (i === currentIndex) state = 'current';
        const isCurrent = i === currentIndex;
        const content = (
          <>
            <span className={styles.marker} aria-hidden="true">
              {state === 'done' ? '✓' : state === 'stale' ? '!' : i + 1}
            </span>
            <span className={styles.label}>{step.label}</span>
            {step.stale && <span className={styles.badge}>Needs update</span>}
          </>
        );
        return (
          <li
            key={step.id}
            ref={isCurrent ? currentRef : null}
            className={`${styles.step} ${styles[state]}`}
            data-state={state}
            aria-current={isCurrent && !onSelect ? 'step' : undefined}
          >
            {onSelect ? (
              <button
                type="button"
                className={styles.stepButton}
                disabled={step.locked}
                aria-current={isCurrent ? 'step' : undefined}
                onClick={() => onSelect(step.id)}
              >
                {content}
              </button>
            ) : (
              content
            )}
          </li>
        );
      })}
    </ol>
  );
}
