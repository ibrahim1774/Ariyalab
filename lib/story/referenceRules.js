/*
 * What a reference video must be, shared by the server (lib/story/analyze.js)
 * and the browser (components/maker/StepReference.js), so the screen can say
 * no before anything is uploaded and the server says the same words after.
 * Browser safe: no imports.
 */

export const REFERENCE_LIMITS = Object.freeze({
  maxSeconds: 180,
  maxBytes: 100 * 1024 * 1024,
});

// Exact hosts, each also with www. and m. (spec 7.3; controller ruling for Task 22).
export const LINK_HOSTS = Object.freeze(['instagram.com', 'tiktok.com', 'facebook.com', 'fb.watch']);
// TikTok share links, exactly these hosts (no www. or m.). The download resolves them through the guarded redirect
// fetch and checks the final host again (lib/providers/fetchVideo.js). Round 1 ruling.
export const SHARE_HOSTS = Object.freeze(['vm.tiktok.com', 'vt.tiktok.com']);
// Upload types: MP4 and QuickTime (phones record .mov). Both start with an ISO "ftyp" box.
export const VIDEO_TYPES = Object.freeze(['video/mp4', 'video/quicktime']);
export const VIDEO_EXTENSION = /\.(mp4|mov)$/i;

export const RIGHTS_STATEMENT = 'I have the right to use this video for inspiration. Only its structure is used: none of its footage, words or characters are copied.';

export const REFERENCE_MESSAGES = Object.freeze({
  link: 'We can only use Instagram, TikTok and Facebook links. Upload the file instead.',
  tooLong: 'This video is longer than 3 minutes. Trim it to 3 minutes or less and try again.',
  tooBig: 'This file is larger than 100 MB. Trim or compress it and try again.',
  notVideo: 'We could not read that file as a video. Upload an MP4 or MOV file.',
  rights: 'Tick the box to confirm you may use this video for inspiration.',
  source: 'Upload a video or paste a link to start from.',
  upload: 'We could not find that upload. Upload the file again.',
  linkUnavailable: 'Pasting a link is not available right now. Upload the video file instead.',
});

/** The link's host if it is one we fetch from, else null. Only http(s), no user info, no port tricks. */
export function referenceLinkHost(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase().replace(/\.+$/, '');
  if (SHARE_HOSTS.includes(host)) return host;
  const bare = host.replace(/^(www|m)\./, '');
  return LINK_HOSTS.includes(bare) ? host : null;
}

export const isAllowedReferenceLink = (raw) => referenceLinkHost(raw) !== null;
