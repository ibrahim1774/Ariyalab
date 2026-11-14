import Button from '../ui/Button';
import useReveal from './useReveal';
import useStartHref from './useStartHref';
import section from './Section.module.css';
import styles from './ClosingCta.module.css';

export default function ClosingCta() {
  const ref = useReveal();
  const startHref = useStartHref();
  return (
    <section ref={ref} className={section.section} data-section="closing-cta">
      <div className={styles.card}>
        <h2 className={styles.title}>Ready to make your <em className="accent-word">first</em> video?</h2>
        <p className={styles.sub}>Describe your story and see a storyboard before you spend anything on generation.</p>
        <Button href={startHref} size="lg">Make your first video</Button>
      </div>
    </section>
  );
}
