import { describe, expect, it } from 'vitest';
import {
  MIN_WORD_SECONDS, MAX_PHRASE_WORDS, SAFE_BAND, countSyllables, retimeStretch, captionLayout, buildCaptionEvents,
  wordsFromSegments, wordsFromShotLines, assTime,
} from '../../lib/story/captions.js';

const sum = (xs) => xs.reduce((n, x) => n + x, 0);

describe('syllable re-timing', () => {
  it('counts syllables with at least one per word', () => {
    expect(countSyllables('cat')).toBe(1);
    expect(countSyllables('baker')).toBe(2);
    expect(countSyllables('extraordinary')).toBeGreaterThanOrEqual(5);
    expect(countSyllables('a')).toBe(1);
    expect(countSyllables('...')).toBe(1);
  });

  it('keeps the total stretch duration, gives longer words more time, and enforces the 0.42 s minimum', () => {
    // Even times as they come from a line's segment; 'a' would get far less than 0.42 s by syllables alone.
    const words = ['a', 'remarkably', 'tiny', 'extraordinary', 'cat'].map((w, i) => ({ w, start: 1 + i * 0.8, end: 1 + (i + 1) * 0.8 }));
    const out = retimeStretch(words);
    expect(out).toHaveLength(5);
    expect(out[0].start).toBeCloseTo(1, 6);
    expect(out[4].end).toBeCloseTo(5, 6);
    expect(sum(out.map((x) => x.end - x.start))).toBeCloseTo(4, 6);
    for (const x of out) expect(x.end - x.start).toBeGreaterThanOrEqual(MIN_WORD_SECONDS - 1e-9);
    // Contiguous, in order.
    for (let i = 1; i < out.length; i += 1) expect(out[i].start).toBeCloseTo(out[i - 1].end, 6);
    const dur = (w) => { const x = out.find((o) => o.w === w); return x.end - x.start; };
    expect(dur('extraordinary')).toBeGreaterThan(dur('tiny'));
    expect(dur('remarkably')).toBeGreaterThan(dur('cat'));
    expect(dur('a')).toBeCloseTo(MIN_WORD_SECONDS, 6);
  });

  it('a stretch too short for the minimum keeps its length and shares it evenly', () => {
    const words = ['one', 'two', 'three'].map((w, i) => ({ w, start: i * 0.3, end: (i + 1) * 0.3 }));
    const out = retimeStretch(words);
    expect(out[0].start).toBe(0);
    expect(out[2].end).toBeCloseTo(0.9, 6);
    for (const x of out) expect(x.end - x.start).toBeCloseTo(0.3, 6);
  });

  it('buildCaptionEvents re-times within each stretch and keeps each stretch where it was', () => {
    const words = wordsFromSegments([
      { sceneId: 's1', lineIndex: 0, text: 'Once upon a time,', start: 0.2, end: 2.2 },
      { sceneId: 's1', lineIndex: 2, text: 'a baker dreamed extraordinarily big.', start: 3.0, end: 6.0 },
    ]);
    const { events } = buildCaptionEvents({ words, cuts: [], style: 'clean' });
    const first = events.filter((e) => e.end <= 2.2 + 1e-9);
    const second = events.filter((e) => e.start >= 3.0 - 1e-9);
    expect(first.length + second.length).toBe(events.length);
    expect(first[0].start).toBeCloseTo(0.2, 2);
    expect(first[first.length - 1].end).toBeCloseTo(2.2, 2);
    expect(second[0].start).toBeCloseTo(3.0, 2);
    expect(second[second.length - 1].end).toBeCloseTo(6.0, 2);
  });
});

describe('phrases and cuts', () => {
  it('groups at most 4 words per caption', () => {
    const words = wordsFromSegments([{ sceneId: 's', lineIndex: 0, text: 'one two three four five six seven eight nine', start: 0, end: 6 }]);
    const { events } = buildCaptionEvents({ words, cuts: [], style: 'serif_accent' });
    expect(events.length).toBeGreaterThanOrEqual(3);
    for (const e of events) expect(e.words.length).toBeLessThanOrEqual(MAX_PHRASE_WORDS);
    expect(events.flatMap((e) => e.words)).toEqual(['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']);
  });

  it('no caption event spans a cut time', () => {
    // One long narrated line runs straight across two cuts, and another across a third.
    const words = wordsFromSegments([
      { sceneId: 's1', lineIndex: 0, text: 'The little bakery on the corner opened before sunrise every single morning', start: 0.1, end: 6.4 },
      { sceneId: 's2', lineIndex: 0, text: 'and the whole street woke up to the smell of bread', start: 6.6, end: 11.5 },
    ]);
    const cuts = [3, 4.5, 9];
    const { events, ass } = buildCaptionEvents({ words, cuts, style: 'bold_pop' });
    expect(events.length).toBeGreaterThan(4);
    for (const e of events) {
      expect(e.end).toBeGreaterThan(e.start);
      for (const cut of cuts) expect(e.start < cut - 1e-9 && e.end > cut + 1e-9).toBe(false);
    }
    // The text that is written to the ASS file respects the cuts too (times are rounded inward).
    const dialogue = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
    expect(dialogue).toHaveLength(events.length);
    for (const line of dialogue) {
      const [, start, end] = line.split(',');
      const s = toSeconds(start);
      const e = toSeconds(end);
      for (const cut of cuts) expect(s < cut - 1e-9 && e > cut + 1e-9).toBe(false);
    }
    // Every word is still shown exactly once.
    expect(events.flatMap((e) => e.words).length).toBe(words.length);
  });

  it('talking mode words come from each shot line, inside that shot', () => {
    const shots = [
      { id: 'a', seconds: 3, line: 'Hello there friend.' },
      { id: 'b', seconds: 4, line: null },
      { id: 'c', seconds: 3, line: 'See you soon.' },
    ];
    const words = wordsFromShotLines(shots);
    expect(words.map((w) => w.w)).toEqual(['Hello', 'there', 'friend.', 'See', 'you', 'soon.']);
    for (const w of words.slice(0, 3)) { expect(w.start).toBeGreaterThanOrEqual(0); expect(w.end).toBeLessThanOrEqual(3); }
    for (const w of words.slice(3)) { expect(w.start).toBeGreaterThanOrEqual(7); expect(w.end).toBeLessThanOrEqual(10); }
  });
});

function toSeconds(t) {
  const [h, m, s] = t.split(':');
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

describe('position', () => {
  const cases = [
    ['9:16', 1080, 1920],
    ['1:1', 1080, 1080],
    ['16:9', 1920, 1080],
  ];
  for (const [label, width, height] of cases) {
    it(`stays in the safe band on ${label}`, () => {
      const k = height / SAFE_BAND.height;
      for (const style of ['serif_accent', 'bold_pop', 'clean']) {
        const l = captionLayout({ width, height, style });
        expect(l.x).toBe(Math.round(width / 2));
        expect(l.top).toBeGreaterThanOrEqual(SAFE_BAND.top * k - 1e-9);
        expect(l.bottom).toBeLessThanOrEqual(SAFE_BAND.bottom * k + 1e-9);
        expect(l.y).toBeGreaterThan(l.top);
        expect(l.y).toBeLessThan(l.bottom);
      }
    });
  }

  it('centres at y 1250 on 1080x1920', () => {
    expect(captionLayout({ width: 1080, height: 1920, style: 'serif_accent' }).y).toBe(1250);
  });

  it('writes the position and frame size into the ASS file', () => {
    const words = wordsFromSegments([{ sceneId: 's', lineIndex: 0, text: 'Hello world', start: 0, end: 2 }]);
    const { ass, format } = buildCaptionEvents({ words, cuts: [], style: 'serif_accent', width: 1080, height: 1080 });
    expect(format).toBe('ass');
    expect(ass).toContain('PlayResX: 1080');
    expect(ass).toContain('PlayResY: 1080');
    expect(ass).toContain(`\\pos(540,${captionLayout({ width: 1080, height: 1080, style: 'serif_accent' }).y})`);
    expect(ass).toContain('DM Serif Display');
  });

  it('formats ASS times as h:mm:ss.cc', () => {
    expect(assTime(0)).toBe('0:00:00.00');
    expect(assTime(61.234)).toBe('0:01:01.23');
    expect(assTime(3725.5)).toBe('1:02:05.50');
  });

  it('keeps braces and backslashes out of the caption text', () => {
    const words = wordsFromSegments([{ sceneId: 's', lineIndex: 0, text: 'a {\\b1}bold\\N move', start: 0, end: 2 }]);
    const { ass } = buildCaptionEvents({ words, cuts: [], style: 'clean' });
    const dialogue = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
    const texts = dialogue.map((l) => l.replace(/^.*?\{\\an5\\pos\(\d+,\d+\)\}/, ''));
    for (const t of texts) {
      expect(t).not.toMatch(/[{}]/);
      expect(t).not.toContain('\\N');
    }
  });
});
