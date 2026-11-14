/*
 * Mock mode (process.env.STORY_MOCK === '1'): every provider returns
 * deterministic fixtures from tests/fixtures/ and never touches the network.
 *
 * State lives on globalThis so it is shared between Next API-route bundles in
 * dev (each route gets its own copy of this module).
 *
 * Tokens a prompt can carry to exercise failure paths in async tasks:
 *   [[mock:blocked]]  -> second poll returns status 'blocked'
 *   [[mock:fail]]     -> second poll returns status 'failed'
 */

import path from 'node:path';

import { SAFE_MESSAGES } from './errors.js';

export const MOCK_BLOCKED = '[[mock:blocked]]';
export const MOCK_FAIL = '[[mock:fail]]';

export function isMock() {
  return process.env.STORY_MOCK === '1';
}

export const FIXTURES_DIR = path.join(process.cwd(), 'tests', 'fixtures');

/** Public URLs of the fixtures (copies live in public/mock/). */
export const MOCK_URLS = {
  clip: '/mock/clip.mp4',
  still: '/mock/still.png',
  voice: '/mock/voice.mp3',
  music: '/mock/music.mp3',
  reference: '/mock/reference.mp4',
};

export function fixturePath(file) {
  return path.join(FIXTURES_DIR, file);
}

/** Maps a /mock/<file> URL back to its fixture on disk, or null. */
export function fixturePathForUrl(url) {
  const m = /^\/mock\/([a-z]+\.(?:mp4|png|mp3))$/.exec(String(url || ''));
  return m ? fixturePath(m[1]) : null;
}

function state() {
  if (!globalThis.__storyProviderMock) {
    globalThis.__storyProviderMock = { counters: {}, polls: {}, registry: new Map() };
  }
  return globalThis.__storyProviderMock;
}

export function nextMockNumber(kind) {
  const s = state();
  s.counters[kind] = (s.counters[kind] || 0) + 1;
  return s.counters[kind];
}

/** A task id like mock-clip-3 (with -blocked / -fail when the prompt asks). */
export function mockTaskId(kind, prompt = '') {
  const n = nextMockNumber(kind);
  const p = String(prompt || '');
  const suffix = p.includes(MOCK_BLOCKED) ? '-blocked' : p.includes(MOCK_FAIL) ? '-fail' : '';
  return `mock-${kind}-${n}${suffix}`;
}

/** First poll: pending. Second and later: done (or blocked/failed). */
export function pollMockTask(taskId, url) {
  const s = state();
  s.polls[taskId] = (s.polls[taskId] || 0) + 1;
  if (s.polls[taskId] < 2) return { status: 'pending', url: null, error: null };
  if (taskId.endsWith('-blocked')) return { status: 'blocked', url: null, error: SAFE_MESSAGES.blocked };
  if (taskId.endsWith('-fail')) return { status: 'failed', url: null, error: SAFE_MESSAGES.failed };
  return { status: 'done', url, error: null };
}

/** Later tasks register canned completeJSON responses by schema name. */
export function registerMock(name, fn) {
  if (typeof fn !== 'function') throw new TypeError(`registerMock(${name}) needs a function`);
  state().registry.set(name, fn);
}

export function hasMock(name) {
  return state().registry.has(name);
}

export function mockResponder(name, input) {
  const fn = state().registry.get(name);
  if (!fn) {
    throw new Error(
      `No mock registered for "${name}". Call registerMock('${name}', fn) from lib/providers/mock.js before using it in mock mode.`,
    );
  }
  return fn(input);
}

export function unregisterMock(name) {
  state().registry.delete(name);
}

/**
 * Test helper: clears task counters and poll counts. Registered mocks are
 * kept, because modules register them once at import time.
 */
export function _resetMocks() {
  const s = state();
  s.counters = {};
  s.polls = {};
}
