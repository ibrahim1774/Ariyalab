// What each quality level is, in words a customer reads. Client-safe: no imports, so the maker's quality cards,
// the chat and the connector all say the same thing. tests/qualityInfo.test.js checks the picture size and the
// sound flag against QUALITY_MAP (lib/providers/config.js) so the two cannot drift apart.
// Never put prices here: credits come from lib/pricing.js.

export const QUALITY_ORDER = Object.freeze(['economy', 'standard', 'pro_narrated', 'pro_talking']);

export const MUSIC_AND_CAPTIONS = 'Music and captions included';

// Every level's model makes its own sound with the video (QUALITY_MAP sound: true; tests/qualityInfo.test.js).
const SOUND = 'Voice and sound made with the video';

export const QUALITY_INFO = Object.freeze({
  economy: Object.freeze({
    name: 'Budget', voice: SOUND, picture: '720p', model: 'Seedance 2 Mini', bestFor: 'Quick drafts and the lowest cost', recommended: false, included: MUSIC_AND_CAPTIONS,
  }),
  standard: Object.freeze({
    name: 'Standard', voice: SOUND, picture: '1080p', model: 'Gemini Omni 1.2 Flash', bestFor: 'Most videos', recommended: true, included: MUSIC_AND_CAPTIONS,
  }),
  pro_narrated: Object.freeze({
    name: 'Pro', voice: SOUND, picture: '720p', model: 'Kling 3.0', bestFor: 'Sharper pictures for ads and posts', recommended: false, included: MUSIC_AND_CAPTIONS,
  }),
  pro_talking: Object.freeze({
    name: 'Pro Max', voice: SOUND, picture: '1080p', model: 'Kling 3.0 Pro', bestFor: 'Stories where the people talk', recommended: false, included: MUSIC_AND_CAPTIONS,
  }),
});

/** "MP4, 9:16, about 30 seconds" (and "about 2 minutes" for 120). */
export function outputLine(aspect, seconds) {
  const n = Number(seconds) || 30;
  const length = n === 120 ? '2 minutes' : `${n} seconds`;
  return `MP4, ${aspect || '9:16'}, about ${length}`;
}

/** Pro talking means talking mode and nothing else does; the server enforces the same (lib/story/projects.js). */
export const qualityPatch = (quality) => ({ quality, mode: quality === 'pro_talking' ? 'talking' : 'narrated' });
