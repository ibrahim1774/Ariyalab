import { useState } from 'react';

import Button from '../ui/Button';
import Card from '../ui/Card';
import { STYLES } from '../../lib/story/prompts/styles';
import ErrorNotice from './ErrorNotice';
import StepFooter from './StepFooter';
import StyleRedoAsk, { isStyleRedo, redoFrom } from './StyleRedoAsk';
import { StyleImage } from './Tiles';
import styles from './Steps.module.css';

export default function StepStyle({ project, save, onNext, returnTo }) {
  const [style, setStyle] = useState(project?.style || '');
  const [custom, setCustom] = useState(project?.style_custom || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [redo, setRedo] = useState(null);
  const ready = style && (style !== 'custom' || custom.trim());

  async function submit(e, expected) {
    e?.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await save({ ...(style === 'custom' ? { style, style_custom: custom.trim() } : { style }), ...(Number.isInteger(expected) ? { expected_credits: expected } : {}) });
      setRedo(null);
      onNext?.();
    } catch (err) {
      // Remaking what is made costs credits: the customer sees the total first (the server refuses the change without it).
      if (isStyleRedo(err)) setRedo(redoFrom(err, expected));
      else setError(err);
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
      <form onSubmit={submit} className={styles.step}>
      <Card>
        <div className={styles.form}>
          <fieldset className={styles.styleGrid}>
            <legend className={styles.srOnly}>Style</legend>
            {Object.entries(STYLES).map(([key, s]) => (
              <label key={key} className={`${styles.styleCard} ${style === key ? styles.optionOn : ''}`} data-media-card="">
                <input type="radio" name="style" value={key} checked={style === key} onChange={() => setStyle(key)} />
                <StyleImage styleKey={key} label={s.label} />
                <span className={styles.optionTitle} aria-hidden="true">{s.label}</span>
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
        </div>
      </Card>
      {redo && (
        <StyleRedoAsk
          credits={redo.credits}
          renderCredits={redo.render}
          kind={redo.kind}
          onlyCleared={redo.onlyCleared}
          changed={redo.changed}
          busy={busy}
          onChange={() => submit(null, redo.credits)}
          onKeep={() => { setRedo(null); setStyle(project?.style || ''); setCustom(project?.style_custom || ''); }}
        />
      )}
      <StepFooter>
        <Button type="submit" disabled={!ready || busy}>{busy ? 'Saving…' : 'Continue'}</Button>
      </StepFooter>
      </form>
    </div>
  );
}
