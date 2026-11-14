import Button from '../ui/Button';
import Pill from '../ui/Pill';
import useStartHref from './useStartHref';
import styles from './Hero.module.css';

export default function Hero() {
  const startHref = useStartHref();
  const count = process.env.NEXT_PUBLIC_VIDEOS_THIS_WEEK;
  const counter = count ? `${count} videos made this week` : 'Made for ads, reels and shorts';

  return (
    <section className={styles.hero} data-section="hero">
      <div className={styles.glow} aria-hidden="true" />
      <div className={styles.inner}>
        <Pill dot className={styles.counter}>{counter}</Pill>
        <h1 className={styles.title}>
          Animated story videos for <em className="accent-word">anything</em> you sell
        </h1>
        <p className={styles.sub}>
          Describe your story or start from a video you like. Get a finished, captioned video in minutes.
        </p>
        <div className={styles.actions}>
          <Button href={startHref} size="lg">Make your first video</Button>
          <Button href="#examples" variant="ghost" size="lg">See examples</Button>
        </div>
      </div>
    </section>
  );
}
