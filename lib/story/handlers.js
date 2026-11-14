/*
 * Job handler registry entry point. lib/story/runner.js imports this file
 * (lazily, once) before it claims, polls or finishes jobs, so every route
 * that calls tick, sweep or handleProviderCallback sees every handler.
 *
 * Each task that adds a job kind imports its module here; the module calls
 * registerHandler(kind, { ... }) from lib/story/runner.js at load time:
 *
 *   import './jobs/clip.js';
 */
