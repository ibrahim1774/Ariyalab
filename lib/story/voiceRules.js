/*
 * What an audio upload and a voice clone need to be, shared by the server
 * (lib/story/voices.js) and the browser (components/maker/StepAudio.js,
 * pages/app/voices.js), so the screen says no before anything is uploaded and
 * the server says the same words after. Browser safe: no imports.
 */

export const AUDIO_LIMITS = Object.freeze({
  maxBytes: 20 * 1024 * 1024,
  // A voice sample: long enough to hear the voice, short enough to be one clean take.
  sampleMinSeconds: 10,
  sampleMaxSeconds: 60,
  extensions: Object.freeze(['mp3', 'wav', 'm4a']),
});

// The customer ticks a box beside exactly this text. The server stores this string (never one the browser sends)
// with the time and the request address, so what is on file is what was on the screen.
export const CONSENT_STATEMENT = 'I confirm that this recording is my own voice, or that the speaker has given me their permission to clone it. The clone is private to my account, and I will not use it to imitate anyone else or to mislead people. I understand the recording is sent to our voice provider, Fish Audio, to make the clone, and that deleting the voice removes it from my account but may not delete the copy Fish Audio keeps.';

export const VOICE_MESSAGES = Object.freeze({
  consent: 'Tick the box to confirm the voice is yours, or that you have the speaker’s permission.',
  name: 'Give the voice a name of 1 to 60 characters.',
  notAudio: 'We could not read that file as audio. Upload an MP3, WAV or M4A file.',
  wrongType: 'Only MP3, WAV and M4A files can be used.',
  tooBig: 'This file is larger than 20 MB. Trim or compress it and try again.',
  upload: 'We could not find that upload. Upload the file again.',
  sample: 'Pick a voice sample you uploaded.',
  sampleGone: 'The sample for this voice is gone. Upload it again and clone a new voice.',
  busy: 'A voice is already being cloned. Wait for it to finish.',
  retryNotAvailable: 'Only a clone that failed can be tried again.',
  pendingDelete: 'This voice is still being cloned. Delete it once it has finished.',
});

/** "Your sample is 9 seconds. Record at least 10 seconds." */
export function sampleLengthMessage(seconds) {
  const s = Math.round(seconds);
  if (seconds < AUDIO_LIMITS.sampleMinSeconds) {
    return `Your sample is ${s} ${s === 1 ? 'second' : 'seconds'}. Record at least ${AUDIO_LIMITS.sampleMinSeconds} seconds of clear speech.`;
  }
  return `Your sample is ${s} seconds. Trim it to ${AUDIO_LIMITS.sampleMaxSeconds} seconds or less.`;
}

/** The extension of an audio file name when it is one we take (lower case, no dot), else null. */
export function audioExtension(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
  const ext = m ? m[1].toLowerCase() : null;
  return AUDIO_LIMITS.extensions.includes(ext) ? ext : null;
}
