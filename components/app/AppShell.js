import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';

import CreditBadge from './CreditBadge';
import SignOutButton from './SignOutButton';
import useLegacyPlan from '../../lib/useLegacyPlan';
import { markInApp } from '../../lib/appVisit';
import styles from './AppShell.module.css';

const NAV = [
  { href: '/app', label: 'Projects', exact: true },
  { href: '/app/brand', label: 'Brand kit' },
  { href: '/app/voices', label: 'Voices' },
  { href: '/app/billing', label: 'Billing' },
  { href: '/app/connections', label: 'Connected apps' },
  { href: '/app/tools', label: 'More tools' },
];

/** Signed-in chrome: left sidebar, credit balance top right, page content in the main area. */
export default function AppShell({ children }) {
  const { pathname, events } = useRouter();
  const { legacyPlan, classicUrl } = useLegacyPlan();
  const activeRef = useRef(null);
  // On a phone the nav is a horizontal strip: bring the current tab into view.
  useEffect(() => {
    activeRef.current?.scrollIntoView?.({ inline: 'center', block: 'nearest' });
  }, [pathname]);
  // Remember that this customer is moving around inside the app (see lib/appVisit.js): a deep link, or a link click.
  useEffect(() => {
    if (pathname !== '/app') markInApp();
    // Only a move to another /app page counts (signing out to / does not, so the next sign-in lands normally).
    const onStart = (url) => { if (/^\/app(\/|\?|#|$)/.test(String(url))) markInApp(); };
    events?.on?.('routeChangeStart', onStart);
    return () => events?.off?.('routeChangeStart', onStart);
  }, [pathname, events]);
  const isActive = (item) => (item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`));

  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <Link href="/" className={styles.brand}>
          <span className={styles.mark} aria-hidden="true">S</span>
          <span className={styles.wordmark}>Sonallo</span>
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
          {legacyPlan && (classicUrl
            ? <a href={classicUrl} className={styles.classicLink}>Your plan is on ariyalab.online</a>
            : <Link href="/legacy-home" className={styles.classicLink}>Classic tools</Link>)}
          <SignOutButton />
        </header>
        <main className={styles.main}>{children}</main>
      </div>
    </div>
  );
}
