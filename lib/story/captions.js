import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';

/*
 * Burned-in captions for the finished video (Task 20). Pure functions, except
 * captionFilterAvailable, which asks the ffmpeg binary what it can do.
 *
 *   buildCaptionEvents({ words, cuts, style, width, height, format })
 *     words   [{ w, start, end, stretch? }]  seconds on the final timeline
 *     cuts    [seconds]                      shot boundaries (never crossed by a caption)
 *     style   'serif_accent' | 'bold_pop' | 'clean'   (the audio plan's captions.style)
 *     format  'ass' (default) when ffmpeg has the ass/subtitles filter, anything else gives no file
 *     -> { format: 'ass'|'none', events: [{ start, end, text, words }], ass: string|null }
 *
 * Rules:
 *   - Each word belongs to the shot holding its middle and is clipped to that
 *     shot, so no word, and so no caption, crosses a cut.
 *   - A speech stretch is a run of words with no cut between them, gaps under
 *     STRETCH_GAP_SECONDS, and the same `stretch` tag (one narration line or one
 *     shot line). Inside a stretch the words are re-timed by syllable count with
 *     MIN_WORD_SECONDS each, keeping the stretch's start and end. A stretch too
 *     short for the minimum keeps its length and shares it evenly.
 *   - A caption is at most MAX_PHRASE_WORDS words from one stretch; a stretch is
 *     split into phrases of balanced size.
 *   - `end` (the video's length): words at or past it are dropped and the last
 *     caption is clipped to it.
 *   - The accent colour follows the spoken word: an accented style writes one
 *     ASS line per word of the phrase (same text, accent moved to that word).
 *   - A word wider than the frame less its margins shrinks that caption's font.
 *   - Position: centred at y 1250 on 1080x1920, scaled by height for other
 *     frames, and moved so a two-line caption box stays inside y 285 to 1635
 *     (scaled the same way).
 *
 * Fonts: every style uses the one bundled font (public/fonts, licence in
 * scripts/make-caption-font.md), passed to libass with fontsdir, because a
 * server has no system fonts to fall back to. Styles differ by size, weight,
 * outline, case and accent colour.
 */

export const MIN_WORD_SECONDS = 0.42;
export const MAX_PHRASE_WORDS = 4;
export const STRETCH_GAP_SECONDS = 0.3;
export const CAPTION_FONT = 'DM Serif Display';
export const CAPTION_FONT_FILE = 'DMSerifDisplay-Regular.ttf';
// On a 1080x1920 frame. Scaled by height / 1920 for other frames.
export const SAFE_BAND = Object.freeze({ width: 1080, height: 1920, top: 285, bottom: 1635, centre: 1250 });
// Room kept for a caption that wraps onto a second line.
const LINES_RESERVED = 2;
const LINE_HEIGHT = 1.3;

// Colours are ASS &HAABBGGRR (alpha 00 = opaque).
const STYLES = Object.freeze({
  serif_accent: { size: 84, bold: 0, outline: 4, shadow: 2, upper: false, primary: '&H00FFFFFF', outlineColour: '&H00201A14', back: '&H64000000', accent: '&H0040C8FF' },
  bold_pop: { size: 92, bold: -1, outline: 7, shadow: 0, upper: true, primary: '&H00FFFFFF', outlineColour: '&H00000000', back: '&H00000000', accent: '&H0000E5FF' },
  clean: { size: 68, bold: 0, outline: 2, shadow: 1, upper: false, primary: '&H00FFFFFF', outlineColour: '&H00000000', back: '&H50000000', accent: null },
});

const styleOf = (style) => STYLES[style] || STYLES.serif_accent;
const round6 = (n) => Math.round(n * 1e6) / 1e6;

// ---------------------------------------------------------------- syllables and timing

/** A vowel-group count, at least 1 per word (English heuristic, good enough for timing). */
export function countSyllables(word) {
  const w = String(word || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 1;
  if (w.length <= 3) return 1;
  const trimmed = w.replace(/(?:[^laeiouy]es|[^laeiouy]ed|[^laeiouy]e)$/, '').replace(/^y/, '');
  const groups = trimmed.match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups ? groups.length : 1);
}

/**
 * Re-times one speech stretch by syllable count. The first word keeps its
 * start and the last its end; every word gets at least MIN_WORD_SECONDS when
 * the stretch is long enough, otherwise the stretch is shared evenly.
 */
export function retimeStretch(words) {
  if (!words.length) return [];
  const t0 = words[0].start;
  const total = Math.max(0, words[words.length - 1].end - t0);
  const n = words.length;
  let durations;
  if (n * MIN_WORD_SECONDS > total + 1e-9) {
    durations = words.map(() => total / n);
  } else {
    const syl = words.map((x) => countSyllables(x.w));
    const fixed = new Set();
    for (;;) {
      const free = words.map((_, i) => i).filter((i) => !fixed.has(i));
      const left = total - fixed.size * MIN_WORD_SECONDS;
      const s = free.reduce((acc, i) => acc + syl[i], 0);
      durations = words.map((_, i) => (fixed.has(i) ? MIN_WORD_SECONDS : (left * syl[i]) / s));
      const short = free.filter((i) => durations[i] < MIN_WORD_SECONDS - 1e-12);
      if (!short.length) break;
      short.forEach((i) => fixed.add(i));
    }
  }
  let at = t0;
  return words.map((x, i) => {
    const start = at;
    at = i === n - 1 ? t0 + total : at + durations[i];
    return { ...x, start: round6(start), end: round6(at) };
  });
}

// ---------------------------------------------------------------- words

const tokens = (text) => String(text || '').split(/\s+/).map((t) => t.trim()).filter(Boolean);

function spread(list, start, end, stretch) {
  const step = list.length ? Math.max(0, end - start) / list.length : 0;
  return list.map((w, i) => ({ w, start: round6(start + i * step), end: round6(i === list.length - 1 ? end : start + (i + 1) * step), stretch }));
}

/** Narrated: the words of each narration segment ({ text, start, end }, seconds in the track, which starts at 0). */
export function wordsFromSegments(segments = []) {
  return (Array.isArray(segments) ? segments : []).flatMap((seg, i) => {
    const start = Number(seg?.start);
    const end = Number(seg?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
    return spread(tokens(seg.text), start, end, `line:${i}`);
  });
}

/**
 * Talking: each shot's line is spoken inside its own clip. The clip's speech
 * timing is not known, so the words are spread over the shot, leaving `edge`
 * seconds at both ends.
 */
export function wordsFromShotLines(shots = [], { edge = 0.2, windows = [] } = {}) {
  let offset = 0;
  const out = [];
  shots.forEach((shot, i) => {
    const seconds = Number(shot.seconds) || 0;
    const list = tokens(shot.line);
    const win = windows[i];
    if (list.length && seconds > 0 && Array.isArray(win) && win[1] > win[0]) {
      // The clip's own speech, found by silencedetect (seconds from the shot's start).
      const from = Math.max(0, Math.min(seconds, win[0]));
      const to = Math.max(from, Math.min(seconds, win[1]));
      out.push(...spread(list, offset + from, offset + to, `shot:${i}`));
    } else if (list.length && seconds > 0) {
      const pad = Math.min(edge, seconds / 4);
      out.push(...spread(list, offset + pad, offset + seconds - pad, `shot:${i}`));
    }
    offset += seconds;
  });
  return out;
}

// ---------------------------------------------------------------- layout

/**
 * Where the caption sits: { x, y, fontSize, top, bottom, band: { top, bottom } }
 * in pixels of a width x height frame. top/bottom bound a two-line caption.
 */
export function captionLayout({ width = 1080, height = 1920, style = 'serif_accent' } = {}) {
  const k = height / SAFE_BAND.height;
  const fontScale = Math.min(width / SAFE_BAND.width, height / SAFE_BAND.height);
  const s = styleOf(style);
  const fontSize = Math.round(s.size * fontScale);
  const half = (LINES_RESERVED * fontSize * LINE_HEIGHT) / 2;
  const band = { top: SAFE_BAND.top * k, bottom: SAFE_BAND.bottom * k };
  let y = Math.round(SAFE_BAND.centre * k);
  if (y - half < band.top) y = Math.ceil(band.top + half);
  if (y + half > band.bottom) y = Math.floor(band.bottom - half);
  return { x: Math.round(width / 2), y, fontSize, top: y - half, bottom: y + half, band };
}

// ---------------------------------------------------------------- events

function cutIndex(cuts, t) {
  let i = 0;
  while (i < cuts.length && cuts[i] <= t) i += 1;
  return i;
}

function phraseSizes(n) {
  const count = Math.ceil(n / MAX_PHRASE_WORDS);
  const base = Math.floor(n / count);
  const extra = n % count;
  return Array.from({ length: count }, (_, i) => base + (i < extra ? 1 : 0));
}

/** Caption events (and the ASS file) for the finished video. See the header. */
export function buildCaptionEvents({ words = [], cuts = [], style = 'serif_accent', width = 1080, height = 1920, format = 'ass', end = Infinity } = {}) {
  const cutList = [...new Set((cuts || []).map(Number).filter((c) => Number.isFinite(c) && c > 0 && c < end))].sort((a, b) => a - b);
  const clipped = (words || [])
    .filter((x) => x && tokens(x.w).length && Number.isFinite(Number(x.start)) && Number.isFinite(Number(x.end)) && Number(x.start) < end)
    .map((x) => ({ ...x, start: Number(x.start), end: Math.min(end, Math.max(Number(x.start), Number(x.end))) }))
    .sort((a, b) => a.start - b.start)
    .map((x) => {
      const shot = cutIndex(cutList, (x.start + x.end) / 2);
      const lo = shot > 0 ? cutList[shot - 1] : -Infinity;
      const hi = shot < cutList.length ? cutList[shot] : Infinity;
      const start = Math.min(Math.max(x.start, lo), hi);
      return { ...x, shot, start, end: Math.max(start, Math.min(x.end, hi)) };
    });

  const stretches = [];
  for (const x of clipped) {
    const cur = stretches[stretches.length - 1];
    const prev = cur?.[cur.length - 1];
    const same = prev && prev.shot === x.shot && x.start - prev.end < STRETCH_GAP_SECONDS
      && (prev.stretch === undefined || x.stretch === undefined || prev.stretch === x.stretch);
    if (same) cur.push(x);
    else stretches.push([x]);
  }

  const events = [];
  for (const stretch of stretches) {
    const timed = retimeStretch(stretch);
    let i = 0;
    for (const size of phraseSizes(timed.length)) {
      const part = timed.slice(i, i + size);
      i += size;
      events.push({
        start: part[0].start,
        end: part[part.length - 1].end,
        text: part.map((x) => x.w).join(' '),
        words: part.map((x) => x.w),
        timings: part.map((x) => ({ w: x.w, start: x.start, end: x.end })),
      });
    }
  }

  const ass = format === 'ass' ? toAss(events, { style, width, height }) : null;
  return { format: format === 'ass' ? 'ass' : 'none', events, ass };
}

// ---------------------------------------------------------------- ASS

/** Seconds -> h:mm:ss.cc */
export function assTime(seconds) {
  const cs = Math.max(0, Math.round(seconds * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

// Braces start override blocks and a backslash starts an escape (\N, \h): neither may come from the script.
const cleanWord = (w) => String(w).replace(/[{}\\]/g, '').trim();

// Rough advance width of one character, as a share of the font size (the bundled serif; wider in bold capitals).
const CHAR_WIDTH = { normal: 0.56, upper: 0.7 };

/** The caption's words as shown (cleaned, upper-cased for bold_pop). */
export function shownWords(words, style) {
  const s = styleOf(style);
  return words.map(cleanWord).filter(Boolean).map((w) => (s.upper ? w.toUpperCase() : w));
}

/**
 * The font size for one caption: the style's size, shrunk when its widest word would not fit inside the frame
 * less its side margins (a word is never broken).
 */
export function fitFontSize(words, { style = 'serif_accent', width = 1080, height = 1920 } = {}) {
  const s = styleOf(style);
  const { fontSize } = captionLayout({ width, height, style });
  const room = width - 2 * Math.round(width * 0.08);
  const longest = shownWords(words, style).reduce((m, w) => Math.max(m, [...w].length), 0);
  const need = longest * fontSize * (s.upper ? CHAR_WIDTH.upper : CHAR_WIDTH.normal);
  return need > room ? Math.max(8, Math.floor(room / (longest * (s.upper ? CHAR_WIDTH.upper : CHAR_WIDTH.normal)))) : fontSize;
}

/** ASS text of a phrase with the accent on word `accent` (-1 for none). */
function phraseText(words, s, accent) {
  const list = words.map(cleanWord).filter(Boolean).map((w) => (s.upper ? w.toUpperCase() : w));
  if (!s.accent || accent < 0) return list.join(' ');
  return list.map((w, i) => (i === accent ? `{\\1c${s.accent}&}${w}{\\1c${s.primary}&}` : w)).join(' ');
}

/** The ASS file for some events (seconds from the file's own start). */
export function toAss(events, { style, width, height }) {
  const s = styleOf(style);
  const layout = captionLayout({ width, height, style });
  const margin = Math.round(width * 0.08);
  const outline = Math.max(1, Math.round(s.outline * (layout.fontSize / s.size)));
  const head = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Caption,${CAPTION_FONT},${layout.fontSize},${s.primary},${s.primary},${s.outlineColour},${s.back},${s.bold},0,0,0,100,100,0,0,1,${outline},${s.shadow},5,${margin},${margin},0,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const lines = events.flatMap((e) => {
    // The phrase is rounded inward to whole centiseconds, so a caption ending at a cut never runs past it; the
    // word boundaries inside it are rounded to the nearest centisecond, so the per-word lines meet exactly.
    const start = Math.ceil(e.start * 100 - 1e-6) / 100;
    const end = Math.max(start, Math.floor(e.end * 100 + 1e-6) / 100);
    const fs = fitFontSize(e.words, { style, width, height });
    const head = `{\\an5\\pos(${layout.x},${layout.y})${fs !== layout.fontSize ? `\\fs${fs}` : ''}}`;
    const timings = Array.isArray(e.timings) && e.timings.length === e.words.length ? e.timings : null;
    if (!s.accent || !timings) return [`Dialogue: 0,${assTime(start)},${assTime(end)},Caption,,0,0,0,,${head}${phraseText(e.words, s, -1)}`];
    return timings.map((t, k) => {
      const a = k === 0 ? start : Math.min(end, Math.max(start, Math.round(t.start * 100) / 100));
      const b = k === timings.length - 1 ? end : Math.min(end, Math.max(a, Math.round(timings[k + 1].start * 100) / 100));
      return `Dialogue: 0,${assTime(a)},${assTime(b)},Caption,,0,0,0,,${head}${phraseText(e.words, s, k)}`;
    });
  });
  return `${[...head, ...lines].join('\n')}\n`;
}

// ---------------------------------------------------------------- ffmpeg support

const filterCache = new Map();

/** True when the ffmpeg binary at `ffmpegPath` lists the ass (or subtitles) filter. */
export function captionFilterAvailable(ffmpegPath) {
  if (filterCache.has(ffmpegPath)) return filterCache.get(ffmpegPath);
  const check = new Promise((resolve) => {
    execFile(ffmpegPath, ['-hide_banner', '-filters'], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve(!err && /^\s*\S+\s+(ass|subtitles)\s/m.test(String(stdout)));
    });
  });
  // Only a yes is remembered: a check that failed (a slow start, a timeout) is asked again next time.
  filterCache.set(ffmpegPath, check);
  check.then((yes) => { if (!yes) filterCache.delete(ffmpegPath); });
  return check;
}

// ---------------------------------------------------------------- font coverage

const cmapCache = new Map();

/** The code points a TrueType/OpenType font maps to a glyph (its cmap: format 12 if present, else format 4). */
export function fontCodePoints(fontPath) {
  if (cmapCache.has(fontPath)) return cmapCache.get(fontPath);
  const buf = readFileSync(fontPath);
  const numTables = buf.readUInt16BE(4);
  let cmap = -1;
  for (let i = 0; i < numTables; i += 1) {
    const rec = 12 + i * 16;
    if (buf.toString('latin1', rec, rec + 4) === 'cmap') cmap = buf.readUInt32BE(rec + 8);
  }
  const has = (cp) => set.has(cp) || ranges.some(([a, b]) => cp >= a && cp <= b);
  const set = new Set();
  const ranges = [];
  if (cmap >= 0) {
    const n = buf.readUInt16BE(cmap + 2);
    const subs = [];
    for (let i = 0; i < n; i += 1) {
      const r = cmap + 4 + i * 8;
      subs.push({ platform: buf.readUInt16BE(r), encoding: buf.readUInt16BE(r + 2), at: cmap + buf.readUInt32BE(r + 4) });
    }
    const f12 = subs.find((x) => buf.readUInt16BE(x.at) === 12);
    const f4 = subs.find((x) => buf.readUInt16BE(x.at) === 4 && (x.platform === 3 || x.platform === 0));
    if (f12) {
      const groups = buf.readUInt32BE(f12.at + 12);
      for (let g = 0; g < groups; g += 1) {
        const r = f12.at + 16 + g * 12;
        if (buf.readUInt32BE(r + 8) !== 0) ranges.push([buf.readUInt32BE(r), buf.readUInt32BE(r + 4)]);
      }
    } else if (f4) {
      const t = f4.at;
      const segs = buf.readUInt16BE(t + 6) / 2;
      const ends = t + 14;
      const starts = ends + segs * 2 + 2;
      const deltas = starts + segs * 2;
      const offsets = deltas + segs * 2;
      for (let i = 0; i < segs; i += 1) {
        const end = buf.readUInt16BE(ends + i * 2);
        const start = buf.readUInt16BE(starts + i * 2);
        const delta = buf.readInt16BE(deltas + i * 2);
        const ro = buf.readUInt16BE(offsets + i * 2);
        for (let c = start; c <= end && c !== 0xffff; c += 1) {
          let glyph;
          if (ro === 0) glyph = (c + delta) & 0xffff;
          else {
            const at = offsets + i * 2 + ro + (c - start) * 2;
            glyph = at + 1 < buf.length ? buf.readUInt16BE(at) : 0;
            if (glyph) glyph = (glyph + delta) & 0xffff;
          }
          if (glyph) set.add(c);
        }
      }
    }
  }
  const out = { has };
  cmapCache.set(fontPath, out);
  return out;
}

/** The distinct characters of some texts that the font has no glyph for (spaces ignored). */
export function unsupportedCharacters(texts, fontPath) {
  const font = fontCodePoints(fontPath);
  const missing = new Set();
  for (const t of texts) for (const ch of String(t || '')) if (!/\s/.test(ch) && !font.has(ch.codePointAt(0))) missing.add(ch);
  return [...missing];
}
