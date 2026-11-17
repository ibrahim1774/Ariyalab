// The simple maker's decisions are pure functions of the status payload: which screen, what the pipeline does next, scenes, auto render.
import { describe, it, expect } from 'vitest';
import {
  deriveScreen, nextPlanAction, actionKey, confirmedFrom, scenesOf, nextScenes, shouldAutoRender, lengthCredits, SCREENS, audioIssues, FREE_STARTS,
} from '../../components/simple/derive';
import { DEFAULTS } from '../../lib/pricingConstants';

const project = (over = {}) => ({ id: 'p1', step: 'script', seconds: 30, quality: 'standard', mode: 'narrated', fee_charged: false, consistent_cast: true, ...over });
const shot = (over = {}) => ({ id: 's1', ord: 0, scene_id: 'a', status: 'draft', still_url: null, source: 'generated', still_credits: 0, clip_credits: null, ...over });
const castRow = (over = {}) => ({ id: 'c1', name: 'Maya', status: 'ready', chosen_index: 0, image_url: '/m.png', ...over });
const audio = (n = {}, m = {}) => ({
  applicable: { narration: true, narrationLines: 3 },
  narration: { status: 'ready', credits: 0, ...n },
  music: { type: 'generated', status: 'ready', credits: 0, ...m },
});
const st = (over = {}) => ({ project: project(), shots: [], cast: [], jobs: [], audio: audio(), ...over });

describe('which screen shows', () => {
  it('has the four screens in order', () => {
    expect(SCREENS.map((s) => s.label)).toEqual(['Describe it', 'Check the script', 'Check the plan', 'Watch and fix']);
  });
  it('no project or no script -> Describe it', () => {
    expect(deriveScreen(null)).toBe('describe');
    expect(deriveScreen(st({ project: project({ step: 'brief' }) }))).toBe('describe');
    expect(deriveScreen(st({ project: project({ step: 'breakdown', reference_id: 'r1' }) }))).toBe('describe');
  });
  it('a script and nothing else -> Check the script', () => {
    expect(deriveScreen(st())).toBe('script');
  });
  it('cast rows or shots (plan in progress or ready, no clips) -> Check the plan', () => {
    expect(deriveScreen(st({ project: project({ step: 'cast' }), cast: [castRow({ status: 'pending' })] }))).toBe('plan');
    expect(deriveScreen(st({ project: project({ step: 'storyboard' }), shots: [shot()] }))).toBe('plan');
    expect(deriveScreen(st({ project: project({ step: 'audio' }), cast: [castRow()], shots: [shot({ still_url: '/s.png', status: 'still_ready' })] }))).toBe('plan');
  });
  it('a failed picture is not a started clip', () => {
    expect(deriveScreen(st({ project: project({ step: 'storyboard' }), shots: [shot({ status: 'failed' })] }))).toBe('plan');
  });
  it('any clip started -> Watch and fix', () => {
    const base = { cast: [castRow()] };
    expect(deriveScreen(st({ ...base, project: project({ step: 'generate' }), shots: [shot({ status: 'queued', still_url: '/s.png' })] }))).toBe('watch');
    expect(deriveScreen(st({ ...base, project: project({ step: 'audio' }), shots: [shot({ status: 'generating', still_url: '/s.png' })] }))).toBe('watch');
    expect(deriveScreen(st({ ...base, project: project({ step: 'audio' }), shots: [shot({ status: 'ready', still_url: '/s.png' })] }))).toBe('watch');
    expect(deriveScreen(st({ ...base, project: project({ step: 'audio' }), shots: [shot({ status: 'failed', still_url: '/s.png' })], jobs: [{ kind: 'clip', status: 'failed' }] }))).toBe('watch');
    expect(deriveScreen(st({ project: project({ step: 'review' }), shots: [shot({ status: 'ready' })] }))).toBe('watch');
  });
});

describe('what the pipeline does next', () => {
  const ready = { still_url: '/s.png', status: 'still_ready' };

  it('the cast starts only with the fee the customer confirmed', () => {
    expect(nextPlanAction(st()).type).not.toBe('cast');
    expect(nextPlanAction(st(), { confirmed: {} }).type).not.toBe('cast');
    expect(nextPlanAction(st(), { confirmed: { fee: 90 } })).toEqual({ type: 'cast', expected: 90 });
    expect(nextPlanAction(st(), { confirmed: { fee: 0 } })).toEqual({ type: 'cast', expected: 0 });
  });
  it('different people in every scene: no cast stage, straight to the shots', () => {
    expect(nextPlanAction(st({ project: project({ consistent_cast: false }) }))).toEqual({ type: 'build' });
  });
  it('waits while characters are drawn', () => {
    const fresh = new Date().toISOString();
    expect(nextPlanAction(st({ cast: [castRow({ status: 'pending', chosen_index: null, image_url: null, updated_at: fresh })] }))).toMatchObject({ type: 'wait', what: ['characters'] });
  });
  it('a character that is ready with no look picked gets its first option picked (the pick call), never a spinner', () => {
    const open = castRow({ id: 'c9', name: 'Mia', chosen_index: null, image_url: null, candidates: [{ url: '/a.png' }, { url: '/b.png' }] });
    expect(nextPlanAction(st({ cast: [open] }))).toEqual({ type: 'pick', castId: 'c9', name: 'Mia' });
    // No options at all: nothing to pick, the customer is told.
    expect(nextPlanAction(st({ cast: [{ ...open, candidates: [] }] }))).toMatchObject({ type: 'blocked', what: ['characters'] });
  });
  it('a character left as a draft with nothing running is started again (no fee once cast rows exist); a fresh one is waited for', () => {
    const old = new Date(Date.now() - 10 * 60_000).toISOString();
    const draft = castRow({ status: 'draft', chosen_index: null, image_url: null, updated_at: old });
    expect(nextPlanAction(st({ cast: [draft] }))).toEqual({ type: 'resume_cast', expected: 0 });
    const running = [{ kind: 'cast_image', status: 'running', payload: { castId: draft.id } }];
    expect(nextPlanAction(st({ cast: [draft], jobs: running })).type).toBe('wait');
    expect(nextPlanAction(st({ cast: [{ ...draft, updated_at: new Date().toISOString() }] })).type).toBe('wait');
  });
  it('lists the free starts that need the customer\'s press first', () => {
    expect(FREE_STARTS.sort()).toEqual(['build', 'music', 'narration', 'pick', 'resume_cast', 'stills']);
  });
  it('a failed or blocked character stops the pipeline, it does not wait forever', () => {
    expect(nextPlanAction(st({ cast: [castRow({ status: 'failed', chosen_index: null, image_url: null })] }))).toMatchObject({ type: 'blocked', what: ['characters'] });
  });
  it('builds the shots once the cast is picked, and not before', () => {
    expect(nextPlanAction(st({ cast: [castRow()] }))).toEqual({ type: 'build' });
  });
  it('pictures start at 0 credits; a price nobody confirmed is asked, not sent', () => {
    const base = { cast: [castRow()], project: project({ step: 'storyboard' }) };
    const free = st({ ...base, shots: [shot({ id: 'a' }), shot({ id: 'b', ord: 1 })] });
    expect(nextPlanAction(free)).toEqual({ type: 'stills', ids: ['a', 'b'], expected: 0 });
    const paid = st({ ...base, shots: [shot({ id: 'a', still_credits: 2 })] });
    expect(nextPlanAction(paid)).toEqual({ type: 'ask', what: 'pictures', credits: 2, ids: ['a'] });
    expect(nextPlanAction(paid, { confirmed: { pictures: 2 } })).toEqual({ type: 'stills', ids: ['a'], expected: 2 });
    expect(nextPlanAction(paid, { confirmed: { pictures: 0 } }).type).toBe('ask');
  });
  it('waits for pictures being made, and never auto-retries a failed picture', () => {
    const base = { cast: [castRow()], project: project({ step: 'storyboard' }) };
    expect(nextPlanAction(st({ ...base, shots: [shot({ status: 'still_pending' })] }))).toMatchObject({ type: 'wait', what: ['pictures'] });
    expect(nextPlanAction(st({ ...base, shots: [shot({ status: 'failed' })] }))).toMatchObject({ type: 'blocked', what: ['pictures'] });
  });
  it('a script that changed after the shots were made asks for a rebuild first', () => {
    expect(nextPlanAction(st({ cast: [castRow()], shots: [shot({ ...ready, needs_rebuild: true })] }))).toEqual({ type: 'stale' });
  });
  it('then the narration and the music, with the audio view prices', () => {
    const shots = [shot(ready)];
    const base = { cast: [castRow()], project: project({ step: 'storyboard' }), shots };
    expect(nextPlanAction(st({ ...base, audio: audio({ status: 'none' }) }))).toEqual({ type: 'narration', expected: 0 });
    expect(nextPlanAction(st({ ...base, audio: audio({}, { status: 'none' }) }))).toEqual({ type: 'music', expected: 0 });
    expect(nextPlanAction(st({ ...base, audio: audio({ status: 'none', credits: 5 }) }))).toEqual({ type: 'ask', what: 'voice', credits: 5 });
    expect(nextPlanAction(st({ ...base, audio: audio({ status: 'none', credits: 5 }) }), { confirmed: { voice: 5 } })).toEqual({ type: 'narration', expected: 5 });
  });
  it('no narration for a talking video or one with no narrator lines; no music when music is off', () => {
    const base = { cast: [castRow()], project: project({ step: 'storyboard', mode: 'talking' }), shots: [shot(ready)] };
    const talking = { applicable: { narration: false, narrationLines: 0 }, narration: { status: 'none', credits: 0 }, music: { type: 'none', status: 'none', credits: 0 } };
    expect(nextPlanAction(st({ ...base, audio: talking }))).toEqual({ type: 'done' });
  });
  it('audio starts while pictures are still being drawn (it does not need the cast)', () => {
    const a = nextPlanAction(st({ cast: [castRow({ status: 'pending', chosen_index: null, image_url: null })], audio: audio({ status: 'none' }) }));
    expect(a).toEqual({ type: 'narration', expected: 0 });
  });
  it('pending voice or music is waited for; a failed one is left for the customer', () => {
    const base = { cast: [castRow()], shots: [shot(ready)], project: project({ step: 'storyboard' }) };
    expect(nextPlanAction(st({ ...base, audio: audio({ status: 'pending' }) }))).toMatchObject({ type: 'wait', what: ['voice'] });
    expect(nextPlanAction(st({ ...base, audio: audio({}, { status: 'failed' }) }))).toMatchObject({ type: 'blocked', what: ['music'] });
  });
  it('done when every part exists', () => {
    expect(nextPlanAction(st({ cast: [castRow()], shots: [shot(ready)], project: project({ step: 'audio' }) }))).toEqual({ type: 'done' });
  });
  it('resumes from every mid pipeline state without repeating a finished part', () => {
    const types = [
      [st(), { fee: 90 }, 'cast'],
      [st({ cast: [castRow({ status: 'pending', chosen_index: null, image_url: null })], audio: audio() }), {}, 'wait'],
      [st({ cast: [castRow()] }), {}, 'build'],
      [st({ cast: [castRow()], shots: [shot()] }), {}, 'stills'],
      [st({ cast: [castRow()], shots: [shot(ready)], audio: audio({ status: 'none' }) }), {}, 'narration'],
      [st({ cast: [castRow()], shots: [shot(ready)], audio: audio({}, { status: 'none' }) }), {}, 'music'],
      [st({ cast: [castRow()], shots: [shot(ready)] }), {}, 'done'],
    ];
    for (const [status, confirmed, type] of types) expect(nextPlanAction(status, { confirmed }).type).toBe(type);
  });
  it('names a start so it is never sent twice', () => {
    expect(actionKey({ type: 'cast' })).toBe('cast');
    expect(actionKey({ type: 'stills', ids: ['a', 'b'] })).toBe('stills:a,b');
    expect(actionKey({ type: 'wait' })).toBe('');
    expect(actionKey({ type: 'ask' })).toBe('');
  });
  it('reads the confirmed amounts from a quote', () => {
    expect(confirmedFrom({ castFee: 90, stills: 0, lines: [{ key: 'voice', credits: 0 }, { key: 'music', credits: 0 }] })).toEqual({ fee: 90, pictures: 0, voice: 0, music: 0 });
  });
});

describe('scenes', () => {
  const s = (id, ord, scene, status, over = {}) => shot({ id, ord, scene_id: scene, status, still_url: '/x.png', clip_credits: status === 'still_ready' || status === 'failed' ? 30 : null, ...over });
  it('groups shots by scene and gives each scene a state', () => {
    const scenes = scenesOf([s('1', 0, 'a', 'ready', { clip_url: '/1.mp4' }), s('2', 1, 'a', 'ready', { clip_url: '/2.mp4' }), s('3', 2, 'b', 'generating'), s('4', 3, 'c', 'still_ready'), s('5', 4, 'd', 'failed')]);
    expect(scenes.map((x) => [x.n, x.state])).toEqual([[1, 'ready'], [2, 'making'], [3, 'waiting'], [4, 'failed']]);
    expect(scenes[0].readyShots).toHaveLength(2);
    expect(scenes[2].startIds).toEqual(['4']);
    expect(scenes[3].startIds).toEqual(['5']);
  });
  it('the next scene is the first one waiting, and it says how many are waiting', () => {
    const scenes = scenesOf([s('1', 0, 'a', 'ready', { clip_url: '/1.mp4' }), s('2', 1, 'b', 'still_ready'), s('3', 2, 'c', 'still_ready')]);
    const { next, waitingCount } = nextScenes(scenes);
    expect(next.n).toBe(2);
    expect(waitingCount).toBe(2);
  });
});

describe('the final render starts by itself only when it should', () => {
  const ready = (id, ord) => shot({ id, ord, status: 'ready', still_url: '/s.png', clip_url: '/c.mp4' });
  const clipJob = (at) => ({ kind: 'clip', status: 'done', updated_at: at });
  const base = () => st({ project: project({ step: 'review' }), shots: [ready('1', 0), ready('2', 1)], jobs: [clipJob('2026-11-16T10:00:00Z')], render: null, renderPrice: { credits: 0 } });
  it('every clip ready, no render, the included price: yes', () => {
    expect(shouldAutoRender(base())).toBe(true);
  });
  it('not while a clip is missing, a render runs, or the voice is still being made', () => {
    expect(shouldAutoRender({ ...base(), shots: [ready('1', 0), shot({ id: '2', ord: 1, status: 'generating' })] })).toBe(false);
    expect(shouldAutoRender({ ...base(), render: { status: 'running', created_at: '2026-11-16T11:00:00Z' } })).toBe(false);
    expect(shouldAutoRender({ ...base(), audio: audio({ status: 'pending' }) })).toBe(false);
  });
  it('not when a render already covers the current clips (done or failed)', () => {
    expect(shouldAutoRender({ ...base(), render: { status: 'done', created_at: '2026-11-16T11:00:00Z' } })).toBe(false);
    expect(shouldAutoRender({ ...base(), render: { status: 'failed', created_at: '2026-11-16T11:00:00Z' } })).toBe(false);
  });
  it('not while the voice or music is missing or failed, nor while a clip is out of date', () => {
    expect(shouldAutoRender({ ...base(), audio: audio({ status: 'failed' }) })).toBe(false);
    expect(shouldAutoRender({ ...base(), audio: audio({}, { status: 'none' }) })).toBe(false);
    expect(shouldAutoRender({ ...base(), shots: [{ ...ready('1', 0), stale: true }, ready('2', 1)] })).toBe(false);
    expect(shouldAutoRender({ ...base(), shots: [{ ...ready('1', 0), needs_rebuild: true }, ready('2', 1)] })).toBe(false);
  });
  it('never when a finished render exists, whatever the price', () => {
    expect(shouldAutoRender({ ...base(), renders: [{ status: 'done', created_at: '2026-11-16T05:00:00Z' }] })).toBe(false);
  });
  it('a later render has a price and needs a click', () => {
    expect(shouldAutoRender({ ...base(), render: { status: 'done', created_at: '2026-11-16T09:00:00Z' }, renderPrice: { credits: 5 } })).toBe(false);
    expect(shouldAutoRender({ ...base(), renderPrice: null })).toBe(false);
  });
});

describe('voice and music that block the video', () => {
  it('lists what is missing, failed or blocked, with the price of the button that fixes it', () => {
    expect(audioIssues(audio())).toEqual([]);
    expect(audioIssues(audio({ status: 'none', credits: 5 }))).toEqual([{ kind: 'voice', status: 'none', credits: 5, retry: false }]);
    expect(audioIssues(audio({ status: 'failed', credits: 5, retry_credits: 0 }, { status: 'blocked', credits: 5 }))).toEqual([
      { kind: 'voice', status: 'failed', credits: 0, retry: true }, { kind: 'music', status: 'blocked', credits: 5, retry: false },
    ]);
    expect(audioIssues(audio({ status: 'pending' }))).toEqual([]);
  });
  it('a talking video has no voice to wait for, and music that is off is not missing', () => {
    expect(audioIssues({ applicable: { narration: false, narrationLines: 0 }, narration: { status: 'none' }, music: { type: 'none', status: 'none' } })).toEqual([]);
  });
});

describe('scenes that are out of date', () => {
  it('a ready clip whose picture or script changed is out of date, and offers its own start ids', () => {
    const r = shot({ id: '1', ord: 0, scene_id: 'a', status: 'ready', still_url: '/x', clip_url: '/c.mp4', stale: true, clip_credits: 33 });
    const [scene] = scenesOf([r]);
    expect(scene.state).toBe('outdated');
    expect(scene.startIds).toEqual(['1']);
  });
  it('a blocked clip is a failed scene that carries the server words, even with nothing to start', () => {
    const [scene] = scenesOf([shot({ id: '1', status: 'blocked', still_url: '/x', error: 'The picture was blocked.', clip_credits: null })]);
    expect(scene).toMatchObject({ state: 'failed', blocked: true, error: 'The picture was blocked.', startIds: [] });
  });
});

describe('small helpers', () => {
  it('prices a length at a quality with the setup fee until it is paid', () => {
    const p = { fee_charged: false };
    const full = lengthCredits(DEFAULTS, p, 30, 'standard');
    expect(full).toBe(DEFAULTS.projectFee + DEFAULTS.perSecond.standard * 30);
    expect(lengthCredits(DEFAULTS, { fee_charged: true }, 30, 'standard')).toBe(full - DEFAULTS.projectFee);
  });
});
