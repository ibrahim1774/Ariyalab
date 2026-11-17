import { useCallback, useEffect, useState } from 'react';

/*
 * Admin pricing editor (pages/admin/index.js): reads and writes pricing_config
 * through /api/admin/pricing (admins only). Shows cost per credit for every
 * plan and pack, the margin per quality against provider cost, a warning when
 * the live config differs from the static defaults the homepage shows, and
 * the billing_v2 switch.
 */

const panel = {
  margin: '0 0 20px',
  padding: 20,
  borderRadius: 18,
  border: '1px solid rgba(255,255,255,0.1)',
  background: 'rgba(10,10,12,0.5)',
};
const cell = { padding: '4px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' };
const usd = (n, d = 2) => `$${Number(n).toFixed(d)}`;
const pct = (n) => (n === null || n === undefined ? 'n/a' : `${Math.round(n * 100)}%`);

export default function PricingEditor() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [key, setKey] = useState('plans');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (init) => {
    setError('');
    try {
      const r = await fetch('/api/admin/pricing', init);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Could not load pricing.');
      setData(d);
      return d;
    } catch (err) {
      setError(err.message);
      return null;
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (data) setText(JSON.stringify(data.pricing[key] ?? null, null, 2));
  }, [data, key]);

  const save = async (k, value, extra = {}) => {
    setBusy(true);
    setNotice('');
    const d = await load({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: k, value, ...extra }) });
    setBusy(false);
    if (d) setNotice(`Saved ${k}. Other server instances pick it up within 60 seconds.`);
  };

  const saveText = () => {
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      setError('That is not valid JSON.');
      return;
    }
    save(key, value);
  };

  const flipBillingV2 = () => {
    if (!data) return;
    if (data.billingV2) {
      if (!window.confirm('Turn billing v2 OFF? If the legacy migration already ran with --apply, migrated customers stay on the new ledger and this is not a real way back. Continue?')) return;
      save('billing_v2', false);
      return;
    }
    if (!window.confirm('Turn billing v2 ON? Checkout starts selling Starter, Creator and Studio and every new purchase is granted in the credit ledger. After the legacy migration runs with --apply this is one-way. Continue?')) return;
    save('billing_v2', true, { confirm: 'billing_v2' });
  };

  if (!data) {
    return (
      <section style={panel} data-testid="pricing-editor">
        <h3 style={{ margin: '0 0 6px', fontSize: 16 }}>Pricing</h3>
        <p style={{ fontSize: 13 }}>{error || 'Loading…'}</p>
      </section>
    );
  }
  const { readout } = data;

  return (
    <section style={panel} data-testid="pricing-editor">
      <h3 style={{ margin: '0 0 6px', fontSize: 16 }}>Pricing</h3>

      {readout.drift.length > 0 && (
        <p role="alert" style={{ fontSize: 13, color: '#f2c94c' }}>
          The live config differs from the built-in defaults for: {readout.drift.join(', ')}. The homepage pricing section
          shows the built-in defaults, so update lib/pricingConstants.js (and redeploy) to match, or the homepage numbers
          drift from what checkout and the app charge.
        </p>
      )}

      <p style={{ fontSize: 13 }}>
        Billing v2 is <strong>{data.billingV2 ? 'ON' : 'OFF'}</strong>.{' '}
        <button type="button" onClick={flipBillingV2} disabled={busy}>
          {data.billingV2 ? 'Turn billing v2 off' : 'Turn billing v2 on'}
        </button>
      </p>

      <h4 style={{ margin: '14px 0 6px', fontSize: 14 }}>Cost per credit</h4>
      <table style={{ fontSize: 13, borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th>Offer</th><th style={cell}>Price</th><th style={cell}>Credits</th><th style={cell}>USD / credit</th>
            <th style={cell}>Yearly</th><th style={cell}>Yearly USD / credit</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(readout.plans).map(([k, p]) => (
            <tr key={k} data-offer={k}>
              <td>{k} (monthly)</td><td style={cell}>{usd(p.usd)}</td><td style={cell}>{p.credits.toLocaleString()}</td>
              <td style={cell}>{usd(p.usdPerCredit, 4)}</td><td style={cell}>{usd(p.yearlyUsd)}</td>
              <td style={cell}>{usd(p.yearlyUsdPerCredit, 4)}</td>
            </tr>
          ))}
          {Object.entries(readout.topups).map(([k, t]) => (
            <tr key={k} data-offer={`topup-${k}`}>
              <td>top-up {k}</td><td style={cell}>{usd(t.usd)}</td><td style={cell}>{t.credits.toLocaleString()}</td>
              <td style={cell}>{usd(t.usdPerCredit, 4)}</td><td style={cell}>-</td><td style={cell}>-</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ fontSize: 12 }}>Yearly discount: {pct(readout.yearlyDiscount)}.</p>
      {readout.render && (
        <p style={{ fontSize: 12 }} data-testid="render-price">
          Renders: the first {readout.render.included} of each project free, then {readout.render.credits} credits each
          (included.render, renderRegen).
        </p>
      )}

      <h4 style={{ margin: '14px 0 6px', fontSize: 14 }}>Margin per quality (one generated second)</h4>
      <table style={{ fontSize: 13, borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th>Quality</th><th style={cell}>Provider cost</th><th style={cell}>Credits</th>
            <th style={cell}>Price (cheapest credit)</th><th style={cell}>Margin</th>
            <th style={cell}>Price (dearest credit)</th><th style={cell}>Margin</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(readout.margins).map(([q, m]) => (
            <tr key={q} data-quality={q}>
              <td>{m.label}</td><td style={cell}>{usd(m.providerUsdPerSecond, 4)}</td><td style={cell}>{m.creditsPerSecond}</td>
              <td style={cell}>{usd(m.priceUsdPerSecondLow, 4)}</td><td style={cell}>{pct(m.marginLow)}</td>
              <td style={cell}>{usd(m.priceUsdPerSecondHigh, 4)}</td><td style={cell}>{pct(m.marginHigh)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h4 style={{ margin: '14px 0 6px', fontSize: 14 }}>Edit a setting</h4>
      <p style={{ fontSize: 12 }}>
        A new plan or pack price becomes a new Stripe price at the next checkout; subscribers keep the price and credits
        they bought. Write whole plan objects, for example {'{ "creator": { "usd": 49, "credits": 2600 } }'}.
      </p>
      <label style={{ fontSize: 13 }}>
        Setting{' '}
        <select value={key} onChange={(e) => setKey(e.target.value)} aria-label="Pricing setting">
          {data.editable.filter((k) => k !== 'billing_v2').map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
      </label>
      <textarea
        aria-label="Setting value (JSON)"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={8}
        style={{ display: 'block', width: '100%', margin: '8px 0', fontFamily: 'monospace', fontSize: 12 }}
      />
      <button type="button" onClick={saveText} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
      {error && <p role="alert" style={{ fontSize: 13, color: '#ff8a8a' }}>{error}</p>}
      {notice && <p style={{ fontSize: 13 }}>{notice}</p>}
    </section>
  );
}
