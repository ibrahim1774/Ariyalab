import { useState } from 'react';

import Button from '../ui/Button';
import AssetPicker from './AssetPicker';
import { NeedCredits } from './NeedCredits';
import styles from './LookLike.module.css';

export const LOOK_HELP = "Upload a picture and we'll draw this character to look like it, in your video's style.";
export const LOOK_RIGHTS = 'Only use pictures you have the right to use.';

const priceWords = (n) => (Number(n) === 0 ? 'included' : `${Number(n).toLocaleString()} ${Number(n) === 1 ? 'credit' : 'credits'}`);

/**
 * "Make them look like a picture" (paid). One door, two presses, so nobody is charged by a slip:
 *   1. the button (its price on it) opens the chooser of the customer's own pictures, where a picture can also be uploaded;
 *      picking one only shows it, nothing is charged yet;
 *   2. the picture, an optional note and "Draw <name> like this (<price>)": that press is the one that spends.
 * `price` is the number the server sent (look_credits, from the same code that charges); `onDraw(assetId, note)` makes the
 * request with it as the expected price, and may throw: the picture then stays so the customer can see the error (a changed
 * price is shown by the caller's refresh) and press again.
 */
export default function LookLike({ name, price, disabled = false, busy = false, returnTo, onDraw, kinds = ['image', 'mascot', 'product', 'logo'] }) {
  const [asset, setAsset] = useState(null);
  const [note, setNote] = useState('');
  const [drawing, setDrawing] = useState(false);
  const priced = Number.isInteger(price);
  const label = `Make them look like a picture${priced ? ` (${priceWords(price)})` : ''}`;

  async function draw(e) {
    e?.preventDefault();
    if (!asset || drawing) return;
    setDrawing(true);
    try {
      await onDraw(asset.id, note.trim());
      setAsset(null);
      setNote('');
    } catch {
      // The caller shows the error; the picture stays so the customer can press again.
    } finally {
      setDrawing(false);
    }
  }

  return (
    <div className={styles.look} data-look-like="">
      <AssetPicker
        kinds={kinds}
        uploadKind="image"
        label={label}
        title={`Pick a picture for ${name} to look like`}
        selectedId={asset?.id || null}
        disabled={disabled || drawing}
        returnTo={returnTo}
        onPick={(a) => setAsset(a)}
      />
      <p className={styles.hint}>{LOOK_HELP}</p>
      <p className={styles.hint}>{LOOK_RIGHTS}</p>
      {priced && <NeedCredits items={[{ price }]} />}
      {asset && (
        <form className={styles.confirm} data-testid="look-confirm" onSubmit={draw}>
          <img className={styles.thumb} src={asset.url} alt={`The picture ${name} will look like`} />
          <label className={styles.field}>
            <span>Anything to add? (optional)</span>
            <input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="With a beard." />
          </label>
          <div className={styles.row}>
            <Button type="submit" size="sm" arrow={false} disabled={disabled || busy || drawing}>
              {drawing ? 'Drawing…' : `Draw ${name} like this${priced ? ` (${priceWords(price)})` : ''}`}
            </Button>
            <Button type="button" variant="ghost" size="sm" arrow={false} disabled={drawing} onClick={() => { setAsset(null); setNote(''); }}>Cancel</Button>
          </div>
        </form>
      )}
    </div>
  );
}
