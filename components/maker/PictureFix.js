import Button from '../ui/Button';

/**
 * The way out when a one-picture character is stuck, now that there is no pick button. Free, and the same pick call the old
 * buttons made (lib/story/cast.js pickCast, which an unfinished sheet or an unsaved pick gets a new sheet from):
 *   - a single picture the server has not picked (its automatic pick missed): "Use this picture";
 *   - the character sheet did not come out: "Try the character sheet again" (it keeps the character the same in every scene).
 * Nothing shows otherwise. onPick(index) makes the call; `className` and `hintClass` come from the screen's own styles.
 */
export default function PictureFix({ cast, disabled = false, onPick, className = '', hintClass = '' }) {
  const options = cast.candidates || [];
  const unpicked = cast.status === 'ready' && options.length === 1 && cast.chosen_index == null && !cast.image_url && !cast.asset_id;
  const sheetFailed = !unpicked && cast.status === 'ready' && cast.sheet_state === 'failed' && !cast.asset_id && (cast.image_url || cast.chosen_index != null);
  if (!unpicked && !sheetFailed) return null;
  return (
    <div className={className} data-picture-fix="">
      <p className={hintClass}>
        {unpicked
          ? `${cast.name}'s picture is ready. Use it to carry on.`
          : `The character sheet did not come out. It keeps ${cast.name} the same in every scene, and trying again is free.`}
      </p>
      <Button variant="ghost" size="sm" arrow={false} disabled={disabled} onClick={() => onPick(unpicked ? 0 : (cast.chosen_index ?? 0))}>
        {unpicked ? 'Use this picture' : 'Try the character sheet again'}
      </Button>
    </div>
  );
}
