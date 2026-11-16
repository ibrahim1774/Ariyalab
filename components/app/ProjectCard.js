import { useState } from 'react';
import Link from 'next/link';
import Router from 'next/router';

import Button from '../ui/Button';
import Card from '../ui/Card';
import Modal from '../ui/Modal';
import Pill from '../ui/Pill';
import { downloadFilename, downloadHref, filesExpired } from '../maker/finish';
import { formatDate } from '../maker/steps';
import { deleteProject, duplicateProject } from '../../lib/story/client';
import { STYLES } from '../../lib/story/prompts/styles';
import styles from './ProjectCard.module.css';

const BADGES = {
  draft: { label: 'Draft', tone: 'neutral' },
  generating: { label: 'Generating', tone: 'accent' },
  finished: { label: 'Finished', tone: 'success' },
  failed: { label: 'Needs attention', tone: 'neutral' },
  expired: { label: 'Files removed', tone: 'neutral' },
};

/** Badge key for a project: an explicit status wins, otherwise it follows the step. */
export function projectStatus(project) {
  // Files past their date are gone (or about to be) whether or not the clean-up has marked the project yet.
  if (filesExpired(project)) return 'expired';
  if (project?.status && BADGES[project.status]) return project.status;
  if (project?.step === 'done') return 'finished';
  if (project?.step === 'generate') return 'generating';
  return 'draft';
}

function updatedLabel(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return `Edited ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

/** First ready still, else the chosen style's sample image, else a labelled tile. Never a letter on a flat colour. */
export function thumbnailFor(project) {
  const still = project?.thumbnail_url || project?.cover_url;
  if (still) return still;
  return project?.style && STYLES[project.style] && project.style !== 'custom' ? `/styles/${project.style}.jpg` : null;
}

/** Why an action failed, in the server's words when it gave some. */
const reason = (err) => err?.serverMessage || 'Something went wrong. Please try again.';

export default function ProjectCard({ project, onDeleted }) {
  const [broken, setBroken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const src = broken ? null : thumbnailFor(project);
  const styleLabel = STYLES[project?.style]?.label || 'Animated story';
  const status = projectStatus(project);
  const badge = BADGES[status];
  const title = project.title || 'Untitled story';
  const expired = status === 'expired';
  const expires = formatDate(project.files_expire_at);
  const download = !expired && project.latest_render_url ? downloadHref(project.latest_render_url) : '';

  const copy = async () => {
    setBusy(true);
    setNote('');
    try {
      const made = await duplicateProject(project.id);
      Router.push(`/app/p/${made.id}`);
    } catch (err) {
      setNote(reason(err));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    setDeleteError('');
    try {
      await deleteProject(project.id);
      setConfirming(false);
      onDeleted?.(project.id);
    } catch (err) {
      setDeleteError(reason(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className={styles.card} padded={false} data-project={project.id}>
      <Link href={`/app/p/${project.id}`} className={styles.link} aria-label={`Open ${title}`}>
        <div className={styles.cover} aria-hidden="true">
          {src ? (
            <img src={src} alt="" loading="lazy" onError={() => setBroken(true)} />
          ) : (
            <span className={styles.coverTile} data-tile="cover">{styleLabel}</span>
          )}
          {expired && <span className={styles.coverNote}>Files removed</span>}
        </div>
        <div className={styles.body}>
          <h3 className={styles.title}>{title}</h3>
          <div className={styles.meta}>
            <Pill tone={badge.tone} className={status === 'failed' ? styles.failed : ''} data-status={status}>
              {badge.label}
            </Pill>
            <span className={styles.date}>{updatedLabel(project.updated_at)}</span>
          </div>
          {expires && !expired && <p className={styles.expires} data-testid="card-files-note">Files are removed on {expires}</p>}
        </div>
      </Link>
      <div className={styles.actions}>
          {download && (
            <a className={styles.action} href={download} download={downloadFilename(project.title)}>Download</a>
          )}
          <button type="button" className={styles.action} onClick={copy} disabled={busy}>Duplicate</button>
          <button type="button" className={`${styles.action} ${styles.danger}`} onClick={() => { setDeleteError(''); setConfirming(true); }} disabled={busy}>Delete</button>
          {note && <p className={styles.note} role="alert">{note}</p>}
      </div>
      <Modal
        open={confirming}
        onClose={() => !busy && setConfirming(false)}
        title="Delete this video?"
        footer={(
          <>
            <Button variant="ghost" arrow={false} onClick={() => setConfirming(false)} disabled={busy}>Keep it</Button>
            <Button arrow={false} onClick={remove} disabled={busy}>Delete video</Button>
          </>
        )}
      >
        <p>“{title}” and everything in it (script, cast, shots and finished videos) will be deleted. This cannot be undone.</p>
        {deleteError && <p role="alert" className={styles.note}>{deleteError}</p>}
      </Modal>
    </Card>
  );
}
