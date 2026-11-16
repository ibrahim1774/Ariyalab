// File names made from a project title. Pure; used by the UI download link and by the render when it stores the file,
// so the name a customer's browser saves (a Blob host names the download after the stored file) is the title-based one.

const MAX_NAME = 60;

/** Letters and digits joined by hyphens, at most 60 characters, never empty. */
export function titleSlug(title) {
  const base = String(title ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_NAME)
    .replace(/-+$/g, '');
  return base || 'my-video';
}

export const downloadFilename = (title) => `${titleSlug(title)}.mp4`;

/** The stored file's name for a render: title slug plus version. */
export const renderFilename = (title, version) => `${titleSlug(title)}-v${version}.mp4`;
