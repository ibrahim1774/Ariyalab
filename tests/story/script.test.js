// uses tests/helpers/storyEnv.js useRegexOnlyModeration()
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { useRegexOnlyModeration, useTestAccounts } from '../helpers/storyEnv.js';
import { setStoryDb, storyDb } from '../../lib/story/db.js';
import { setCreditsDb } from '../../lib/credits.js';
import { setPricingDb, _resetPricingCache } from '../../lib/pricing.js';
import { ModerationError } from '../../lib/moderation.js';
import { registerMock } from '../../lib/providers/mock.js';
import { LimitError, NotFoundError, ValidationError } from '../../lib/story/errors.js';
import { createProject, STYLES as PROJECT_STYLES, PURPOSES } from '../../lib/story/projects.js';
import { setLimitsDeps } from '../../lib/story/limits.js';
import { STYLES } from '../../lib/story/prompts/styles.js';
import {
  buildScriptSystem, buildBriefMessage, PURPOSE_GUIDANCE, MODE_GUIDANCE, REFERENCE_GUIDANCE, wordBudget, shotTarget,
} from '../../lib/story/prompts/script.js';
import { storyScriptMock } from '../../lib/story/mocks.js';
import {
  checkScriptRules, FORBIDDEN_NAMES, getScript, onScenesChanged, reviseScript, updateScene, writeScript,
} from '../../lib/story/script.js';

useRegexOnlyModeration();
const accounts = useTestAccounts();

let raw;
beforeAll(async () => {
  raw = await createTestDb();
  setStoryDb(raw);
  setCreditsDb(raw);
  setPricingDb(raw);
}, 60_000);

afterAll(async () => {
  setStoryDb(null);
  setCreditsDb(null);
  setPricingDb(null);
  _resetPricingCache();
  await raw?.close();
});

afterEach(() => {
  registerMock('story_script', storyScriptMock);
});

// ---------------------------------------------------------------- fixtures

const words = (n, word = 'word') => Array.from({ length: n }, () => word).join(' ');

/** A narrated 30 second script that passes every rule (78 words). */
function goodScenes() {
  return [
    { id: 's1', title: 'The doubt', visual: 'A young barber sweeps an empty shop at night.', lines: [{ speaker: 'narrator', text: 'New barbers, nobody tells you the quiet part.' }] },
    { id: 's2', title: 'Mum', visual: 'His mum shakes her head at the kitchen table.', lines: [{ speaker: 'narrator', text: 'My mum said I should get a real job before the rent ran out.' }] },
    { id: 's3', title: 'The phone', visual: 'His phone lights up with a new booking on the counter.', mention: true, lines: [{ speaker: 'narrator', text: 'Then my cousin put my chair on a booking site, and people just picked a time.' }] },
    { id: 's4', title: 'Busy', visual: 'The shop is full and every chair has a customer.', lines: [{ speaker: 'narrator', text: 'By spring I had a waiting list and two more barbers working with me.' }] },
    { id: 's5', title: 'Mum again', visual: 'His mum sits in the chair for a trim, smiling.', lines: [{ speaker: 'narrator', text: 'Now my mum books her trim like everyone else, and she still tips in coins.' }] },
  ];
}
const OPTS = { seconds: 30, mode: 'narrated', purpose: 'service' };
const rulesOf = (violations) => violations.map((v) => v.rule);

function withLine(text, sceneIndex = 1) {
  const scenes = goodScenes();
  scenes[sceneIndex].lines = [{ speaker: 'narrator', text }];
  return scenes;
}

// ---------------------------------------------------------------- checkScriptRules

describe('checkScriptRules', () => {
  it('passes a script that follows every rule', () => {
    expect(checkScriptRules(goodScenes(), OPTS)).toEqual([]);
  });

  it('works with the one argument contract call (no word budget without seconds)', () => {
    expect(checkScriptRules(goodScenes())).toEqual([]);
  });

  it('flags a first line longer than 12 words', () => {
    const scenes = goodScenes();
    scenes[0].lines = [{ speaker: 'narrator', text: 'New barbers, nobody ever tells you about the quiet part of this job at all.' }];
    const v = checkScriptRules(scenes, OPTS);
    expect(v).toContainEqual(expect.objectContaining({ sceneId: 's1', rule: 'hook_length' }));
  });

  it.each([
    ['an em dash', 'My mum said — get a real job before the rent ran out.'],
    ['an en dash', 'My mum said – get a real job before the rent ran out.'],
    ['a spaced hyphen', 'My mum said - get a real job before the rent ran out.'],
    ['a hyphenated word', 'My mum said get a full-time job before the rent ran out.'],
  ])('flags %s in a line', (_label, text) => {
    expect(checkScriptRules(withLine(text), OPTS)).toContainEqual(expect.objectContaining({ sceneId: 's2', rule: 'dash' }));
  });

  it('allows a dash in the visual (only lines are spoken)', () => {
    const scenes = goodScenes();
    scenes[1].visual = 'His mum, mid-sentence, shakes her head.';
    expect(rulesOf(checkScriptRules(scenes, OPTS))).not.toContain('dash');
  });

  it.each([
    ['It is free.'],
    ['You can get it for free now, honestly.'],
    ['Free. That is what she said it was, and she was right.'],
  ])('flags "free" on its own: %s', (text) => {
    expect(rulesOf(checkScriptRules(withLine(text), OPTS))).toContain('free_alone');
  });

  it.each([['Start with a free trial and see.'], ['Feel free to laugh at me now.'], ['She asked for a free consultation first.'], ['Freedom felt close.']])(
    'allows qualified "free": %s',
    (text) => {
      expect(rulesOf(checkScriptRules(withLine(text), OPTS))).not.toContain('free_alone');
    }
  );

  it.each([['We guarantee it works.'], ['Results guaranteed, I swear.'], ['It guarantees you more bookings.']])('flags a guarantee: %s', (text) => {
    expect(rulesOf(checkScriptRules(withLine(text), OPTS))).toContain('guarantee');
  });

  it('flags more than one mention scene', () => {
    const scenes = goodScenes();
    scenes[3].mention = true;
    const v = checkScriptRules(scenes, OPTS);
    expect(v).toContainEqual(expect.objectContaining({ sceneId: 's4', rule: 'mention_count' }));
    expect(v.filter((x) => x.rule === 'mention_count')).toHaveLength(1);
  });

  it('flags any mention when the purpose is story', () => {
    const v = checkScriptRules(goodScenes(), { ...OPTS, purpose: 'story' });
    expect(v).toContainEqual(expect.objectContaining({ sceneId: 's3', rule: 'mention_in_story' }));
    const noMention = goodScenes().map(({ mention, ...s }) => s);
    expect(checkScriptRules(noMention, { ...OPTS, purpose: 'story' })).toEqual([]);
  });

  it('checks the word budget per mode', () => {
    // 78 words. Narrated 30 s: 66 to 90. Talking 30 s: 48 to 78.
    expect(wordBudget(30, 'narrated')).toEqual({ min: 66, max: 90 });
    expect(wordBudget(30, 'talking')).toEqual({ min: 48, max: 78 });
    expect(rulesOf(checkScriptRules(goodScenes(), { ...OPTS, seconds: 45 }))).toContain('word_budget'); // needs 99+
    expect(rulesOf(checkScriptRules(goodScenes(), { ...OPTS, seconds: 20 }))).toContain('word_budget'); // max 60
    const v = checkScriptRules(goodScenes(), { ...OPTS, seconds: 45 }).find((x) => x.rule === 'word_budget');
    expect(v.sceneId).toBeNull();
    expect(v.message).toMatch(/99/);
  });

  it('flags a line longer than 22 words', () => {
    const text = 'My mum said I should get a real job before the rent ran out and before my car got taken back by the bank.';
    expect(checkScriptRules(withLine(text), OPTS)).toContainEqual(expect.objectContaining({ sceneId: 's2', rule: 'line_length' }));
  });

  it('flags a scene with no visual', () => {
    const scenes = goodScenes();
    scenes[2].visual = '  ';
    expect(checkScriptRules(scenes, OPTS)).toContainEqual(expect.objectContaining({ sceneId: 's3', rule: 'visual_missing' }));
  });

  it('flags a character line in a narrated video', () => {
    const scenes = goodScenes();
    scenes[1].lines = [{ speaker: 'Mum', text: 'Get a real job before the rent runs out, love.' }];
    expect(checkScriptRules(scenes, OPTS)).toContainEqual(expect.objectContaining({ sceneId: 's2', rule: 'narrator_only' }));
  });

  it('allows a narrator only to open or close a talking video', () => {
    const talking = goodScenes().map((s, i) => ({ ...s, lines: s.lines.map((l) => ({ ...l, speaker: i === 0 ? 'narrator' : 'Leo' })) }));
    const opts = { ...OPTS, mode: 'talking' };
    expect(checkScriptRules(talking, opts)).toEqual([]);
    talking[2].lines = [{ speaker: 'narrator', text: 'Then my cousin put my chair on a booking site, and people just picked a time.' }];
    expect(checkScriptRules(talking, opts)).toContainEqual(expect.objectContaining({ sceneId: 's3', rule: 'narrator_placement' }));
  });

  it('flags a talking video where no character speaks', () => {
    expect(rulesOf(checkScriptRules(goodScenes(), { ...OPTS, mode: 'talking' }))).toContain('no_dialogue');
  });

  it('does not flag an ordinary word that is part of a studio name', () => {
    const text = 'She could only marvel at the full calendar that week.';
    expect(rulesOf(checkScriptRules(withLine(text), OPTS))).not.toContain('forbidden_name');
  });

  it('flags studio, character and celebrity names anywhere in a scene', () => {
    expect(FORBIDDEN_NAMES.length).toBeGreaterThan(10);
    for (const name of FORBIDDEN_NAMES.slice(0, 5)) {
      const scenes = goodScenes();
      scenes[3].visual = `A shop drawn like a ${name} film.`;
      const v = checkScriptRules(scenes, OPTS).filter((x) => x.rule === 'forbidden_name');
      expect(v).toEqual([expect.objectContaining({ sceneId: 's4' })]);
      expect(v[0].message.toLowerCase()).not.toContain(name.toLowerCase());
    }
    const scenes = goodScenes();
    scenes[0].title = FORBIDDEN_NAMES[FORBIDDEN_NAMES.length - 1].toUpperCase();
    expect(rulesOf(checkScriptRules(scenes, OPTS))).toContain('forbidden_name');
  });

  it("flags the project's avoid words and phrases (case and punctuation insensitive)", () => {
    const opts = { ...OPTS, avoid: ['cheap', 'side hustle', 'c++'] };
    expect(checkScriptRules(goodScenes(), opts)).toEqual([]);
    const v = checkScriptRules(withLine('Everyone said it was a Side Hustle, not a real job at all.'), opts);
    expect(v).toContainEqual(expect.objectContaining({ sceneId: 's2', rule: 'avoid_word' }));
    expect(v.find((x) => x.rule === 'avoid_word').message).toContain('side hustle');
    expect(rulesOf(checkScriptRules(withLine('It looked cheaper than I thought, honestly.'), opts))).not.toContain('avoid_word');
    expect(rulesOf(checkScriptRules(withLine('It looked cheap, honestly, but it worked.'), opts))).toContain('avoid_word');
  });

  it('flags a spoken call to action unless the project asks for one', () => {
    const scenes = withLine('If you want the same, check it out below.', 4);
    expect(rulesOf(checkScriptRules(scenes, OPTS))).toContain('call_to_action');
    expect(rulesOf(checkScriptRules(scenes, { ...OPTS, cta: true }))).not.toContain('call_to_action');
  });

  it('flags an empty script', () => {
    expect(rulesOf(checkScriptRules([], OPTS))).toContain('empty_script');
  });

  it('every violation has a customer readable message', () => {
    const scenes = goodScenes();
    scenes[0].lines = [{ speaker: 'Mum', text: `It is free — ${words(25)} guaranteed.` }];
    scenes[3].mention = true;
    scenes[2].visual = '';
    for (const v of checkScriptRules(scenes, { ...OPTS, avoid: ['word'] })) {
      expect(v.message).toMatch(/^[A-Z].*[.]$/);
      expect(v.message).not.toMatch(/—|–/);
    }
  });
});

// ---------------------------------------------------------------- prompt

describe('script prompt', () => {
  const base = { mode: 'narrated', seconds: 30 };
  const BEATS = [{ ord: 1, start: 0, end: 2, visual: 'A man stares at a phone', said: 'Nobody books me', why: 'Doubt' }];

  it('has its own guidance block for every purpose', () => {
    expect(Object.keys(PURPOSE_GUIDANCE).sort()).toEqual([...PURPOSES].sort());
    for (const purpose of PURPOSES) {
      const system = buildScriptSystem({ ...base, purpose });
      expect(system).toContain(PURPOSE_GUIDANCE[purpose]);
      for (const other of PURPOSES.filter((p) => p !== purpose)) expect(system).not.toContain(PURPOSE_GUIDANCE[other]);
    }
  });

  it('adapts to the kind of offer', () => {
    expect(PURPOSE_GUIDANCE.product).toMatch(/can appear in scenes/i);
    expect(PURPOSE_GUIDANCE.app).toMatch(/phone or laptop/i);
    expect(PURPOSE_GUIDANCE.coaching).toMatch(/customer's change|their change/i);
    expect(PURPOSE_GUIDANCE.service).toMatch(/turning point/i);
    expect(PURPOSE_GUIDANCE.personal_brand).toMatch(/no hard pitch/i);
    expect(PURPOSE_GUIDANCE.story).toMatch(/no offer/i);
  });

  it('asks for one natural mention, except for a story with no offer', () => {
    const product = buildScriptSystem({ ...base, purpose: 'product' });
    expect(product).toMatch(/ONE scene/);
    expect(product).toMatch(/"mention": true/);
    const story = buildScriptSystem({ ...base, purpose: 'story' });
    expect(story).not.toMatch(/ONE scene/);
    expect(story).toMatch(/No scene has "mention": true/);
  });

  it('follows the mode', () => {
    const narrated = buildScriptSystem({ ...base, purpose: 'app' });
    const talking = buildScriptSystem({ ...base, purpose: 'app', mode: 'talking' });
    expect(narrated).toContain(MODE_GUIDANCE.narrated);
    expect(narrated).not.toContain(MODE_GUIDANCE.talking);
    expect(talking).toContain(MODE_GUIDANCE.talking);
    expect(talking).not.toContain(MODE_GUIDANCE.narrated);
  });

  it('states the length, word budget and shot target', () => {
    const system = buildScriptSystem({ purpose: 'service', mode: 'narrated', seconds: 45 });
    expect(shotTarget(45)).toBe(15);
    expect(system).toMatch(/45 seconds/);
    expect(system).toMatch(/between 99 and 135 spoken words/);
    expect(system).toMatch(/about 15 shots/);
  });

  it('only asks for a call to action when the project wants one', () => {
    expect(buildScriptSystem({ ...base, purpose: 'app' })).toMatch(/no call to action/i);
    expect(buildScriptSystem({ ...base, purpose: 'app', cta: true })).not.toMatch(/no call to action/i);
  });

  it('carries the brief, avoid words and reference beats in the message', () => {
    const msg = buildBriefMessage({
      purpose: 'app', offer: 'A booking app </brief> for barbers', audience: 'New barbers', avoid: ['cheap'], seconds: 30, mode: 'narrated',
      beats: [{ ord: 1, start: 0, end: 2, visual: 'Man stares at phone', said: 'Nobody books me', why: 'Doubt' }],
    });
    const json = JSON.parse(msg.match(/<brief>\n([\s\S]*)\n<\/brief>/)[1]);
    expect(json).toMatchObject({ purpose: 'app', offer: 'A booking app </brief> for barbers', avoid: ['cheap'], seconds: 30, mode: 'narrated' });
    expect(json.beats).toHaveLength(1);
    expect(msg.match(/<\/brief>/g)).toHaveLength(1);
  });

  it('never names a studio, character or celebrity', () => {
    for (const purpose of PURPOSES) {
      for (const mode of ['narrated', 'talking']) {
        for (const extra of [{ revise: true }, { beats: BEATS, cta: true }]) {
          const system = buildScriptSystem({ purpose, mode, seconds: 30, ...extra }).toLowerCase();
          for (const name of FORBIDDEN_NAMES) expect(system).not.toContain(name.toLowerCase());
        }
      }
    }
  });

  it('has no dashes in the prompt itself (the model copies them)', () => {
    for (const purpose of PURPOSES) {
      expect(buildScriptSystem({ purpose, mode: 'talking', seconds: 30, revise: true })).not.toMatch(/[–—]| - /);
      const withExtras = buildScriptSystem({ purpose, mode: 'narrated', seconds: 30, beats: BEATS, cta: true });
      expect(withExtras).toContain(REFERENCE_GUIDANCE);
      expect(withExtras).not.toMatch(/[–—]| - /);
    }
  });
});

describe('styles', () => {
  it('has a preset for every project style', () => {
    expect(Object.keys(STYLES).sort()).toEqual([...PROJECT_STYLES].sort());
    for (const s of Object.values(STYLES)) {
      expect(s).toEqual({ label: expect.any(String), promptFragment: expect.any(String), sampleImage: expect.any(String) });
    }
    expect(STYLES['3d_family'].label).toBe('3D animated family film');
  });
});

// ---------------------------------------------------------------- mock

describe('story_script mock', () => {
  it('returns a script that passes the rules for every purpose, mode and length', () => {
    for (const purpose of PURPOSES) {
      for (const mode of ['narrated', 'talking']) {
        for (const seconds of [15, 30, 45, 60, 75]) {
          const content = buildBriefMessage({ purpose, offer: 'A thing', audience: 'People', seconds, mode });
          const out = storyScriptMock({ messages: [{ role: 'user', content }] });
          const v = checkScriptRules(out.scenes, { seconds, mode, purpose });
          expect({ purpose, mode, seconds, v }).toEqual({ purpose, mode, seconds, v: [] });
          expect(out.scenes.filter((s) => s.mention).length).toBe(purpose === 'story' ? 0 : 1);
        }
      }
    }
  });
});

// ---------------------------------------------------------------- service

const BRIEF = { purpose: 'service', offer: 'A barber shop booking site.', audience: 'New barbers', seconds: 30, quality: 'standard' };

async function newProject(input = {}, userId = randomUUID()) {
  const project = await createProject({ userId, input: { ...BRIEF, ...input } });
  return { userId, project };
}

function spyOnScriptMock() {
  const spy = vi.fn(storyScriptMock);
  registerMock('story_script', spy);
  return spy;
}

const scriptRows = (projectId) => storyDb().select('story_scripts', { project_id: projectId }, { order: 'version' });

describe('writeScript', () => {
  it('writes a version 1 script that passes the rules and moves the project to the script step', async () => {
    const { userId, project } = await newProject();
    const spy = spyOnScriptMock();
    const script = await writeScript({ userId, projectId: project.id });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0].tier).toBe('smart');
    expect(script).toMatchObject({ project_id: project.id, version: 1, source: 'brief', violations: [] });
    expect(script.scenes.length).toBeGreaterThan(2);
    expect(new Set(script.scenes.map((s) => s.id)).size).toBe(script.scenes.length);
    expect(script.scenes.filter((s) => s.mention === true)).toHaveLength(1);
    const [stored] = await storyDb().select('story_projects', { id: project.id });
    expect(stored.step).toBe('script');
    expect(await getScript({ userId, projectId: project.id })).toMatchObject({ version: 1 });
  });

  it('retries once with the violations when the first answer breaks a rule', async () => {
    const { userId, project } = await newProject({ offer: 'A booking site [[mock:dash]]' });
    const spy = spyOnScriptMock();
    const script = await writeScript({ userId, projectId: project.id });
    expect(spy).toHaveBeenCalledTimes(2);
    const retry = spy.mock.calls[1][0].messages;
    expect(retry).toHaveLength(3);
    expect(retry[1].role).toBe('assistant');
    expect(retry[2].content).toMatch(/<problems>[\s\S]*dash/i);
    expect(script.violations).toEqual([]);
    expect(script.scenes.flatMap((s) => s.lines).some((l) => /-|—/.test(l.text))).toBe(false);
  });

  it('saves the script with the remaining violations attached when the retry still breaks a rule', async () => {
    const { userId, project } = await newProject({ offer: 'A booking site [[mock:always-bad]]' });
    const spy = spyOnScriptMock();
    const script = await writeScript({ userId, projectId: project.id });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(script.violations.map((v) => v.rule)).toContain('dash');
    expect(await scriptRows(project.id)).toHaveLength(1);
  });

  it('follows the mode and gives a story no mention', async () => {
    const { userId, project } = await newProject({ purpose: 'story', offer: null, quality: 'pro_talking' });
    const script = await writeScript({ userId, projectId: project.id });
    expect(script.violations).toEqual([]);
    expect(script.scenes.some((s) => s.mention)).toBe(false);
    expect(script.scenes.flatMap((s) => s.lines).some((l) => l.speaker !== 'narrator')).toBe(true);
  });

  it('uses the brand avoid words and the reference beats', async () => {
    const { userId, project } = await newProject();
    await storyDb().insert('story_brand', { user_id: userId, avoid: ['hustle'], tone: 'warm' });
    const [ref] = await storyDb().insert('story_references', {
      project_id: project.id, source_type: 'link', status: 'ready',
      beat_sheet: [{ ord: 1, start: 0, end: 2, visual: 'A man stares at a phone', said: 'Nobody books me', why: 'Doubt' }],
    });
    await storyDb().update('story_projects', { id: project.id }, { reference_id: ref.id });
    const spy = spyOnScriptMock();
    const script = await writeScript({ userId, projectId: project.id });
    const { system, messages } = spy.mock.calls[0][0];
    expect(messages[0].content).toMatch(/"avoid":\["hustle"\]/);
    expect(messages[0].content).toMatch(/Nobody books me/);
    expect(system).toMatch(/beat structure and pacing/);
    expect(script.source).toBe('reference');
  });

  it('refuses a project with no purpose, or no offer when one is needed, before calling the model', async () => {
    const spy = spyOnScriptMock();
    const a = await newProject({ purpose: null });
    await expect(writeScript({ userId: a.userId, projectId: a.project.id })).rejects.toMatchObject({ field: 'purpose' });
    const b = await newProject({ offer: null });
    await expect(writeScript({ userId: b.userId, projectId: b.project.id })).rejects.toBeInstanceOf(ValidationError);
    expect(spy).not.toHaveBeenCalled();
  });

  it("does not touch another user's project", async () => {
    const { project } = await newProject();
    await expect(writeScript({ userId: randomUUID(), projectId: project.id })).rejects.toBeInstanceOf(NotFoundError);
  });

  it('moderates the brief and stores nothing when it fails', async () => {
    const { userId, project } = await newProject();
    await storyDb().insert('story_brand', { user_id: userId, tone: 'nude' });
    const spy = spyOnScriptMock();
    await expect(writeScript({ userId, projectId: project.id })).rejects.toBeInstanceOf(ModerationError);
    expect(spy).not.toHaveBeenCalled();
    expect(await scriptRows(project.id)).toHaveLength(0);
  });

  it('needs a verified email on a free account', async () => {
    const { userId, project } = await newProject();
    accounts.set({ paid: false, verified: false });
    await expect(writeScript({ userId, projectId: project.id })).rejects.toMatchObject({ code: 'email_unverified', status: 403 });
    expect(await scriptRows(project.id)).toHaveLength(0);
  });

  it('does not move the step back when the script is rewritten later', async () => {
    const { userId, project } = await newProject();
    await writeScript({ userId, projectId: project.id });
    await storyDb().update('story_projects', { id: project.id }, { step: 'storyboard' });
    const changed = vi.fn();
    const off = onScenesChanged(changed);
    const second = await writeScript({ userId, projectId: project.id });
    off();
    expect(second.version).toBe(2);
    const [stored] = await storyDb().select('story_projects', { id: project.id });
    expect(stored.step).toBe('storyboard');
    // A rewrite gets new ids, so every old and new scene is reported.
    const first = (await scriptRows(project.id))[0];
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed.mock.calls[0][0].sceneIds.sort()).toEqual([...first.scenes, ...second.scenes].map((s) => s.id).sort());
  });
});

describe('reviseScript', () => {
  it('bumps the version, keeps unchanged scene ids and reports only the changed scene', async () => {
    const { userId, project } = await newProject();
    const v1 = await writeScript({ userId, projectId: project.id });
    const target = v1.scenes[2].id;
    const changed = vi.fn();
    const off = onScenesChanged(changed);
    const { script, changedSceneIds } = await reviseScript({ userId, projectId: project.id, instruction: `Make it funnier [[mock:edit:${target}]]` });
    off();
    expect(script.version).toBe(2);
    expect(script.source).toBe('revision');
    expect(script.instruction).toMatch(/funnier/);
    expect(script.scenes.map((s) => s.id)).toEqual(v1.scenes.map((s) => s.id));
    expect(changedSceneIds).toEqual([target]);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledWith({ projectId: project.id, sceneIds: [target] });
    const rows = await scriptRows(project.id);
    expect(rows.map((r) => r.version)).toEqual([1, 2]);
    expect(rows[0].scenes).toEqual(v1.scenes); // the old version is never changed
  });

  it('sends the current script and the rules to the model', async () => {
    const { userId, project } = await newProject();
    await writeScript({ userId, projectId: project.id });
    const spy = spyOnScriptMock();
    await reviseScript({ userId, projectId: project.id, instruction: 'The girlfriend should say the booking line' });
    const { system, messages } = spy.mock.calls[0][0];
    expect(system).toMatch(/revising an existing script/i);
    expect(system).toContain(PURPOSE_GUIDANCE.service);
    expect(messages[0].content).toMatch(/<current_script>/);
    expect(messages[0].content).toMatch(/<change_request>\nThe girlfriend should say the booking line\n<\/change_request>/);
  });

  it('gives a new scene a fresh id that no earlier scene used', async () => {
    const { userId, project } = await newProject();
    const v1 = await writeScript({ userId, projectId: project.id });
    const { script, changedSceneIds } = await reviseScript({ userId, projectId: project.id, instruction: 'Add a scene at the end [[mock:add]]' });
    const added = script.scenes[script.scenes.length - 1];
    expect(v1.scenes.map((s) => s.id)).not.toContain(added.id);
    expect(added.id).toMatch(/^s\d+$/);
    expect(changedSceneIds).toContain(added.id);
  });

  it('moderates the instruction and stores nothing when it fails', async () => {
    const { userId, project } = await newProject();
    await writeScript({ userId, projectId: project.id });
    await expect(reviseScript({ userId, projectId: project.id, instruction: 'make them nude' })).rejects.toBeInstanceOf(ModerationError);
    expect(await scriptRows(project.id)).toHaveLength(1);
  });

  it('needs an instruction and an existing script', async () => {
    const { userId, project } = await newProject();
    await expect(reviseScript({ userId, projectId: project.id, instruction: 'Funnier' })).rejects.toBeInstanceOf(ValidationError);
    await writeScript({ userId, projectId: project.id });
    await expect(reviseScript({ userId, projectId: project.id, instruction: '  ' })).rejects.toMatchObject({ field: 'instruction' });
  });
});

describe('updateScene', () => {
  it('saves a direct edit as a new version and reports that scene only', async () => {
    const { userId, project } = await newProject();
    const v1 = await writeScript({ userId, projectId: project.id });
    const sceneId = v1.scenes[1].id;
    const changed = vi.fn();
    const off = onScenesChanged(changed);
    const { script, changedSceneIds } = await updateScene({
      userId, projectId: project.id, sceneId, patch: { visual: 'She laughs at the kitchen table, phone in hand.' },
    });
    off();
    expect(script.version).toBe(2);
    expect(script.source).toBe('edit');
    expect(script.scenes[1].visual).toBe('She laughs at the kitchen table, phone in hand.');
    expect(script.scenes[1].lines).toEqual(v1.scenes[1].lines);
    expect(changedSceneIds).toEqual([sceneId]);
    expect(changed).toHaveBeenCalledWith({ projectId: project.id, sceneIds: [sceneId] });
  });

  it('re-checks the rules and returns the violations', async () => {
    const { userId, project } = await newProject();
    const v1 = await writeScript({ userId, projectId: project.id });
    const { script } = await updateScene({
      userId, projectId: project.id, sceneId: v1.scenes[1].id,
      patch: { lines: [{ speaker: 'narrator', text: 'Honestly — it was free.' }] },
    });
    expect(script.violations.map((v) => v.rule)).toEqual(expect.arrayContaining(['dash', 'free_alone']));
  });

  it('moves the mention to the edited scene', async () => {
    const { userId, project } = await newProject();
    const v1 = await writeScript({ userId, projectId: project.id });
    const from = v1.scenes.find((s) => s.mention).id;
    const to = v1.scenes.find((s) => !s.mention).id;
    const { script, changedSceneIds } = await updateScene({ userId, projectId: project.id, sceneId: to, patch: { mention: true } });
    expect(script.scenes.filter((s) => s.mention).map((s) => s.id)).toEqual([to]);
    expect(changedSceneIds.sort()).toEqual([from, to].sort());
  });

  it('moderates the edit and stores nothing when it fails', async () => {
    const { userId, project } = await newProject();
    const v1 = await writeScript({ userId, projectId: project.id });
    await expect(
      updateScene({ userId, projectId: project.id, sceneId: v1.scenes[0].id, patch: { lines: [{ speaker: 'narrator', text: 'nude' }] } })
    ).rejects.toBeInstanceOf(ModerationError);
    expect(await scriptRows(project.id)).toHaveLength(1);
  });

  it('rejects unknown scenes and fields', async () => {
    const { userId, project } = await newProject();
    const v1 = await writeScript({ userId, projectId: project.id });
    await expect(updateScene({ userId, projectId: project.id, sceneId: 'nope', patch: { title: 'x' } })).rejects.toBeInstanceOf(NotFoundError);
    await expect(updateScene({ userId, projectId: project.id, sceneId: v1.scenes[0].id, patch: { id: 'x' } })).rejects.toMatchObject({ field: 'id' });
    await expect(
      updateScene({ userId, projectId: project.id, sceneId: v1.scenes[0].id, patch: { lines: [{ speaker: '', text: 'Hi' }] } })
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('onScenesChanged', () => {
  it('stops calling a listener after unsubscribe and skips empty changes', async () => {
    const { userId, project } = await newProject();
    const v1 = await writeScript({ userId, projectId: project.id });
    const fn = vi.fn();
    const off = onScenesChanged(fn);
    await updateScene({ userId, projectId: project.id, sceneId: v1.scenes[0].id, patch: { title: v1.scenes[0].title } });
    expect(fn).not.toHaveBeenCalled();
    off();
    await updateScene({ userId, projectId: project.id, sceneId: v1.scenes[0].id, patch: { title: 'New title' } });
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('limits on the script step', () => {
  it('a free verified user can write scripts (no paid plan needed)', async () => {
    accounts.set({ paid: false, verified: true });
    const { userId, project } = await newProject();
    await expect(writeScript({ userId, projectId: project.id })).resolves.toMatchObject({ version: 1 });
  });

  it('LimitError is the error type limits throw', () => {
    expect(new LimitError('x', { code: 'plan_required' }).status).toBe(402);
  });
});
