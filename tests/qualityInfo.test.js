import { describe, expect, it } from 'vitest';
import { QUALITY_INFO, QUALITY_ORDER, MUSIC_AND_CAPTIONS, outputLine, qualityPatch } from '../lib/qualityInfo.js';
import { QUALITY_MAP } from '../lib/providers/config.js';
import { QUALITY_LABELS, DEFAULTS } from '../lib/pricingConstants.js';

describe('QUALITY_INFO', () => {
  it('has one entry per quality level in QUALITY_MAP and DEFAULTS', () => {
    expect(Object.keys(QUALITY_INFO).sort()).toEqual(Object.keys(QUALITY_MAP).sort());
    expect([...QUALITY_ORDER].sort()).toEqual(Object.keys(QUALITY_MAP).sort());
    expect(Object.keys(DEFAULTS.perSecond).sort()).toEqual(Object.keys(QUALITY_INFO).sort());
  });

  it('says the same picture size as QUALITY_MAP', () => {
    for (const [q, map] of Object.entries(QUALITY_MAP)) expect(QUALITY_INFO[q].picture, q).toBe(map.resolution);
  });

  it('says on every card that voice and sound are made with the video, and every model has sound on', () => {
    for (const [q, map] of Object.entries(QUALITY_MAP)) {
      expect(map.sound, q).toBe(true);
      expect(QUALITY_INFO[q].voice, q).toBe('Voice and sound made with the video');
    }
  });

  it('gives every level a voice line, a name, a model, a best for line and the music line', () => {
    for (const q of QUALITY_ORDER) {
      const i = QUALITY_INFO[q];
      for (const key of ['name', 'voice', 'picture', 'model', 'bestFor', 'included']) expect(typeof i[key] === 'string' && i[key].length > 0, `${q}.${key}`).toBe(true);
      expect(i.included).toBe(MUSIC_AND_CAPTIONS);
    }
  });

  it('says the picture sizes of the lineup', () => {
    expect(QUALITY_ORDER.map((q) => QUALITY_INFO[q].picture)).toEqual(['720p', '1080p', '720p', '1080p']);
  });

  it('uses the card names and model names the owner chose, recommends Standard only', () => {
    expect(QUALITY_ORDER.map((q) => QUALITY_INFO[q].name)).toEqual(['Budget', 'Standard', 'Pro', 'Pro Max']);
    expect(QUALITY_ORDER.map((q) => QUALITY_INFO[q].model)).toEqual(['Seedance 2 Mini', 'Gemini Omni 1.2 Flash', 'Kling 3.0', 'Kling 3.0 Pro']);
    expect(QUALITY_ORDER.filter((q) => QUALITY_INFO[q].recommended)).toEqual(['standard']);
  });

  it('keeps the display labels in QUALITY_LABELS the same as the card names', () => {
    for (const q of QUALITY_ORDER) expect(QUALITY_LABELS[q]).toBe(QUALITY_INFO[q].name);
  });

  it('writes the output line', () => {
    expect(outputLine('9:16', 30)).toBe('MP4, 9:16, about 30 seconds');
    expect(outputLine('16:9', 120)).toBe('MP4, 16:9, about 2 minutes');
  });

  it('never mentions a price or a provider id', () => {
    expect(JSON.stringify(QUALITY_INFO)).not.toMatch(/credit|\$|kie|bytedance|kling-3/i);
  });

  it('qualityPatch changes the quality only (mode is the script\'s, not the quality\'s)', () => {
    for (const q of QUALITY_ORDER) expect(qualityPatch(q)).toEqual({ quality: q });
  });
});
