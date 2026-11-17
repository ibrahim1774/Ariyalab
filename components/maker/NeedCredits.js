import Link from 'next/link';

import { useAvailable } from './BalanceContext';
import { GET_CREDITS } from './errors';
import styles from './NeedCredits.module.css';

const count = (n) => Number(n || 0).toLocaleString();

/**
 * Under a button that shows a credit price: when the balance is too low it says so BEFORE the click, with the way to fix it.
 * The button itself stays as it is. items: [{ price, label? }], one per priced button; label names the button when there are
 * several ("Make the rest"). Nothing shows when the balance is unknown, billing v2 is off, or every price is covered.
 */
export function NeedCredits({ items = [] }) {
  const available = useAvailable();
  if (available === null) return null;
  const short = items.filter((i) => Number.isFinite(i?.price) && i.price > available);
  if (!short.length) return null;
  return (
    <span className={styles.need} data-testid="need-credits" role="status">
      {short.map((i, n) => (
        <span key={`${i.label || ''}-${n}`} className={styles.line}>
          {short.length > 1 && i.label ? `${i.label}: you` : 'You'} need {count(i.price - available)} more credits.{' '}
          <Link href="/app/billing" className={styles.link}>{GET_CREDITS}</Link>
        </span>
      ))}
    </span>
  );
}

export default NeedCredits;
