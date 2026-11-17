import { afterEach, describe, expect, it, vi } from 'vitest';
import { fitPrompt, flowOf, lookLine, PROMPT_MAX } from '../../lib/story/flow.js';
import { shorten } from '../../lib/story/flow.js';
import { buildShotsSystem, stillPrompt } from '../../lib/story/prompts/shot.js';

const cast = new Map([
  ['c1', { id: 'c1', name: 'Maya', description: 'A woman in her thirties with short dark hair, a green apron and a warm smile.' }],
  ['c2', { id: 'c2', name: 'Leo', description: 'A tall man with a beard, a denim jacket and round glasses.' }],
]);
const shots = [
  { id: 'a', ord: 0, description: 'Maya sweeps the shop at night.', setting: 'A small barbershop at night, warm lamp light. Maya wears a green apron.', cast_ids: ['c1'] },
  { id: 'b', ord: 1, description: 'Leo walks in with two coffees.', setting: 'A small barbershop at night, warm lamp light. Maya wears a green apron.', cast_ids: ['c1', 'c2'] },
];

describe('story flow context', () => {
  it('has the setting, a look line per person and the line about the shot before', () => {
    const flow = flowOf({ shot: shots[1], allShots: shots, castById: cast });
    expect(flow.setting).toMatch(/^Setting: A small barbershop/);
    expect(flow.looks).toHaveLength(2);
    expect(flow.looks[0]).toMatch(/^Look, Maya: A woman/);
    expect(flow.previous).toBe('Just before this: Maya sweeps the shop at night.');
    const still = stillPrompt({ style: 'Soft clay look.', description: shots[1].description, castNames: ['Maya', 'Leo'], flow });
    expect(still).toContain('Setting: A small barbershop');
    expect(still).toContain('Look, Leo:');
    expect(still).toContain('Just before this: Maya sweeps');
    // The shot's own description comes first.
    expect(still.indexOf('Leo walks in')).toBeLessThan(still.indexOf('Setting:'));
  });

  it('the first shot has no previous line, and a shot with no setting (an old project) has no setting line', () => {
    const first = flowOf({ shot: shots[0], allShots: shots, castById: cast });
    expect(first.previous).toBe('');
    const old = flowOf({ shot: { ...shots[1], setting: null }, allShots: shots, castById: cast });
    expect(old.setting).toBe('');
    expect(stillPrompt({ style: 's', description: 'd', flow: old })).not.toContain('Setting:');
    expect(stillPrompt({ style: 's', description: 'd' })).toBe('A single frame from an animated short film, 9:16 framing. d s No text, no captions, no logos, no watermark.');
  });

  afterEach(() => vi.unstubAllEnvs());

  it('the previous shot is the one before in story order across scene borders', () => {
    const rows = [{ id: 'x', ord: 5, scene_id: 's2', description: 'Second scene.' }, { id: 'w', ord: 4, scene_id: 's1', description: 'Last of the first scene' }];
    expect(flowOf({ shot: rows[0], allShots: rows }).previous).toBe('Just before this: Last of the first scene.');
  });

  it('only [[mock:...]] markers, and only in mock mode, are dropped from the previous line; customer text is never altered', () => {
    const rows = [{ id: 'w', ord: 4, description: 'A sign says [[open]] and [[mock:fail]] here' }, { id: 'x', ord: 5, description: 'Next.' }];
    vi.stubEnv('STORY_MOCK', '1');
    expect(flowOf({ shot: rows[1], allShots: rows }).previous).toBe('Just before this: A sign says [[open]] and here.');
    vi.stubEnv('STORY_MOCK', '');
    expect(flowOf({ shot: rows[1], allShots: rows }).previous).toBe('Just before this: A sign says [[open]] and [[mock:fail]] here.');
  });

  it('shorten never splits an emoji', () => {
    const text = '\u{1F600}'.repeat(100);
    for (const max of [1, 2, 3, 7, 51]) {
      const out = shorten(text, max);
      expect([...out].length).toBeLessThanOrEqual(max);
      expect(out).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
    }
  });

  it('the planner prompt says unchanged scenes are context only', () => {
    const system = buildShotsSystem({ seconds: 30 });
    expect(system).toMatch(/"changed": true/);
    expect(system).toMatch(/context only/i);
    expect(system).not.toMatch(/return the shots of every scene that did not change/i);
  });

  it('different people in every scene gives no look lines', () => {
    expect(flowOf({ shot: shots[1], allShots: shots, castById: cast, consistentCast: false }).looks).toEqual([]);
  });

  it('look lines are short', () => {
    expect(lookLine('Maya', 'word '.repeat(200)).length).toBeLessThan(200);
  });

  it('stays within the limit with five characters and long text: the context is cut, never the description or the line', () => {
    const five = ['Maya', 'Leo', 'Ana', 'Sam', 'Rosa'].map((n, i) => ({ id: `k${i}`, name: n, description: `${n} ${'is wearing a very long coat and boots '.repeat(20)}` }));
    const castFive = new Map(five.map((c) => [c.id, c]));
    const own = `Own description ${'x'.repeat(590)}`;
    const line = `Spoken: ${'y'.repeat(380)}`;
    const rows = [{ id: 'p', ord: 0, description: 'p'.repeat(600) }, { id: 'q', ord: 1, description: own, setting: 's'.repeat(400), cast_ids: five.map((c) => c.id) }];
    const flow = flowOf({ shot: rows[1], allShots: rows, castById: castFive });
    for (const max of [PROMPT_MAX, 1500, 1300, 1100]) {
      const out = fitPrompt({ before: ['Style.', own], flow, after: [line, 'Natural motion.'], max });
      expect(out.length).toBeLessThanOrEqual(max);
      expect(out).toContain(own);
      expect(out).toContain(line);
    }
    // The previous shot goes first, then the look lines, then the setting.
    const mid = fitPrompt({ before: ['Style.', own], flow, after: [line], max: 1500 });
    expect(mid).not.toContain('Just before this');
    expect(mid).toContain('Setting:');
    const tight = fitPrompt({ before: ['Style.', own], flow, after: [line], max: 1150 });
    expect(tight).not.toContain('Look, Rosa');
    expect(tight).toContain('Setting:');
    const full = fitPrompt({ before: ['Style.', own], flow, after: [line], max: 4000 });
    expect(full).toContain('Just before this');
    expect(full).toContain('Look, Rosa');
  });
});
