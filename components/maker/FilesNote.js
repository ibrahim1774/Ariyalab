import { formatDate } from './steps';
import styles from './Steps.module.css';

/** Spec 10.10: wherever files are shown, say when they go. Only from project.files_expire_at, never worked out here. */
export default function FilesNote({ project }) {
  const date = formatDate(project?.files_expire_at);
  if (!date) return null;
  return (
    <p className={styles.filesNote} data-testid="files-note">
      Files are removed on {date}. Download what you want to keep before then.
    </p>
  );
}
