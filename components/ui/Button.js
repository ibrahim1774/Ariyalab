import Link from 'next/link';
import styles from './Button.module.css';

const VARIANTS = ['primary', 'ghost', 'dark'];

/**
 * Pill button with a small trailing arrow. Renders a Next <Link> when `href`
 * is given, otherwise a <button>.
 */
export default function Button({
  variant = 'primary',
  arrow = true,
  href,
  size = 'md',
  className = '',
  children,
  type = 'button',
  ...rest
}) {
  const v = VARIANTS.includes(variant) ? variant : 'primary';
  const cls = `${styles.btn} ${styles[v]} ${styles[size] || ''} ${className}`.trim();
  const inner = (
    <>
      <span>{children}</span>
      {arrow && (
        <svg data-arrow className={styles.arrow} width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </>
  );
  if (href) {
    return (
      <Link href={href} className={cls} data-variant={v} {...rest}>
        {inner}
      </Link>
    );
  }
  return (
    <button type={type} className={cls} data-variant={v} {...rest}>
      {inner}
    </button>
  );
}
