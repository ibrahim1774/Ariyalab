import Button from '../ui/Button';
import styles from './Steps.module.css';

/** True for the server's "this style change remakes things" answer: 409 quote_changed carrying the redo total. */
export const isStyleRedo = (err) => err?.status === 409 && err?.code === 'quote_changed' && Number.isInteger(err?.body?.credits);

/**
 * The plain question before a style change that remakes what is already made (the server refuses it without the total).
 * credits: the redo total; renderCredits: what making the finished video again may cost extra (own line, 0 = nothing to say).
 */
export default function StyleRedoAsk({ credits, renderCredits = 0, busy = false, onChange, onKeep }) {
  return (
    <div className={styles.styleRedo} role="alert" data-testid="style-redo">
      <p>
        Changing the style remakes your characters, pictures and clips.
        {' '}{credits > 0 ? `That costs ${credits} credits in all.` : 'All of it is included.'}
        {renderCredits > 0 ? ` If your finished video was already made, making it again may cost ${renderCredits} credits extra.` : ''}
      </p>
      <div>
        <Button type="button" arrow={false} disabled={busy} onClick={onChange}>Change it</Button>
        {' '}
        <Button type="button" variant="ghost" arrow={false} disabled={busy} onClick={onKeep}>Keep my style</Button>
      </div>
    </div>
  );
}
