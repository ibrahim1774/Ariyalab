import { useCallback, useEffect, useState } from 'react';
import Head from 'next/head';

import Button from '../../components/ui/Button';
import Card from '../../components/ui/Card';
import styles from '../../styles/AppPages.module.css';
import own from '../../styles/Connections.module.css';

function formatDate(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * Connected apps: the apps (such as Claude) the signed-in user allowed to use
 * their account through the MCP connector, with a Disconnect button for each.
 * Reads and writes /api/oauth/connections. Rendered inside AppShell by _app.
 */
export default function ConnectionsPage() {
  const [connections, setConnections] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/oauth/connections');
      const data = r.ok ? await r.json() : { connections: [] };
      setConnections(data.connections || []);
    } catch {
      setConnections([]);
      setError('We could not load your connected apps. Please try again.');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function disconnect(clientId) {
    setBusy(clientId);
    setError('');
    try {
      const r = await fetch('/api/oauth/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId }),
      });
      if (!r.ok) throw new Error('failed');
      await load();
    } catch {
      setError('That app could not be disconnected. Please try again.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <Head>
        <title>Connected apps · Ariya Lab</title>
      </Head>
      <div className={styles.page}>
        <div className={styles.header}>
          <div>
            <h1 className={styles.title}>
              Connected <span className="accent-word">apps</span>
            </h1>
            <p className={styles.sub}>
              Apps you allowed to make story videos and spend credits for you. Disconnect one and it loses access straight away.
            </p>
          </div>
        </div>
        {error && <p className={styles.error}>{error}</p>}
        {connections === null ? (
          <p className={styles.note}>Loading your connected apps…</p>
        ) : connections.length === 0 ? (
          <Card className={styles.empty}>
            <h2>No apps are connected</h2>
            <p>When you connect Ariya Lab to Claude, it shows up here.</p>
          </Card>
        ) : (
          <div className={own.list}>
            {connections.map((c) => (
              <Card key={c.clientId} className={own.row}>
                <div className={own.info}>
                  <p className={own.name}>{c.headline}</p>
                  {!c.verified && <p className={own.unverified}>Unverified app</p>}
                  <p className={styles.note}>
                    Connected {formatDate(c.connectedAt)}
                    {c.lastActiveAt ? `, last used ${formatDate(c.lastActiveAt)}` : ''}
                  </p>
                </div>
                <Button variant="ghost" arrow={false} disabled={busy === c.clientId} onClick={() => disconnect(c.clientId)}>
                  {busy === c.clientId ? 'Disconnecting…' : 'Disconnect'}
                </Button>
              </Card>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
