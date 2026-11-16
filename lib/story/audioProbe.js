/*
 * Input arguments for ffmpeg when it reads a customer's audio file (an upload we did not make).
 *
 * ffmpeg picks a demuxer from the file's CONTENT, so a file that starts with an ID3 tag but holds an HLS playlist is read
 * as a playlist, and the playlist's file:// segments are followed (a way to read other files on the machine, and a length
 * taken from the playlist). These arguments force the demuxer the extension promised and allow only the plain `file`
 * protocol. Put them before `-i`:
 *
 *   ffmpeg -hide_banner ...audioInputArgs('mp3'), '-i', file ...
 *
 * Every ffmpeg call that reads a customer's audio (the upload probe, render inputs) should use this one helper.
 * A leaf module (no imports).
 */
const DEMUXERS = Object.freeze({ mp3: 'mp3', wav: 'wav', m4a: 'mov' });

/** -> ['-protocol_whitelist', 'file', '-f', <demuxer>] for 'mp3' | 'wav' | 'm4a'. Throws for any other extension. */
export function audioInputArgs(ext) {
  const demuxer = DEMUXERS[String(ext || '').toLowerCase()];
  if (!demuxer) throw new Error(`audioInputArgs: unsupported audio extension "${ext}"`);
  return ['-protocol_whitelist', 'file', '-f', demuxer];
}
