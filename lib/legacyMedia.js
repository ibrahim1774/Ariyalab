import { open } from 'node:fs/promises';

import { ProviderError } from './providers/errors.js';
import { downloadToFile } from './providers/http.js';
import { matchesMagic } from './providers/storage.js';
import { customerVideoArgs } from './story/mediaArgs.js';

/*
 * Hardening for the legacy video routes (/api/extract-frame, /api/extract-last-frame, /api/concat-videos), which
 * take a video URL from any signed-in account (final review I4):
 *   - the download goes through the guarded fetch in lib/providers/http.js (no private, loopback or metadata
 *     addresses, every redirect re-checked, the connection pinned to checked addresses) with a byte cap and a timeout;
 *   - the file must start like an mp4/mov (`ftyp` at offset 4), so a playlist or concat list is never handed to ffmpeg;
 *   - ffmpeg opens it with the file protocol only and the mov demuxer forced (legacyVideoInputArgs before each -i).
 * Behaviour is otherwise unchanged.
 */

export const LEGACY_VIDEO_MAX_BYTES = 200 * 1024 * 1024;
// The routes run for at most 60 s; the downloads (in parallel for concat) must leave time for ffmpeg and the upload.
export const LEGACY_DOWNLOAD_TIMEOUT_MS = 30_000;

/** A refusal the customer can act on: the routes answer 400 with its message. */
export class LegacyMediaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LegacyMediaError';
    this.status = 400;
  }
}

async function readHead(file) {
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(16);
    const { bytesRead } = await fh.read(buf, 0, 16, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/**
 * Downloads an untrusted video URL to `dest`, guarded and capped, and checks it is an mp4/mov.
 * Throws LegacyMediaError for a link or file the customer must change; other errors propagate.
 */
export async function downloadLegacyVideo(url, dest, { maxBytes = LEGACY_VIDEO_MAX_BYTES, timeoutMs = LEGACY_DOWNLOAD_TIMEOUT_MS } = {}) {
  try {
    await downloadToFile(url, { dest, maxBytes, provider: 'legacy', timeoutMs });
  } catch (err) {
    // The guard's own refusals (private address, bad link, too large) carry a message meant for the customer.
    if (err instanceof ProviderError && err.code === 'failed' && !err.cause) throw new LegacyMediaError(err.message);
    throw err;
  }
  if (!matchesMagic('video/mp4', await readHead(dest))) {
    throw new LegacyMediaError("That file isn't an MP4 or MOV video.");
  }
}

/** ['-protocol_whitelist', 'file', '-f', 'mov']: put before every -i of a downloaded video. */
export const legacyVideoInputArgs = customerVideoArgs;
