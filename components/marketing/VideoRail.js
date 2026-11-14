import manifest from '../../public/examples/manifest.json';
import styles from './VideoRail.module.css';

// Shown until real clips are added to public/examples/manifest.json.
const PLACEHOLDERS = [
  'Physical products',
  'Apps and SaaS',
  'Coaching and courses',
  'Local services',
  'Personal brands',
  'A story with no pitch',
  'Ads and reels',
];

const CENTRE = 3;

function buildCards() {
  if (Array.isArray(manifest) && manifest.length > 0) {
    return manifest.map((m, i) => ({ key: `clip-${i}`, label: m.label, src: m.src, poster: m.poster }));
  }
  return PLACEHOLDERS.map((label, i) => ({ key: `ph-${i}`, label, tone: i % 7 }));
}

function Card({ card, big, dup = false }) {
  return (
    <li className={`${styles.card} ${big ? styles.big : ''}`} aria-hidden={dup ? 'true' : undefined}>
      {card.src ? (
        <video
          className={styles.media}
          src={card.src}
          poster={card.poster}
          muted
          loop
          autoPlay
          playsInline
          preload="metadata"
          aria-label={card.label}
        />
      ) : (
        <div className={`${styles.media} ${styles[`tone${card.tone}`]}`} role="img" aria-label={`${card.label} example`} />
      )}
      <span className={styles.label}>{card.label}</span>
    </li>
  );
}

export default function VideoRail() {
  const cards = buildCards();
  const mid = Math.min(CENTRE, cards.length - 1);
  return (
    <section id="examples" className={styles.rail} data-section="video-rail" aria-label="Example videos">
      <ul className={styles.track}>
        {cards.map((c, i) => <Card key={c.key} card={c} big={i === mid} />)}
        {/* Second copy makes the loop seamless; hidden from assistive tech. */}
        {cards.map((c, i) => <Card key={`dup-${c.key}`} card={c} big={i === mid} dup />)}
      </ul>
    </section>
  );
}
