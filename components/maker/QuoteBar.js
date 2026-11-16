import { useEffect, useState } from 'react';
import Link from 'next/link';

import { getBilling, getQuote } from '../../lib/story/client';
import { QUALITY_LABELS } from '../../lib/pricingConstants';
import { usePricing } from './PricingContext';
import { estimateCredits } from './steps';
import styles from './QuoteBar.module.css';

const count = (n) => Number(n || 0).toLocaleString();

/**
 * What this video will cost, from the length step on. Before shots exist it shows an estimate from the
 * client-safe pricing helper; once shots exist it shows the server's /quote lines. Never shows what the
 * providers charge us. Shows the balance and, when it is short, how many credits are missing.
 * `reloadKey` changes when something that moves the balance happened (a job finished).
 */
export default function QuoteBar({ project, shots = [], reloadKey = '' }) {
  const [quote, setQuote] = useState(null);
  const [billing, setBilling] = useState(null);
  const pricing = usePricing();

  const shotSignature = shots.map((s) => `${s.id}:${s.seconds}:${s.quality}:${s.source}`).join('|');
  const projectId = project?.id;

  useEffect(() => {
    if (!projectId || shots.length === 0) {
      setQuote(null);
      return undefined;
    }
    let alive = true;
    // Each quote remembers the shots it was made for, so a later shot edit can tell it is out of date.
    getQuote(projectId)
      .then((q) => alive && setQuote(q && typeof q.total === 'number' ? { ...q, shotSignature } : null))
      .catch(() => alive && setQuote(null));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, shotSignature]);

  useEffect(() => {
    let alive = true;
    getBilling()
      .then((b) => alive && setBilling(b))
      .catch(() => alive && setBilling(null));
    return () => {
      alive = false;
    };
  }, [reloadKey]);

  if (!project) return null;
  const estimate = estimateCredits(project, pricing);
  const total = quote ? quote.total : estimate;
  const available = billing?.balance?.available;
  // While billing v2 is off the balance is in the old unit, so a shortfall against a v2 price would be wrong.
  const comparable = billing?.v2 === true && typeof available === 'number';
  const short = comparable && available < total ? total - available : 0;

  const lines = quote?.lines || [];
  // With a server quote the label describes what was quoted (the shots), not the brief. While a
  // re-quote for edited shots is on its way the total is the old one, so the label says it is updating.
  const quoteIsStale = Boolean(quote) && quote.shotSignature !== shotSignature;
  // The server says which shots its total covers (shotIds): only the shots still to make once clips exist.
  const quoted = Array.isArray(quote?.shotIds) ? shots.filter((s) => quote.shotIds.includes(s.id)) : shots;
  const qualities = [...new Set(quoted.map((s) => s.quality))];
  const subLabel = quoteIsStale
    ? 'Updating the quote\u2026'
    : quote && Array.isArray(quote.shotIds) && quoted.length === 0 && shots.length > 0
      ? 'Every shot is made'
      : quote && quoted.length > 0
        ? `${quoted.length} ${quoted.length === 1 ? 'shot' : 'shots'}${quoted.length < shots.length ? ' to make' : ''}, ${quoted.reduce((n, s) => n + (s.seconds || 0), 0)} seconds, ${qualities.length === 1 ? QUALITY_LABELS[qualities[0]] || qualities[0] : 'Mixed quality'}`
        : `${QUALITY_LABELS[project.quality] || project.quality}, ${project.seconds} seconds`;
  return (
    <section className={styles.bar} aria-label="Credit estimate" data-testid="quote-bar">
      <div className={styles.row}>
        <div className={styles.cost}>
          <span className={styles.label}>{quote ? 'Quote for this video' : 'Estimated cost'}</span>
          <strong className={styles.total} data-testid="quote-total">{count(total)} credits</strong>
          <span className={styles.meta} data-testid="quote-sub" aria-busy={quoteIsStale || undefined}>
            {subLabel}
          </span>
        </div>
        {billing && typeof available === 'number' && (
          <div className={styles.balance}>
            <span className={styles.label}>Your balance</span>
            <strong data-testid="quote-balance">{count(available)}<span className={styles.unit}> credits</span></strong>
            <span className={styles.balanceWord}>balance</span>
          </div>
        )}
        {short > 0 && (
          <Link href="/app/billing" className={styles.topUp}>Top up</Link>
        )}
      </div>
      {short > 0 && (
        <p className={styles.short} role="status" aria-live="polite" data-testid="quote-short">
          You need {count(short)} more credits. <Link href="/app/billing">Top up credits</Link>
        </p>
      )}
      {(lines.length > 0 || short > 0) && (
        <details className={`${styles.details} ${lines.length === 0 ? styles.phoneOnly : ''}`}>
          <summary>Details</summary>
          {short > 0 && <p className={styles.shortInDetails}>Short by {count(short)} credits.</p>}
          {lines.length > 0 && (
            <ul>
              {lines.map((l, i) => (
                <li key={`${l.label}-${i}`}>
                  <span>{l.label}</span>
                  <span>{count(l.credits)}</span>
                </li>
              ))}
            </ul>
          )}
        </details>
      )}
    </section>
  );
}
