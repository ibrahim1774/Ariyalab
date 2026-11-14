import Link from 'next/link';
import styles from './MarketingFooter.module.css';

const COLUMNS = [
  {
    title: 'Product',
    links: [
      { href: '/#how-it-works', label: 'How it works' },
      { href: '/#pricing', label: 'Pricing' },
      { href: '/#faq', label: 'FAQ' },
    ],
  },
  {
    title: 'Account',
    links: [
      { href: '/sign-in', label: 'Login' },
      { href: '/sign-up', label: 'Get Started' },
      { href: '/app', label: 'Dashboard' },
    ],
  },
  {
    title: 'Company',
    links: [
      { href: '/support', label: 'Support' },
      { href: 'mailto:support@davoxa.com', label: 'Contact' },
    ],
  },
];

// Social profile URLs come from env so no handle is invented here.
const SOCIALS = [
  { label: 'Instagram', url: process.env.NEXT_PUBLIC_SOCIAL_INSTAGRAM, path: 'M7 3h10a4 4 0 014 4v10a4 4 0 01-4 4H7a4 4 0 01-4-4V7a4 4 0 014-4zm5 5a4 4 0 100 8 4 4 0 000-8zm5.5-2a1 1 0 100 2 1 1 0 000-2z' },
  { label: 'TikTok', url: process.env.NEXT_PUBLIC_SOCIAL_TIKTOK, path: 'M14 3v11.5a3.5 3.5 0 11-3.5-3.5M14 3c.4 2.4 2 4 4.5 4.2' },
  { label: 'YouTube', url: process.env.NEXT_PUBLIC_SOCIAL_YOUTUBE, path: 'M3 8a3 3 0 013-3h12a3 3 0 013 3v8a3 3 0 01-3 3H6a3 3 0 01-3-3V8zm7 1.5v5l4.5-2.5L10 9.5z' },
].filter((s) => s.url);

export default function MarketingFooter() {
  return (
    <footer className={styles.footer}>
      <div className={styles.inner}>
        <div className={styles.about}>
          <div className={styles.brand}>
            <span className={styles.mark} aria-hidden="true">A</span>
            <span className={styles.wordmark}>Ariya Lab</span>
          </div>
          <p className={styles.blurb}>
            Turn a short idea into an animated story video, ready to post. Describe it, pick your cast, get your video.
          </p>
          {SOCIALS.length > 0 && (
            <div className={styles.socials}>
              {SOCIALS.map((s) => (
                <a key={s.label} href={s.url} className={styles.social} aria-label={s.label} target="_blank" rel="noopener noreferrer">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d={s.path} />
                  </svg>
                </a>
              ))}
            </div>
          )}
        </div>
        {COLUMNS.map((col) => (
          <div key={col.title} className={styles.col}>
            <h4 className={styles.colTitle}>{col.title}</h4>
            {col.links.map((l) => (
              <Link key={l.href} href={l.href} className={styles.colLink}>
                {l.label}
              </Link>
            ))}
          </div>
        ))}
      </div>
      <div className={styles.legal}>© {new Date().getFullYear()} Ariya Lab. All rights reserved.</div>
    </footer>
  );
}
