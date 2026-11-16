import { useCallback, useEffect, useState } from 'react';
import Head from 'next/head';

import Button from '../../components/ui/Button';
import Card from '../../components/ui/Card';
import styles from '../../styles/AppPages.module.css';

const REASON_LABELS = {
  plan_renewal: 'Monthly credits',
  topup: 'Top-up',
  clip: 'Video shot',
  'project-fee': 'Project setup',
  refund: 'Refund adjustment',
  clawback: 'Refund adjustment',
  clawback_deferred: 'Refund adjustment',
  plan_expiry: 'Unused credits expired',
  settle: 'Video shot',
  release: 'Released',
  hold_release: 'Released',
};

export function reasonLabel(reason) {
  if (!reason) return 'Credit change';
  if (REASON_LABELS[reason]) return REASON_LABELS[reason];
  const text = String(reason).replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function formatDate(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

const money = (usd) => `$${usd}`;
const count = (n) => Number(n || 0).toLocaleString();

export default function BillingPage() {
  const [billing, setBilling] = useState(null);
  const [offers, setOffers] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState('');
  const [yearly, setYearly] = useState(false);

  useEffect(() => {
    let alive = true;
    const empty = { v2: false, balance: { available: 0 }, history: [], offers: null };
    (async () => {
      let data = empty;
      try {
        const r = await fetch('/api/story/billing');
        if (r.ok) data = await r.json();
      } catch {}
      if (!alive) return;
      setBilling(data);
      if (data.v2) {
        try {
          const r = await fetch('/api/story/pricing');
          if (r.ok) {
            const p = await r.json();
            if (alive) setOffers({ plans: p.plans, topups: p.topups, v2: true, yearlyDiscount: p.yearlyDiscount || 0 });
          }
        } catch {}
      } else if (data.offers) {
        setOffers(data.offers);
      }
    })();
    return () => { alive = false; };
  }, []);

  // Same request the paywall and the top-up page make.
  const checkout = useCallback(async (key, body) => {
    if (busy) return;
    setBusy(key);
    setError('');
    try {
      const res = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, returnTo: '/app/billing' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.url) throw new Error(data.error || 'Could not start checkout.');
      window.location.href = data.url;
    } catch (err) {
      setError(err.message);
      setBusy(null);
    }
  }, [busy]);

  const balance = billing?.balance;

  return (
    <>
      <Head><title>Billing | Ariya Lab</title></Head>
      <div className={styles.page}>
        <div className={styles.header}>
          <div>
            <h1 className={styles.title}>Credits &amp; <span className="accent-word">billing</span></h1>
            <p className={styles.sub}>Credits pay for each shot you generate. Plan credits are used first, then top-ups.</p>
          </div>
        </div>

        {!billing ? (
          <p className={styles.note}>Loading your balance…</p>
        ) : (
          <div className={styles.balances}>
            {billing.v2 ? (
              <>
                <Card className={styles.balance} data-testid="balance-plan">
                  <span className={styles.balanceLabel}>Plan credits</span>
                  <span className={styles.balanceValue}>{count(balance.plan)}</span>
                </Card>
                <Card className={styles.balance} data-testid="balance-topup">
                  <span className={styles.balanceLabel}>Top-up credits</span>
                  <span className={styles.balanceValue}>{count(balance.topup)}</span>
                </Card>
                <Card className={styles.balance} data-testid="balance-held">
                  <span className={styles.balanceLabel}>Held for running videos</span>
                  <span className={styles.balanceValue}>{count(balance.held)}</span>
                </Card>
                <Card className={styles.balance} data-testid="balance-available">
                  <span className={styles.balanceLabel}>Available</span>
                  <span className={styles.balanceValue}>{count(balance.available)}</span>
                </Card>
              </>
            ) : (
              <Card className={styles.balance} data-testid="balance-single">
                <span className={styles.balanceLabel}>Credits</span>
                <span className={styles.balanceValue}>{count(balance.available)}</span>
              </Card>
            )}
          </div>
        )}

        {error && <p className={styles.error} role="alert">{error}</p>}

        {offers && (
          <>
            <section className={styles.section}>
              <h2>Plans</h2>
              {offers.v2 && (
                <div role="group" aria-label="Billing period">
                  <Button variant={yearly ? 'ghost' : 'primary'} aria-pressed={!yearly} onClick={() => setYearly(false)}>Monthly</Button>{' '}
                  <Button variant={yearly ? 'primary' : 'ghost'} aria-pressed={yearly} onClick={() => setYearly(true)}>Yearly</Button>
                </div>
              )}
              <div className={styles.offers}>
                {Object.entries(offers.plans).map(([key, p]) => {
                  const isYear = offers.v2 ? yearly : p.interval === 'year';
                  const usd = offers.v2 && yearly ? (p.yearlyUsd ?? p.usd * 12) : p.usd;
                  return (
                  <Card key={key} className={styles.offer}>
                    <span className={styles.offerName}>{key}</span>
                    <span className={styles.offerPrice}>{money(usd)}<small>{isYear ? '/yr' : '/mo'}</small></span>
                    <span className={styles.offerCredits}>
                      {count(p.credits)} credits every {offers.v2 || !isYear ? 'month' : 'year'}{offers.v2 && yearly ? ', billed yearly' : ''}
                    </span>
                    <Button onClick={() => checkout(`plan-${key}`, offers.v2 ? { plan: key, interval: yearly ? 'year' : 'month' } : { plan: key })} disabled={busy !== null}>
                      {busy === `plan-${key}` ? 'Redirecting…' : 'Choose plan'}
                    </Button>
                  </Card>
                  );
                })}
              </div>
            </section>
            <section className={styles.section}>
              <h2>Top up</h2>
              <div className={styles.offers}>
                {Object.entries(offers.topups).map(([key, t]) => (
                  <Card key={key} className={styles.offer}>
                    <span className={styles.offerPrice}>{money(t.usd)}</span>
                    <span className={styles.offerCredits}>{count(t.credits)} credits, no expiry</span>
                    <Button variant="ghost" onClick={() => checkout(`topup-${key}`, offers.v2 ? { mode: 'topup', pack: key, catalog: 'v2' } : { mode: 'topup', pack: key })} disabled={busy !== null}>
                      {busy === `topup-${key}` ? 'Redirecting…' : 'Buy credits'}
                    </Button>
                  </Card>
                ))}
              </div>
            </section>
          </>
        )}

        {billing?.v2 && (
          <section className={styles.section}>
            <h2>History</h2>
            {billing.history.length === 0 ? (
              <p className={styles.note}>Nothing here yet. Credit changes will show up as you create videos.</p>
            ) : (
              <div className={styles.tableWrap}>
                <table className={styles.ledger}>
                  <thead>
                    <tr><th>Date</th><th>What</th><th className={styles.num}>Credits</th><th className={styles.num}>Balance</th></tr>
                  </thead>
                  <tbody>
                    {billing.history.map((row, i) => (
                      <tr key={`${row.created_at}-${i}`}>
                        <td>{formatDate(row.created_at)}</td>
                        <td>{reasonLabel(row.reason)}</td>
                        <td className={`${styles.num} ${row.delta > 0 ? styles.plus : styles.minus}`}>
                          {row.delta > 0 ? '+' : ''}{count(row.delta)}
                        </td>
                        <td className={styles.num}>{count(row.balance_after)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}
      </div>
    </>
  );
}
