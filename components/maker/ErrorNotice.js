import Link from 'next/link';

import { describeError } from './errors';
import styles from './Steps.module.css';

/**
 * Inline error with a specific message and next action. `onRefresh` is called by the
 * Refresh button shown on a 409. Pass `field` to only show errors that belong to that input
 * (and leave field-less ones to the step-level notice).
 */
export default function ErrorNotice({ error, returnTo, onRefresh, field }) {
  if (!error) return null;
  const info = describeError(error, { returnTo });
  if (field !== undefined && (info.field || null) !== (field || null)) return null;
  return (
    <div className={styles.errorNotice} role="alert" data-status={error.status} data-code={error.code || undefined}>
      <strong>{info.title}</strong>
      <span>{info.message}</span>
      {info.action && (
        <Link href={info.action.href} className={styles.errorAction}>
          {info.action.label}
        </Link>
      )}
      {info.refresh && onRefresh && (
        <button type="button" className={styles.errorAction} onClick={onRefresh}>
          Refresh
        </button>
      )}
    </div>
  );
}
