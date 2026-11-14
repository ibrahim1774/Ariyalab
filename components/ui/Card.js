import styles from './Card.module.css';

/** Soft white card. `tone="dark"` is the highlighted (e.g. most popular) variant. */
export default function Card({ as: Tag = 'div', tone = 'light', padded = true, className = '', children, ...rest }) {
  const cls = [styles.card, tone === 'dark' ? styles.dark : '', padded ? styles.padded : '', className]
    .filter(Boolean)
    .join(' ');
  return (
    <Tag className={cls} data-tone={tone} {...rest}>
      {children}
    </Tag>
  );
}
