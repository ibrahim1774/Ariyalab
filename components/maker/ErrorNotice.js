import Link from 'next/link';

import { describeError } from './errors';
import { useMakerNav } from './MakerNav';
import styles from './Steps.module.css';

/**
 * Inline error with a specific message and next action. `onRefresh` is called by the Refresh button shown on a 409.
 * `onRetry` powers a "Try again" action (shown only when the step can retry). Pass `field` to only show errors that
 * belong to that input (and leave field-less ones to the step-level notice).
 */
export default function ErrorNotice({ error, returnTo, onRefresh, onRetry, field }) {
  const { goTo } = useMakerNav();
  if (!error) return null;
  const info = describeError(error, { returnTo });
  if (field !== undefined && (info.field || null) !== (field || null)) return null;
  const action = info.action;
  return (
    <div className={styles.errorNotice} role="alert" data-status={error.status} data-code={error.code || undefined}>
      <strong>{info.title}</strong>
      <span>{info.message}</span>
      {action?.href && (
        <Link href={action.href} className={styles.errorAction}>
          {action.label}
        </Link>
      )}
      {action?.step && goTo && (
        <button type="button" className={styles.errorAction} onClick={() => goTo(action.step)}>
          {action.label}
        </button>
      )}
      {action?.retry && onRetry && (
        <button type="button" className={styles.errorAction} onClick={onRetry}>
          {action.label}
        </button>
      )}
      {info.refresh && onRefresh && (
        <button type="button" className={styles.errorAction} onClick={onRefresh}>
          Refresh
        </button>
      )}
    </div>
  );
}
