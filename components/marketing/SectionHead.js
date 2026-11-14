import styles from './Section.module.css';

export default function SectionHead({ eyebrow, title, lede }) {
  return (
    <div className={styles.head}>
      <p className={styles.eyebrow}>{eyebrow}</p>
      <h2 className={styles.title}>{title}</h2>
      {lede && <p className={styles.lede}>{lede}</p>}
    </div>
  );
}
