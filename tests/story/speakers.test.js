import { describe, expect, it } from 'vitest';
import { AMBIENCE_ONLY, clipSound, normText, speakerOfShot } from '../../lib/story/speakers.js';

const SCENES = [{ id: 's1', lines: [{ speaker: 'narrator', text: 'Once upon a time.' }, { speaker: 'Maya', text: 'Watch  me   go.' }, { speaker: '', text: 'Who said this?' }] }];
const cast = [{ name: 'Maya', voice_note: 'warm and low.' }];

describe('who says a shot\'s line', () => {
  it('reads the speaker from the script line of the shot\'s scene', () => {
    expect(speakerOfShot(SCENES, { scene_id: 's1', line: 'Once upon a time.' })).toEqual({ kind: 'narrator', lineIndex: 0 });
    expect(speakerOfShot(SCENES, { scene_id: 's1', line: 'watch me go.' })).toEqual({ kind: 'character', name: 'Maya', lineIndex: 1 });
    expect(speakerOfShot(SCENES, { scene_id: 's1', line: '' })).toEqual({ kind: 'none' });
    expect(speakerOfShot(SCENES, { scene_id: 's1', line: 'Not in the script.' })).toEqual({ kind: 'unknown' });
    expect(speakerOfShot(SCENES, { scene_id: 's9', line: 'Once upon a time.' })).toEqual({ kind: 'unknown' });
    expect(speakerOfShot(SCENES, { scene_id: 's1', line: 'Who said this?' })).toEqual({ kind: 'unknown' });
  });

  it('a clip says ambience only unless a character speaks in a talking video', () => {
    expect(clipSound({ mode: 'narrated', speaker: { kind: 'character', name: 'Maya' }, cast, line: 'Hi.' })).toBe(AMBIENCE_ONLY);
    expect(clipSound({ mode: 'talking', speaker: { kind: 'narrator' }, cast, line: 'Hi.' })).toBe(AMBIENCE_ONLY);
    expect(clipSound({ mode: 'talking', speaker: { kind: 'none' }, cast })).toBe(AMBIENCE_ONLY);
    expect(clipSound({ mode: 'talking', speaker: { kind: 'character', name: 'maya' }, cast, line: 'Watch me go.' }))
      .toBe('maya says, in a warm and low voice: "Watch me go." Nobody else speaks. No music.');
  });

  it('refuses a character line with no speaker, and names the way out', () => {
    expect(() => clipSound({ mode: 'talking', speaker: { kind: 'unknown' }, cast, line: 'x' })).toThrow(/Ask the chat to fix who says this line/);
    expect(() => clipSound({ mode: 'talking', speaker: { kind: 'unknown' }, cast, line: 'x', shotId: 'sh1' })).toThrow(expect.objectContaining({ code: 'speaker_unresolved' }));
    // A speaker named in the script but not in the cast is not an error: the prompt names them, with no voice note.
    expect(clipSound({ mode: 'talking', speaker: { kind: 'character', name: 'Leo' }, cast, line: 'x' })).toBe('Leo says: "x" Nobody else speaks. No music.');
    // No cast made yet, or different people in every scene: the name from the script is enough.
    expect(clipSound({ mode: 'talking', speaker: { kind: 'character', name: 'Leo' }, cast: [], line: 'x' })).toBe('Leo says: "x" Nobody else speaks. No music.');
    expect(clipSound({ mode: 'talking', speaker: { kind: 'character', name: 'Leo' }, cast, consistentCast: false, line: 'x' })).toContain('Leo says');
  });

  it('reads the speaker by the line index, so a repeated line goes to the right person', () => {
    const scenes = [{ id: 's1', lines: [{ speaker: 'Ana', text: 'No.' }, { speaker: 'Ben', text: 'No.' }] }];
    expect(speakerOfShot(scenes, { scene_id: 's1', line: 'No.', line_index: 1 })).toMatchObject({ kind: 'character', name: 'Ben', lineIndex: 1 });
    expect(speakerOfShot(scenes, { scene_id: 's1', line: 'No.', line_index: 0 })).toMatchObject({ name: 'Ana' });
    // An index whose line is not the shot's text is no speaker at all.
    expect(speakerOfShot(scenes, { scene_id: 's1', line: 'Yes please.', line_index: 1 })).toEqual({ kind: 'unknown' });
    expect(speakerOfShot(scenes, { scene_id: 's1', line: 'No.', line_index: 7 })).toEqual({ kind: 'unknown' });
  });

  it('rows with no index fall back to the n-th occurrence among the scene\'s shots', () => {
    const scenes = [{ id: 's1', lines: [{ speaker: 'Ana', text: 'No.' }, { speaker: 'Ben', text: 'No.' }] }];
    const shots = [{ id: 'a', scene_id: 's1', ord: 0, line: 'No.' }, { id: 'b', scene_id: 's1', ord: 1, line: 'No.' }];
    expect(speakerOfShot(scenes, shots[0], shots)).toMatchObject({ name: 'Ana', lineIndex: 0 });
    expect(speakerOfShot(scenes, shots[1], shots)).toMatchObject({ name: 'Ben', lineIndex: 1 });
  });

  it('normalises quotes, apostrophes, dashes, punctuation, whitespace and case', () => {
    expect(normText('I’m   “here” – now!')).toBe(normText("i'm \"here\" - now"));
    const scenes = [{ id: 's1', lines: [{ speaker: 'Ben', text: "I'm here." }] }];
    expect(speakerOfShot(scenes, { scene_id: 's1', line: 'I’m here', line_index: 0 })).toMatchObject({ name: 'Ben' });
  });

  it('a fragment matches on whole words: "No" is not a piece of "I know"', () => {
    const scenes = [{ id: 's1', lines: [{ speaker: 'Ana', text: 'I know.' }, { speaker: 'Ben', text: 'Wait for me, please.' }] }];
    expect(speakerOfShot(scenes, { scene_id: 's1', line: 'No.', line_index: 0 })).toEqual({ kind: 'unknown' });
    expect(speakerOfShot(scenes, { scene_id: 's1', line: 'Wait for me', line_index: 1 })).toMatchObject({ name: 'Ben' });
    expect(speakerOfShot(scenes, { scene_id: 's1', line: 'for me, pl', line_index: 1 })).toEqual({ kind: 'unknown' });
  });
});
