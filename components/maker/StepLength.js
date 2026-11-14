import { useState } from 'react';

import Button from '../ui/Button';
import Card from '../ui/Card';
import ErrorNotice from './ErrorNotice';
import StepFooter from './StepFooter';
import styles from './Steps.module.css';

export const LENGTHS = [15, 30, 45, 60, 75];
// Economy stays hidden until it has been tested.
export const QUALITIES = [
  { id: 'standard', label: 'Standard', helper: 'Clean 720p pictures with a narrator. A good place to start.' },
  { id: 'pro_narrated', label: 'Pro narrated', helper: 'Sharper 1080p pictures with a narrator.' },
  { id: 'pro_talking', label: 'Pro talking', helper: 'Sharp 1080p pictures where the characters speak their own lines.' },
];
export const ASPECTS = [
  { id: '9:16', label: 'Vertical 9:16', helper: 'Reels, TikTok, Shorts' },
  { id: '1:1', label: 'Square 1:1', helper: 'Feeds' },
  { id: '16:9', label: 'Wide 16:9', helper: 'YouTube, websites' },
];

/** Pro talking means talking mode and nothing else does; the server enforces the same. */
export const qualityPatch = (quality) => ({ quality, mode: quality === 'pro_talking' ? 'talking' : 'narrated' });

/** Saves each choice as it is made, so the quote bar always matches. */
export default function StepLength({ project, save, onNext, returnTo }) {
  const [seconds, setSeconds] = useState(project?.seconds || 30);
  const [quality, setQuality] = useState(project?.quality || 'standard');
  const [aspect, setAspect] = useState(project?.aspect || '9:16');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  async function choose(patch, apply, revert) {
    apply();
    setSaving(true);
    setError(null);
    try {
      await save(patch);
    } catch (err) {
      revert();
      setError(err);
    } finally {
      setSaving(false);
    }
  }

  const pickSeconds = (n) => choose({ seconds: n }, () => setSeconds(n), () => setSeconds(seconds));
  const pickQuality = (q) => choose(qualityPatch(q), () => setQuality(q), () => setQuality(quality));
  const pickAspect = (a) => choose({ aspect: a }, () => setAspect(a), () => setAspect(aspect));

  return (
    <div className={styles.step}>
      <div className={styles.stepHead}>
        <h2>How <span className="accent-word">long</span> and how sharp?</h2>
        <p>The cost below updates as you choose.</p>
      </div>
      <Card>
        <div className={styles.form}>
          <fieldset className={styles.chips}>
            <legend>Length</legend>
            {LENGTHS.map((n) => (
              <label key={n} className={`${styles.chip} ${seconds === n ? styles.optionOn : ''}`}>
                <input type="radio" name="seconds" value={n} checked={seconds === n} onChange={() => pickSeconds(n)} />
                <span>{n} seconds</span>
              </label>
            ))}
          </fieldset>

          <fieldset className={styles.optionGrid}>
            <legend>Quality</legend>
            {QUALITIES.map((q) => (
              <label key={q.id} className={`${styles.option} ${quality === q.id ? styles.optionOn : ''}`}>
                <input type="radio" name="quality" value={q.id} checked={quality === q.id} onChange={() => pickQuality(q.id)} />
                <span className={styles.optionTitle}>{q.label}</span>
                <span className={styles.optionHelper}>{q.helper}</span>
              </label>
            ))}
          </fieldset>

          <fieldset className={styles.chips}>
            <legend>Shape</legend>
            {ASPECTS.map((a) => (
              <label key={a.id} className={`${styles.chip} ${aspect === a.id ? styles.optionOn : ''}`}>
                <input type="radio" name="aspect" value={a.id} checked={aspect === a.id} onChange={() => pickAspect(a.id)} />
                <span>{a.label}</span>
                <small>{a.helper}</small>
              </label>
            ))}
          </fieldset>

          <p className={styles.saveState} role="status" aria-live="polite">{saving ? 'Saving…' : ''}</p>
          <ErrorNotice error={error} returnTo={returnTo} />
        </div>
      </Card>
      <StepFooter>
        <Button onClick={onNext} disabled={saving}>Continue to the script</Button>
      </StepFooter>
    </div>
  );
}
