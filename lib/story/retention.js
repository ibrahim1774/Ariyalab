import { deleteObjects, listObjects } from '../providers/storage.js';
import { storyDb } from './db.js';

/*
 * Retention cleanup (spec 10.10; Task 27), run daily by /api/cron/story-cleanup.
 *
 * 1. Expired projects (story_projects.files_expire_at passed, moved on by the runner at each stored file
 *    from pricing_config retentionDays; no job queued or running), oldest
 *    first: every storage key the project's rows name (story_project_file_keys:
 *    narration, music, thumbnail, shot stills and clips, cast pictures and
 *    candidates, renders, reference files and frames, job results) plus every
 *    object under story/<projectId>/ and story-uploads/<projectId>/ (aborted
 *    uploads, files no row names) is deleted, EXCEPT a key that
 *    story_keys_in_use keeps:
 *      - any story_assets.storage_key (the brand kit and the customer's own
 *        files never expire with a project; an own-picture cast row stores the
 *        asset's key as its image_key), and
 *      - a key another project that is not expired still names (duplicates
 *        share keys: refcount).
 *    The project is marked 'expired' (the status the UI reads) BEFORE any
 *    delete, and only when no job is queued or running; from then on paid
 *    starts on it are refused. Before each delete chunk the project's jobs
 *    and the refcount are checked again. Once every delete succeeded,
 *    files_expire_at is cleared, so a file stored later starts a fresh window;
 *    a run that did not finish is repeated the next day.
 * 2. Orphans under story-brand/<userId>/ and story-audio/<userId>/ older than
 *    ORPHAN_AGE_MS that no story_assets row (and no unexpired project) names:
 *    uploads whose registration failed (moderation 503, timeout, failed insert).
 *
 * Bounded per run (projects, listing pages, a deadline). Idempotent: deleting
 * a missing object is not an error.
 */

export const ORPHAN_AGE_MS = 24 * 60 * 60 * 1000;
const ORPHAN_PREFIXES = ['story-brand/', 'story-audio/'];
const RUN_BUDGET_MS = 50_000;
const MAX_PAGES = 20;
const CHUNK = 500;

async function listAll(prefix, { list, deadline, maxPages = MAX_PAGES }) {
  const out = [];
  let cursor = null;
  for (let page = 0; page < maxPages; page += 1) {
    if (Date.now() > deadline) return { objects: out, complete: false };
    const res = await list({ prefix, cursor });
    out.push(...(res.objects || []));
    cursor = res.cursor;
    if (!cursor) return { objects: out, complete: true };
  }
  return { objects: out, complete: false };
}

async function keysInUse(keys, projectId) {
  const used = new Set();
  for (let i = 0; i < keys.length; i += CHUNK) {
    const rows = await storyDb().rpc('story_keys_in_use', { p_keys: keys.slice(i, i + CHUNK), p_project: projectId });
    for (const r of rows) used.add(r.story_keys_in_use ?? Object.values(r)[0]);
  }
  return used;
}

async function deleteKeys(keys, del) {
  let n = 0;
  for (let i = 0; i < keys.length; i += CHUNK) n += Number(await del({ keys: keys.slice(i, i + CHUNK) })) || 0;
  return n;
}

export async function runRetention({
  limit = 25,
  budgetMs = RUN_BUDGET_MS,
  orphanAgeMs = ORPHAN_AGE_MS,
  now = Date.now(),
  list = listObjects,
  del = deleteObjects,
} = {}) {
  const deadline = Date.now() + budgetMs;
  const summary = { projects: 0, expired: 0, deleted: 0, kept: 0, orphans: 0, failed: 0, incomplete: false };

  const due = await storyDb().rpc('story_retention_due', { p_limit: limit });
  for (const project of due) {
    if (Date.now() > deadline) {
      summary.incomplete = true;
      break;
    }
    summary.projects += 1;
    try {
      // Marked expired FIRST (refused while a job is queued or running): from
      // here every paid start on it is refused, so nothing new reads the files.
      if (!(await storyDb().rpc('story_expire_project', { p_project: project.id }))) continue;
      summary.expired += 1;
      const named = (await storyDb().rpc('story_project_file_keys', { p_project: project.id }))
        .map((r) => r.story_project_file_keys ?? Object.values(r)[0])
        .filter(Boolean);
      const listed = [];
      let complete = true;
      for (const prefix of [`story/${project.id}/`, `story-uploads/${project.id}/`]) {
        const res = await listAll(prefix, { list, deadline });
        listed.push(...res.objects.map((o) => o.key));
        complete = complete && res.complete;
      }
      const candidates = [...new Set([...named, ...listed])];
      const used = await keysInUse(candidates, project.id);
      const doomed = candidates.filter((k) => !used.has(k));
      summary.kept += candidates.length - doomed.length;
      for (let i = 0; i < doomed.length; i += CHUNK) {
        // Just before each delete: a job that started anyway, or a copy that
        // now names a key, keeps the files (the next run tries again).
        if (await storyDb().rpc('story_project_busy', { p_project: project.id })) {
          complete = false;
          break;
        }
        const chunk = doomed.slice(i, i + CHUNK);
        const stillUsed = await keysInUse(chunk, project.id);
        const toDelete = chunk.filter((k) => !stillUsed.has(k));
        summary.kept += chunk.length - toDelete.length;
        if (toDelete.length) summary.deleted += Number(await del({ keys: toDelete })) || 0;
      }
      if (!complete) {
        summary.incomplete = true;
        continue;
      }
      // Every delete done: a file stored later starts a fresh window.
      await storyDb().rpc('story_retention_done', { p_project: project.id });
    } catch (err) {
      summary.failed += 1;
      console.error('[retention] project cleanup failed', project.id, err?.message);
    }
  }

  // Orphans of failed registrations (brand kit and audio uploads).
  for (const prefix of ORPHAN_PREFIXES) {
    if (Date.now() > deadline) {
      summary.incomplete = true;
      break;
    }
    try {
      const res = await listAll(prefix, { list, deadline });
      if (!res.complete) summary.incomplete = true;
      const old = res.objects.filter((o) => now - Date.parse(o.uploadedAt) > orphanAgeMs).map((o) => o.key);
      if (!old.length) continue;
      const used = await keysInUse(old, null);
      const doomed = old.filter((k) => !used.has(k));
      summary.orphans += await deleteKeys(doomed, del);
    } catch (err) {
      summary.failed += 1;
      console.error('[retention] orphan sweep failed', prefix, err?.message);
    }
  }
  return summary;
}
