import Link from 'next/link';

import Card from '../ui/Card';
import Pill from '../ui/Pill';
import styles from './ProjectCard.module.css';

const BADGES = {
  draft: { label: 'Draft', tone: 'neutral' },
  generating: { label: 'Generating', tone: 'accent' },
  finished: { label: 'Finished', tone: 'success' },
  failed: { label: 'Needs attention', tone: 'neutral' },
};

/** Badge key for a project: an explicit status wins, otherwise it follows the step. */
export function projectStatus(project) {
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

export default function ProjectCard({ project }) {
  const status = projectStatus(project);
  const badge = BADGES[status];
  const title = project.title || 'Untitled story';
  return (
    <Link href={`/app/projects/${project.id}`} className={styles.link} aria-label={`Open ${title}`}>
      <Card className={styles.card} padded={false}>
        <div className={styles.cover} aria-hidden="true">
          {project.cover_url ? <img src={project.cover_url} alt="" /> : <span className={styles.coverMark}>{title.slice(0, 1).toUpperCase()}</span>}
        </div>
        <div className={styles.body}>
          <h3 className={styles.title}>{title}</h3>
          <div className={styles.meta}>
            <Pill tone={badge.tone} className={status === 'failed' ? styles.failed : ''} data-status={status}>
              {badge.label}
            </Pill>
            <span className={styles.date}>{updatedLabel(project.updated_at)}</span>
          </div>
        </div>
      </Card>
    </Link>
  );
}
