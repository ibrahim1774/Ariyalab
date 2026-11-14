import { useState } from 'react';

import Button from '../ui/Button';
import Card from '../ui/Card';
import ErrorNotice from './ErrorNotice';
import styles from './Steps.module.css';

export const PURPOSES = [
  { id: 'product', label: 'A product', helper: 'Something people can buy and hold.' },
  { id: 'app', label: 'An app or software', helper: 'A tool people sign up for or download.' },
  { id: 'coaching', label: 'Coaching or a course', helper: 'Teaching, training or guidance.' },
  { id: 'service', label: 'A local service', helper: 'Work you do for people nearby.' },
  { id: 'personal_brand', label: 'A personal brand', helper: 'You, your voice and what you stand for.' },
  { id: 'story', label: 'Just a story', helper: 'A tale for its own sake, with nothing to sell.' },
];

export default function StepPurpose({ project, save, onNext, returnTo }) {
  const [purpose, setPurpose] = useState(project?.purpose || '');
  const [offer, setOffer] = useState(project?.offer || '');
  const [audience, setAudience] = useState(project?.audience || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const isStory = purpose === 'story';

  async function submit(e) {
    e.preventDefault();
    if (!purpose || busy) return;
    setBusy(true);
    setError(null);
    try {
      const patch = { purpose };
      if (!isStory) {
        patch.offer = offer.trim() || null;
        patch.audience = audience.trim() || null;
      }
      await save(patch);
      onNext?.();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.step}>
      <div className={styles.stepHead}>
        <h2>What is this video <span className="accent-word">for</span>?</h2>
        <p>This helps the script fit your goal without feeling like an ad.</p>
      </div>
      <Card>
        <form onSubmit={submit} className={styles.form}>
          <fieldset className={styles.optionGrid}>
            <legend className={styles.srOnly}>Purpose of the video</legend>
            {PURPOSES.map((p) => (
              <label key={p.id} className={`${styles.option} ${purpose === p.id ? styles.optionOn : ''}`}>
                <input type="radio" name="purpose" value={p.id} checked={purpose === p.id} onChange={() => setPurpose(p.id)} />
                <span className={styles.optionTitle}>{p.label}</span>
                <span className={styles.optionHelper}>{p.helper}</span>
              </label>
            ))}
          </fieldset>
          {purpose && !isStory && (
            <>
              <label className={styles.field}>
                <span>What are you offering?</span>
                <textarea rows={3} maxLength={1000} value={offer} onChange={(e) => setOffer(e.target.value)} placeholder="One or two sentences." />
                <ErrorNotice error={error} field="offer" returnTo={returnTo} />
              </label>
              <label className={styles.field}>
                <span>Who is it for?</span>
                <input maxLength={500} value={audience} onChange={(e) => setAudience(e.target.value)} placeholder="For example, busy parents who cook at home." />
                <ErrorNotice error={error} field="audience" returnTo={returnTo} />
              </label>
            </>
          )}
          <ErrorNotice error={error} field={null} returnTo={returnTo} />
          <div className={styles.actions}>
            <Button type="submit" disabled={!purpose || busy}>{busy ? 'Saving…' : 'Continue'}</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
