import { useRef, useState } from 'react';

import Button from '../ui/Button';
import Card from '../ui/Card';
import StyleRedoAsk, { isStyleRedo, redoFrom } from './StyleRedoAsk';
import ErrorNotice from './ErrorNotice';
import StepFooter from './StepFooter';
import { SIMPLE_LENGTHS } from '../../lib/pricingConstants';
import { QUALITY_INFO, QUALITY_ORDER, outputLine, qualityPatch } from '../../lib/qualityInfo';
import { usePricing } from './PricingContext';
import { estimateCredits } from './steps';
import styles from './Steps.module.css';

export { SIMPLE_LENGTHS };
export const LENGTHS = SIMPLE_LENGTHS;
const lengthLabel = (n) => (n === 120 ? '2 minutes' : `${n} seconds`);
// The cards come from lib/qualityInfo.js (one source for the website, the chat and the connector).
export const QUALITIES = QUALITY_ORDER.map((id) => ({ id, label: QUALITY_INFO[id].name, helper: QUALITY_INFO[id].bestFor }));
export const ASPECTS = [
  { id: '9:16', label: 'Vertical 9:16', helper: 'Reels, TikTok, Shorts' },
  { id: '1:1', label: 'Square 1:1', helper: 'Feeds' },
  { id: '16:9', label: 'Wide 16:9', helper: 'YouTube, websites' },
];

export { qualityPatch };

/** Saves each choice as it is made, so the quote bar always matches. */
export default function StepLength({ project, save, onNext, returnTo }) {
  const [seconds, setSeconds] = useState(project?.seconds || 30);
  const [quality, setQuality] = useState(project?.quality || 'standard');
  const [aspect, setAspect] = useState(project?.aspect || '9:16');
  const pricing = usePricing();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [redo, setRedo] = useState(null); // a quality change that remakes finished clips, waiting for the customer's yes

  // The last choices the server accepted. A failed save puts these back, never the values from the first render.
  const saved = useRef({ seconds, quality, aspect });

  async function choose(key, value, patch, setValue, expected) {
    setValue(value);
    setSaving(true);
    setError(null);
    try {
      await save({ ...patch, ...(Number.isInteger(expected) ? { expected_credits: expected } : {}) });
      saved.current = { ...saved.current, [key]: value };
      setRedo(null);
    } catch (err) {
      if (key === 'quality' && isStyleRedo(err)) {
        // Remaking the finished clips costs credits: the customer sees the total first. The choice stays shown until they answer.
        setRedo({ ...redoFrom(err, expected), choice: value });
      } else {
        setValue(saved.current[key]);
        setError(err);
      }
    } finally {
      setSaving(false);
    }
  }

  const pickSeconds = (n) => choose('seconds', n, { seconds: n }, setSeconds);
  const pickQuality = (q) => choose('quality', q, qualityPatch(q), setQuality);
  const pickAspect = (a) => choose('aspect', a, { aspect: a }, setAspect);

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
                <span>{lengthLabel(n)}</span>
              </label>
            ))}
          </fieldset>

          <fieldset className={styles.optionGrid}>
            <legend>Quality</legend>
            {QUALITY_ORDER.map((id) => {
              const info = QUALITY_INFO[id];
              // The same number the quote bar shows for this quality at this length.
              const credits = estimateCredits({ ...project, seconds, quality: id }, pricing);
              return (
                <label key={id} className={`${styles.option} ${styles.qualityCard} ${quality === id ? styles.optionOn : ''}`} data-quality={id} data-recommended={info.recommended ? '' : undefined}>
                  <input type="radio" name="quality" value={id} aria-label={info.name} checked={quality === id} onChange={() => pickQuality(id)} />
                  <span className={styles.qualityHead}>
                    <span className={styles.optionTitle}>{info.name}</span>
                    {info.recommended && <span className={styles.recommended}>Recommended</span>}
                  </span>
                  <span className={styles.qualityVoice}>{info.voice}</span>
                  <span className={styles.optionHelper}>{info.picture}. {info.included}.</span>
                  <span className={styles.qualityOut}>{outputLine(aspect, seconds)}</span>
                  <strong className={styles.qualityCredits} data-credits="">{credits.toLocaleString()} credits</strong>
                  <small className={styles.qualityModel}>{info.model}</small>
                </label>
              );
            })}
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
          {redo && (
            <StyleRedoAsk
              credits={redo.credits}
              renderCredits={redo.render}
              kind="quality"
              changed={redo.changed}
              busy={saving}
              onChange={() => choose('quality', redo.choice, qualityPatch(redo.choice), setQuality, redo.credits)}
              onKeep={() => { setRedo(null); setQuality(saved.current.quality); }}
            />
          )}
          <ErrorNotice error={error} returnTo={returnTo} />
        </div>
      </Card>
      <StepFooter>
        <Button onClick={onNext} disabled={saving}>Continue to the script</Button>
      </StepFooter>
    </div>
  );
}
