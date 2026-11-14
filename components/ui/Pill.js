import styles from './Pill.module.css';

/** Small rounded label. tone: neutral | accent | success | dark. */
export default function Pill({ tone = 'neutral', dot = false, className = '', children, ...rest }) {
  return (
    <span className={`${styles.pill} ${styles[tone] || ''} ${className}`.trim()} data-tone={tone} {...rest}>
      {dot && <span className={styles.dot} aria-hidden="true" />}
      {children}
    </span>
  );
}
