import { useState } from 'react';

import Button from '../ui/Button';
import Modal from '../ui/Modal';
import { buildShots, setPlanRequested } from '../../lib/story/client';

/**
 * "Update the storyboard": the existing rebuild call, with its confirm when finished clips would be replaced (the 409
 * rebuild_loses_clips token). A rebuild is the customer's press on the plan, so it sets the plan marker: the pictures the
 * rebuild leaves to make then follow by themselves (free ones) or as a priced question. -> { run, busy, error, ask, cancel }
 */
export default function useRebuild({ projectId, refresh }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [ask, setAsk] = useState(null); // { count, own, token }

  async function run(confirm) {
    setBusy(true);
    setError(null);
    try {
      await (confirm ? buildShots(projectId, { confirm }) : buildShots(projectId));
      setAsk(null);
      await Promise.resolve(setPlanRequested(projectId, true)).catch(() => {});
      await refresh?.();
    } catch (err) {
      if (err?.code === 'rebuild_loses_clips') setAsk({ count: Number(err.body?.count) || 0, own: Number(err.body?.own) || 0, token: err.body?.token || null });
      else {
        setError(err);
        if (err?.status === 409) await refresh?.();
      }
    } finally {
      setBusy(false);
    }
  }
  return { run, busy, error, ask, cancel: () => setAsk(null) };
}

export function RebuildDialog({ rebuild }) {
  const { ask, busy } = rebuild;
  return (
    <Modal
      open={ask !== null}
      onClose={rebuild.cancel}
      title="Update the storyboard?"
      footer={(
        <>
          <Button variant="ghost" arrow={false} onClick={rebuild.cancel}>Cancel</Button>
          <Button arrow={false} disabled={busy} onClick={() => rebuild.run(ask?.token)}>Rebuild anyway</Button>
        </>
      )}
    >
      <p>
        This replaces {[
          ask?.count > 0 ? `${ask.count} finished ${ask.count === 1 ? 'clip' : 'clips'}` : null,
          ask?.own > 0 ? `${ask.own} ${ask.own === 1 ? 'shot' : 'shots'} with your own footage or picture-in-picture` : null,
        ].filter(Boolean).join(' and ')}. You can make them again after, and each price shows first. Rebuild anyway?
      </p>
    </Modal>
  );
}
