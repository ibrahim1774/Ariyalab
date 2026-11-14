import { useState } from 'react';

import Button from '../ui/Button';
import Card from '../ui/Card';
import { STYLES } from '../../lib/story/prompts/styles';
import ErrorNotice from './ErrorNotice';
import styles from './Steps.module.css';

// Sample images do not exist yet, so each style gets a gradient placeholder.
const PLACEHOLDER = {
  '3d_family': 'linear-gradient(135deg, #FFD6A5, #F08A4B)',
  '2d_cartoon': 'linear-gradient(135deg, #FFE08A, #FF9F6B)',
  anime: 'linear-gradient(135deg, #C9D6FF, #E2C2FF)',
  clay: 'linear-gradient(135deg, #F4C7A8, #D98F6A)',
  comic: 'linear-gradient(135deg, #FFF1A8, #FF8A7A)',
  flat_motion: 'linear-gradient(135deg, #BDE8D2, #7BC4A4)',
  watercolor: 'linear-gradient(135deg, #CFE7F5, #F6D6E4)',
  custom: 'linear-gradient(135deg, #EDE6D6, #FBF8F1)',
};

export default function StepStyle({ project, save, onNext, returnTo }) {
  const [style, setStyle] = useState(project?.style || '');
  const [custom, setCustom] = useState(project?.style_custom || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const ready = style && (style !== 'custom' || custom.trim());

  async function submit(e) {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await save(style === 'custom' ? { style, style_custom: custom.trim() } : { style });
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
        <h2>Pick the <span className="accent-word">look</span></h2>
        <p>Every picture in your video will follow this style.</p>
      </div>
      <Card>
        <form onSubmit={submit} className={styles.form}>
          <fieldset className={styles.styleGrid}>
            <legend className={styles.srOnly}>Style</legend>
            {Object.entries(STYLES).map(([key, s]) => (
              <label key={key} className={`${styles.styleCard} ${style === key ? styles.optionOn : ''}`}>
                <input type="radio" name="style" value={key} checked={style === key} onChange={() => setStyle(key)} />
                <span className={styles.stylePreview} style={{ background: PLACEHOLDER[key] }} aria-hidden="true" />
                <span className={styles.optionTitle}>{s.label}</span>
              </label>
            ))}
          </fieldset>
          {style === 'custom' && (
            <label className={styles.field}>
              <span>Describe your style</span>
              <textarea rows={2} maxLength={300} value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="Soft paper shapes in warm colours." />
              <ErrorNotice error={error} field="style_custom" returnTo={returnTo} />
            </label>
          )}
          <ErrorNotice error={error} field={null} returnTo={returnTo} />
          <div className={styles.actions}>
            <Button type="submit" disabled={!ready || busy}>{busy ? 'Saving…' : 'Continue'}</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
