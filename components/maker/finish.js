// Pure helpers for the Finish screen and the project cards. No React.

export { downloadFilename } from '../../lib/story/filenames.js';

/**
 * The render URL asking the file host for an attachment. Blob URLs are cross-origin, so the `download` attribute alone
 * is ignored there; `?download=1` makes the host send Content-Disposition: attachment. The file never passes through us.
 */
export function downloadHref(url) {
  if (!url || typeof url !== 'string') return '';
  return `${url}${url.includes('?') ? '&' : '?'}download=1`;
}

/** True when the project's files are gone or due to be: the server's status, or a files_expire_at in the past. */
export function filesExpired(project, now = Date.now()) {
  if (project?.status === 'expired') return true;
  const t = project?.files_expire_at ? new Date(project.files_expire_at).getTime() : NaN;
  return Number.isFinite(t) && t <= now;
}

export const renderActive = (render) => render?.status === 'queued' || render?.status === 'running';

/** 0:05, 1:30 */
export function clock(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
