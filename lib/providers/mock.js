/*
 * Mock mode (process.env.STORY_MOCK === '1'): every provider returns
 * deterministic fixtures from tests/fixtures/ and never touches the network.
 *
 * State lives on globalThis so it is shared between Next API-route bundles in
 * dev (each route gets its own copy of this module).
 *
 * Tokens an input can carry to exercise other paths:
 *   [[mock:blocked]]      submitImage/submitClip prompt: second poll returns
 *                         'blocked'; completeJSON/chatWithTools (system or
 *                         messages): throws ProviderError 'blocked'
 *   [[mock:fail]]         submitImage/submitClip prompt: second poll returns 'failed'
 *   [[mock:silent-reel]]  fetchReference url: returns a silent video plus a
 *                         separate audioPath (exercises the mux path)
 *
 * Mock media URLs are RELATIVE (/api/mock/fixtures/<file>, served by a
 * dev-only route). Use localPathFor(url) / toAbsoluteUrl(url, origin) from
 * storage.js instead of fetching them.
 */

import path from 'node:path';

import { SAFE_MESSAGES } from './errors.js';

export const MOCK_BLOCKED = '[[mock:blocked]]';
export const MOCK_FAIL = '[[mock:fail]]';
export const MOCK_SILENT_REEL = '[[mock:silent-reel]]';

let warnedProdMock = false;

/**
 * True in mock mode. Never on the production deployment (VERCEL_ENV=production): there STORY_MOCK would charge real
 * credits for fixture clips and skip the model layer of moderation, so it is ignored and logged (final review M4).
 */
export function isMock() {
  if (process.env.STORY_MOCK !== '1') return false;
  if (process.env.VERCEL_ENV === 'production') {
    if (!warnedProdMock) console.error('[story] STORY_MOCK=1 is ignored on the production deployment; unset it');
    warnedProdMock = true;
    return false;
  }
  return true;
}

export const FIXTURES_DIR = path.join(process.cwd(), 'tests', 'fixtures');

export const MOCK_FIXTURE_PREFIX = '/api/mock/fixtures/';
export const FIXTURE_FILES = ['clip.mp4', 'still.png', 'voice.mp3', 'music.mp3', 'reference.mp4', 'reference-silent.mp4'];

/** Relative URLs of the fixtures, served in dev by pages/api/mock/fixtures/[file].js. */
export const MOCK_URLS = {
  clip: `${MOCK_FIXTURE_PREFIX}clip.mp4`,
  still: `${MOCK_FIXTURE_PREFIX}still.png`,
  voice: `${MOCK_FIXTURE_PREFIX}voice.mp3`,
  music: `${MOCK_FIXTURE_PREFIX}music.mp3`,
  reference: `${MOCK_FIXTURE_PREFIX}reference.mp4`,
};

export function fixturePath(file) {
  return path.join(FIXTURES_DIR, file);
}

/**
 * Maps a fixture URL path (/api/mock/fixtures/<file>, or the older
 * /mock/<file>) to its file on disk; null for anything else.
 */
export function fixturePathForUrl(urlPath) {
  const m = /^\/(?:api\/mock\/fixtures|mock)\/([a-z-]+\.(?:mp4|png|mp3))$/.exec(String(urlPath || ''));
  return m && FIXTURE_FILES.includes(m[1]) ? fixturePath(m[1]) : null;
}

/** True when a mock-mode input (string or any JSON value) carries `token`. */
export function hasMockToken(value, token) {
  if (value === undefined || value === null) return false;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.includes(token);
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
