import { describe, expect, it } from 'vitest';
import { AMBIENCE_ONLY, clipSound, speakerOfShot } from '../../lib/story/speakers.js';

const SCENES = [{ id: 's1', lines: [{ speaker: 'narrator', text: 'Once upon a time.' }, { speaker: 'Maya', text: 'Watch  me   go.' }, { speaker: '', text: 'Who said this?' }] }];
const cast = [{ name: 'Maya', voice_note: 'warm and low.' }];

describe('who says a shot\'s line', () => {
  it('reads the speaker from the script line of the shot\'s scene', () => {
    expect(speakerOfShot(SCENES, { scene_id: 's1', line: 'Once upon a time.' })).toEqual({ kind: 'narrator' });
    expect(speakerOfShot(SCENES, { scene_id: 's1', line: 'watch me go.' })).toEqual({ kind: 'character', name: 'Maya' });
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

  it('refuses a character line it cannot resolve', () => {
    expect(() => clipSound({ mode: 'talking', speaker: { kind: 'unknown' }, cast, line: 'x' })).toThrow(/who says the line/);
    expect(() => clipSound({ mode: 'talking', speaker: { kind: 'character', name: 'Leo' }, cast, line: 'x', shotId: 'sh1' })).toThrow(expect.objectContaining({ code: 'speaker_unresolved' }));
    // No cast made yet, or different people in every scene: the name from the script is enough.
    expect(clipSound({ mode: 'talking', speaker: { kind: 'character', name: 'Leo' }, cast: [], line: 'x' })).toBe('Leo says: "x" Nobody else speaks. No music.');
    expect(clipSound({ mode: 'talking', speaker: { kind: 'character', name: 'Leo' }, cast, consistentCast: false, line: 'x' })).toContain('Leo says');
  });
});
