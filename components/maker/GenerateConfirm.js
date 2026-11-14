import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

import Button from '../ui/Button';
import Modal from '../ui/Modal';
import { getBilling, getQuote, startGeneration } from '../../lib/story/client';
import ErrorNotice from './ErrorNotice';
import styles from './Steps.module.css';

const count = (n) => Number(n || 0).toLocaleString();

/**
 * Shows the quote lines and total for `shotIds`, the balance after, and posts `confirmTotal`
 * (the total the customer just saw) to /generate. A quote that moved in between is a 409 and the quote reloads.
 */
export default function GenerateConfirm({ open, onClose, project, shotIds, onStarted, returnTo }) {
  const [quote, setQuote] = useState(null);
  const [billing, setBilling] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setQuote(null);
    try {
      const [q, b] = await Promise.all([getQuote(project.id, shotIds), getBilling().catch(() => null)]);
      setQuote(q);
      setBilling(b);
    } catch (err) {
      setError(err);
    }
  }, [project.id, shotIds]);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setBusy(false);
    load();
  }, [open, load]);

  const available = billing?.balance?.available;
  const comparable = billing?.v2 === true && typeof available === 'number';
  const after = comparable && quote ? available - quote.total : null;
  const short = after != null && after < 0 ? -after : 0;

  async function confirm() {
    if (!quote || busy) return;
    setBusy(true);
    setError(null);
    try {
      await startGeneration(project.id, shotIds, quote.total);
      await onStarted?.();
      onClose?.();
    } catch (err) {
      setError(err);
      // The price may have moved: show the new one before asking again.
      if (err.status === 409) load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Confirm and generate"
      footer={
        <>
          <Button variant="ghost" arrow={false} onClick={onClose}>Cancel</Button>
          <Button arrow={false} onClick={confirm} disabled={!quote || busy || short > 0}>
            {busy ? 'Starting…' : `Generate for ${quote ? count(quote.total) : '...'} credits`}
          </Button>
        </>
      }
    >
      {!quote && !error && <p role="status">Working out the price…</p>}
      {quote && (
        <div className={styles.confirm}>
          <ul className={styles.quoteLines}>
            {(quote.lines || []).map((l, i) => (
              <li key={`${l.label}-${i}`}>
                <span>{l.label}</span>
                <span>{count(l.credits)}</span>
              </li>
            ))}
          </ul>
          <p className={styles.quoteTotal}>
            <span>Total</span>
            <strong data-testid="confirm-total">{count(quote.total)} credits</strong>
          </p>
          {comparable && short === 0 && (
            <p className={styles.hint} data-testid="confirm-after">
              Your balance after: {count(Math.max(0, after))} credits
            </p>
          )}
          {short > 0 && (
            <p className={styles.errorNotice} role="alert">
              <strong>Not enough credits</strong>
              <span>You need {count(short)} more credits.</span>
              <Link href="/app/billing" className={styles.errorAction}>Top up credits</Link>
            </p>
          )}
        </div>
      )}
      <ErrorNotice error={error} returnTo={returnTo} onRefresh={load} />
    </Modal>
  );
}
