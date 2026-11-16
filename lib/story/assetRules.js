/*
 * What the customer's own pictures, clips and brand text need to be, shared by the server (lib/story/assets.js,
 * pages/api/upload-token.js) and the browser (lib/story/client.js, the brand page, the asset picker), so the screen
 * says no before anything is uploaded and the server says the same words after. Browser safe: no imports.
 *
 * Kinds. The API speaks the customer's words (logo, product, mascot, recording, clip, audio, voice_sample, ...);
 * story_assets.kind and story_project_assets.role keep the database's names. API_TO_DB / DB_TO_API translate.
 */

// 'image' is a neutral picture (a picture-in-picture, a character's own face): never part of the brand kit by default.
export const IMAGE_API_KINDS = Object.freeze(['logo', 'product', 'mascot', 'image']);
export const VIDEO_API_KINDS = Object.freeze(['recording', 'clip']);
export const AUDIO_API_KINDS = Object.freeze(['audio', 'voice_sample', 'voice_track', 'music']);
export const ASSET_API_KINDS = Object.freeze([...IMAGE_API_KINDS, ...VIDEO_API_KINDS, ...AUDIO_API_KINDS]);

const API_TO_DB = Object.freeze({
  logo: 'logo', product: 'product_photo', mascot: 'mascot', image: 'image', recording: 'screen_recording', clip: 'video_clip',
  audio: 'audio', voice_sample: 'voice_sample', voice_track: 'voice_track', music: 'music',
});
const DB_TO_API = Object.freeze({
  logo: 'logo', product_photo: 'product', mascot: 'mascot', image: 'image', screen_recording: 'recording', video_clip: 'clip',
  audio: 'audio', voice_sample: 'voice_sample', voice_track: 'voice_track', music: 'music',
});

/** The database kind for an API kind, else null. */
export const dbKind = (kind) => API_TO_DB[kind] ?? null;
/** The API kind for a database kind (reference videos and anything unknown give null). */
export const apiKind = (kind) => DB_TO_API[kind] ?? null;

// Database kinds by what they are, the same lists lib/story/render.js uses.
export const IMAGE_DB_KINDS = Object.freeze(['logo', 'product_photo', 'mascot', 'image']);
export const VIDEO_DB_KINDS = Object.freeze(['video_clip', 'screen_recording']);

export const ASSET_LIMITS = Object.freeze({
  // 5 MB: the picture check (lib/moderation.js screenImage) cannot read a larger picture, and fails closed on one.
  imageMaxBytes: 5 * 1024 * 1024,
  videoMaxBytes: 200 * 1024 * 1024,
  videoMaxSeconds: 300,
  imageExtensions: Object.freeze(['png', 'jpg', 'jpeg', 'webp']),
  videoExtensions: Object.freeze(['mp4', 'mov']),
});

export const IMAGE_MIME = Object.freeze({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' });
export const VIDEO_MIME = Object.freeze({ mp4: 'video/mp4', mov: 'video/quicktime' });

/** The folder a customer's pictures and clips go to. The token route allows only this prefix for that customer. */
export const brandPrefix = (userId) => `story-brand/${userId}/`;

const extOf = (name) => {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
  return m ? m[1].toLowerCase() : null;
};
/** The extension of a picture file name when it is one we take (lower case, no dot), else null. */
export const imageExtension = (name) => (ASSET_LIMITS.imageExtensions.includes(extOf(name)) ? extOf(name) : null);
/** The extension of a clip file name when it is one we take, else null. */
export const videoExtension = (name) => (ASSET_LIMITS.videoExtensions.includes(extOf(name)) ? extOf(name) : null);

export const ASSET_MESSAGES = Object.freeze({
  kind: 'Say what the file is: a logo, a product picture, a mascot, a picture, a screen recording or a clip.',
  upload: 'We could not find that upload. Upload the file again.',
  wrongImage: 'Only PNG, JPG and WebP pictures can be used.',
  wrongVideo: 'Only MP4 and MOV clips can be used.',
  imageTooBig: 'This picture is larger than 5 MB. Make it smaller and try again.',
  videoTooBig: 'This clip is larger than 200 MB. Trim or compress it and try again.',
  notImage: 'We could not read that file as a picture. Upload a PNG, JPG or WebP file.',
  notVideo: 'We could not read that file as a video. Upload an MP4 or MOV file.',
  tooLong: 'This clip is longer than 5 minutes. Trim it to 5 minutes or less and try again.',
  name: 'Give the file a name of 1 to 120 characters.',
  notFound: 'That file was not found.',
  inUse: 'This file is used in a video. Take it out of the video first, then delete it.',
  footage: 'A footage shot needs one of your own clips or screen recordings.',
  inset: 'A picture-in-picture needs one of your own pictures, clips or screen recordings.',
  castImage: 'Pick one of your own pictures for this character.',
});

export const BRAND_LIMITS = Object.freeze({ offer: 1000, audience: 500, tone: 200, avoidWords: 30, avoidLength: 40, colors: 6 });
export const BRAND_MESSAGES = Object.freeze({
  text: 'That is too long. Shorten it and try again.',
  avoid: 'Use up to 30 words or short phrases to avoid, each 40 characters or fewer.',
  colors: 'Use up to 6 colours, each as a hex value like #1a2b3c.',
  logo: 'Pick one of your own logo pictures.',
});

/** A hex colour as lower case #rrggbb (a short #abc is expanded), else null. */
export function cleanColor(value) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(value ?? '').trim());
  if (!m) return null;
  const hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  return `#${hex.toLowerCase()}`;
}

// A picture-in-picture, in percent of the frame: x and y are where its centre sits, w is its width.
export const INSET_DEFAULT = Object.freeze({ x: 50, y: 30, w: 45 });
export const INSET_RANGE = Object.freeze({ min: 10, max: 90, wMin: 15, wMax: 80 });
