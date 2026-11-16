/*
 * Input arguments for ffmpeg when it reads a customer's picture or clip (an upload we did not make). Put them before `-i`.
 *
 * ffmpeg picks a demuxer from a file's CONTENT, so a playlist saved as `inset.png` is read as a playlist and its
 * file:// entries are followed. These arguments force the demuxer the file's type promised and allow only the plain
 * `file` protocol; a file that is not that format fails to open. The same helpers serve the upload probe
 * (lib/story/assets.js) and the render (lib/story/render.js). A leaf module (no imports).
 */
const FILE_ONLY = ['-protocol_whitelist', 'file'];
// The image2 demuxer with the decoder named (not guessed from the content), the one `-loop 1` works with: the *_pipe
// demuxers hang a render that loops them.
const IMAGE_CODECS = Object.freeze({ 'image/png': 'png', 'image/jpeg': 'mjpeg', 'image/webp': 'webp' });
const EXT_MIME = Object.freeze({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' });

/** The image mime for a stored mime or, failing that, the extension of a file name or URL; null when it is neither. */
export function imageMime(mime, nameOrUrl) {
  const m = String(mime || '').toLowerCase();
  if (IMAGE_CODECS[m]) return m;
  const ext = /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(String(nameOrUrl || ''));
  return (ext && EXT_MIME[ext[1].toLowerCase()]) || null;
}

/** -> ['-protocol_whitelist', 'file', '-f', 'image2', '-pattern_type', 'none', '-c:v', 'png' | 'mjpeg' | 'webp']. Throws for anything else. */
export function imageInputArgs(mime) {
  const codec = IMAGE_CODECS[String(mime || '').toLowerCase()];
  if (!codec) throw new Error(`imageInputArgs: unsupported image type "${mime}"`);
  return [...FILE_ONLY, '-f', 'image2', '-pattern_type', 'none', '-c:v', codec];
}

/** -> ['-protocol_whitelist', 'file', '-f', 'mov'] for a customer's mp4 or mov. */
export const customerVideoArgs = () => [...FILE_ONLY, '-f', 'mov'];
