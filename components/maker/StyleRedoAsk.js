import { useEffect, useRef } from 'react';

import Button from '../ui/Button';
import styles from './Steps.module.css';

/** True for the server's "this change remakes things" answer: 409 quote_changed carrying the redo total. */
export const isStyleRedo = (err) => err?.status === 409 && err?.code === 'quote_changed' && Number.isInteger(err?.body?.credits);

/** The shape the ask is shown from, read from the 409 body. `previous`: the total the customer had been shown (a different one says the price changed). */
export const redoFrom = (err, previous = null) => ({
  credits: err.body.credits,
  render: Number(err.body.render_credits) || 0,
  kind: err.body.kind === 'quality' ? 'quality' : 'style',
  onlyCleared: err.body.only_cleared === true,
  changed: Number.isInteger(previous) && previous !== err.body.credits,
});

/**
 * The plain question before a style or quality change that remakes what is already made (the server refuses it without the total).
 * credits: the redo total; renderCredits: what making the finished video again may cost extra (own line, 0 = nothing to say);
 * kind: 'style' | 'quality'; what: the words for what is being changed when both are ('style and quality'); onlyCleared: only old character pictures exist, they are cleared and nothing is remade now;
 * changed: the total moved since the customer last saw it (said first, and the ask takes focus).
 */
export default function StyleRedoAsk({ credits, renderCredits = 0, kind = 'style', what = null, onlyCleared = false, changed = false, busy = false, onChange, onKeep }) {
  const ref = useRef(null);
  useEffect(() => { if (changed) ref.current?.focus(); }, [changed, credits]);
  const sentence = onlyCleared
    ? 'Your old character pictures are cleared. Nothing is remade now.'
    : `Changing the ${what || kind} remakes your ${kind === 'quality' ? 'clips' : 'characters, pictures and clips'}. ${credits > 0 ? `That costs ${credits} credits in all.` : 'All of it is included.'}`;
  return (
    <div className={styles.styleRedo} role="alert" data-testid="style-redo" tabIndex={-1} ref={ref}>
      <p>
        {changed ? 'The price changed. ' : ''}{sentence}
        {!onlyCleared && renderCredits > 0 ? ` If your finished video was already made, making it again may cost ${renderCredits} credits extra.` : ''}
      </p>
      <div>
        <Button type="button" arrow={false} disabled={busy} onClick={onChange}>Change it</Button>
        {' '}
        <Button type="button" variant="ghost" arrow={false} disabled={busy} onClick={onKeep}>{kind === 'quality' ? 'Keep my quality' : 'Keep my style'}</Button>
      </div>
    </div>
  );
}
