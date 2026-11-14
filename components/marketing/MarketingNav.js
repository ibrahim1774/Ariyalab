import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';

import Button from '../ui/Button';
import styles from './MarketingNav.module.css';

const LINKS = [
  { href: '/', label: 'Home' },
  { href: '/#how-it-works', label: 'How it works' },
  { href: '/#pricing', label: 'Pricing' },
  { href: '/#faq', label: 'FAQ' },
];

/** Floating rounded nav bar used on the marketing pages. Stays on top while scrolling. */
export default function MarketingNav() {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setOpen(false);
  }, [router.asPath]);

  return (
    <header className={styles.wrap}>
      <nav className={styles.bar} aria-label="Main">
        <Link href="/" className={styles.brand}>
          <span className={styles.mark} aria-hidden="true">A</span>
          <span className={styles.wordmark}>Ariya Lab</span>
        </Link>

        <div className={styles.links}>
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={`${styles.link} ${router.pathname === l.href ? styles.active : ''}`}
            >
              {l.label}
            </Link>
          ))}
        </div>

        <div className={styles.actions}>
          <Link href="/sign-in" className={styles.login}>Login</Link>
          <Button href="/sign-up" size="sm">Get Started</Button>
        </div>

        <button
          type="button"
          className={styles.burger}
          aria-label={open ? 'Close menu' : 'Open menu'}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <span />
          <span />
        </button>
      </nav>

      {open && (
        <div className={styles.sheet}>
          {LINKS.map((l) => (
            <Link key={l.href} href={l.href} className={styles.sheetLink}>
              {l.label}
            </Link>
          ))}
          <Link href="/sign-in" className={styles.sheetLink}>Login</Link>
          <Button href="/sign-up">Get Started</Button>
        </div>
      )}
    </header>
  );
}
