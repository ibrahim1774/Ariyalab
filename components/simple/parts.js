import Link from 'next/link';

import styles from './Simple.module.css';

export const count = (n) => Number(n || 0).toLocaleString();

/** "42 credits", or "included" for 0: the words every button and price in the simple maker uses. */
export const priceText = (n) => (Number(n) === 0 ? 'included' : `${count(n)} ${Number(n) === 1 ? 'credit' : 'credits'}`);

/** A button label with its price: "Make my video (240 credits)", "Make my video (included)". Unknown price: no brackets. */
export const withPrice = (label, credits) => (Number.isInteger(credits) ? `${label} (${priceText(credits)})` : label);

export function Check() {
  return (
    <svg viewBox="0 0 16 16" width="1em" height="1em" aria-hidden="true">
      <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** The heading row of a screen: its title, one plain sentence, and a status pill on the right. */
export function ScreenHead({ title, sub, status, done = false }) {
  return (
    <div className={styles.head}>
      <div>
        <h2 className={styles.h}>{title}</h2>
        {sub && <p className={styles.sub}>{sub}</p>}
      </div>
      {status && <span className={`${styles.status} ${done ? styles.statusDone : ''}`}>{done && <Check />}{status}</span>}
    </div>
  );
}

/**
 * The bar at the bottom of every screen: what it costs on the left, the one main button (and at most one smaller one) on the right.
 * `children` are the buttons. Never empty: a screen with nothing to press says why in `hint`.
 */
export function Dock({ label, total, meta, hint, children }) {
  return (
    <div className={styles.dock} data-testid="dock">
      <div className={styles.quote}>
        {label && <span className={styles.quoteLabel}>{label}</span>}
        {total !== undefined && total !== null && <strong className={styles.quoteTotal} data-testid="dock-total">{typeof total === 'number' ? priceText(total) : total}</strong>}
        {meta && <span className={styles.quoteMeta}>{meta}</span>}
        {hint && <span className={styles.dockHint}>{hint}</span>}
      </div>
      <div className={styles.dockButtons}>{children}</div>
    </div>
  );
}

/** A live region for the status changes a screen announces ("Drawing your characters"). */
export function Announce({ children }) {
  return <p className={styles.srOnly} role="status" aria-live="polite">{children}</p>;
}

export const BillingLink = ({ children = 'Top up credits' }) => <Link href="/app/billing" className={styles.link}>{children}</Link>;
