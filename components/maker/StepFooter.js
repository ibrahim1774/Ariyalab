import styles from './Steps.module.css';

/** The step's primary actions, pinned to the bottom of the viewport so they are always in reach (and clear of the home bar on a phone). */
export default function StepFooter({ children }) {
  return <div className={styles.footer}>{children}</div>;
}
