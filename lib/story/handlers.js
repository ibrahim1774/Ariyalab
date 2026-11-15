/*
 * Job handler registry entry point. lib/story/runner.js imports this file
 * (lazily, once) before it claims, polls or finishes jobs, so every route
 * that drives the runner sees every handler.
 *
 * Each task that adds a job kind imports its module here (the module calls
 * registerHandler(kind, { ... }) from lib/story/runner.js at load time) and
 * removes the kind from KINDS_REGISTERED_LATER. tests/story/runner.test.js
 * checks that every job kind is in one place or the other.
 *
 *   import './jobs/clip.js';
 */

import './castJobs.js'; // cast_image (candidate pictures and the cast sheet)

export const KINDS_REGISTERED_LATER = Object.freeze([
  'analyze', 'script', 'still', 'clip', 'narration', 'music', 'voice_clone', 'render',
]);
