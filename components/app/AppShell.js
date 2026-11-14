import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';

import CreditBadge from './CreditBadge';
import styles from './AppShell.module.css';

const NAV = [
  { href: '/app', label: 'Projects', exact: true },
  { href: '/app/brand', label: 'Brand kit' },
  { href: '/app/voices', label: 'Voices' },
  { href: '/app/billing', label: 'Billing' },
  { href: '/app/tools', label: 'More tools' },
];

/** Signed-in chrome: left sidebar, credit balance top right, page content in the main area. */
export default function AppShell({ children }) {
  const { pathname } = useRouter();
  const activeRef = useRef(null);
  // On a phone the nav is a horizontal strip: bring the current tab into view.
  useEffect(() => {
    activeRef.current?.scrollIntoView?.({ inline: 'center', block: 'nearest' });
  }, [pathname]);
  const isActive = (item) => (item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`));

  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <Link href="/" className={styles.brand}>
          <span className={styles.mark} aria-hidden="true">A</span>
          <span className={styles.wordmark}>Ariya Lab</span>
        </Link>
        <nav className={styles.nav} aria-label="App">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`${styles.item} ${isActive(item) ? styles.active : ''}`}
              aria-current={isActive(item) ? 'page' : undefined}
              ref={isActive(item) ? activeRef : null}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </aside>
      <div className={styles.column}>
        <header className={styles.topbar}>
          <CreditBadge />
        </header>
        <main className={styles.main}>{children}</main>
      </div>
    </div>
  );
}
