import { useEffect, useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';

import Card from '../../components/ui/Card';
import { visibleTools } from '../../lib/legacyTools';
import styles from '../../styles/AppPages.module.css';

export default function ToolsPage() {
  const [tabsEnabled, setTabsEnabled] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);

  // Same rule as the old navbar: gated tools show for admins or when the flag is on.
  useEffect(() => {
    fetch('/api/feature-tabs')
      .then((r) => r.json().catch(() => ({})))
      .then((d) => setTabsEnabled(Boolean(d?.enabled)))
      .catch(() => {});
    fetch('/api/entitlement')
      .then((r) => (r.ok ? r.json() : {}))
      .then((d) => setIsAdmin(Boolean(d?.isAdmin)))
      .catch(() => {});
  }, []);

  const tools = visibleTools({ tabsEnabled, isAdmin });

  return (
    <>
      <Head><title>More tools | Sonallo</title></Head>
      <div className={styles.page}>
        <div className={styles.header}>
          <div>
            <h1 className={styles.title}>More <span className="accent-word">tools</span></h1>
            <p className={styles.sub}>The single-purpose tools that came before the story maker.</p>
          </div>
        </div>
        <div className={styles.tools}>
          {tools.map((t) => (
            <Link key={t.href} href={t.href} className={styles.tool}>
              <Card className={styles.toolCard}>
                <h3>{t.label}</h3>
                <p>{t.blurb}</p>
              </Card>
            </Link>
          ))}
        </div>
      </div>
    </>
  );
}
