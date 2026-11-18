import { storyDb } from './db.js';

/*
 * What a character's cast sheet is doing, for the screens and for the start rule of scene pictures (storyboard.js):
 *   ready    the sheet for the picked picture exists (story_cast.sheet.url)
 *   making   a sheet job for the picked picture is queued, running, or finished and not yet written
 *   failed   a sheet job for the picked picture ended without a sheet (failed, blocked or discarded)
 *   none     no sheet and no sheet job: the character has no pick yet, or uses the customer's own picture, or hit the sheet limit
 * Only `making` makes a scene picture wait. `failed` and `none` fall back to the picked picture as the reference.
 */

const inFlight = (j) => j.status === 'queued' || j.status === 'running' || (j.status === 'done' && !j.applied_at);

export function sheetStateOf(row, jobs = []) {
  if (row?.sheet?.url) return 'ready';
  if (!row?.image_key && !row?.image_url) return 'none';
  const mine = jobs.filter((j) => j.payload?.stage === 'sheet' && j.payload?.castId === row.id && (!row.image_key || j.payload?.fromKey === row.image_key));
  if (mine.some(inFlight)) return 'making';
  return mine.length ? 'failed' : 'none';
}

/** Adds `sheet_state` to a cast row or to a list of them (one read of the project's cast jobs). */
export async function withSheetStates(rows) {
  const list = Array.isArray(rows) ? rows : [rows];
  const projectId = list.find((r) => r?.project_id)?.project_id;
  const jobs = projectId ? await storyDb().select('story_jobs', { project_id: projectId, kind: 'cast_image' }) : [];
  const out = list.map((r) => ({ ...r, sheet_state: sheetStateOf(r, jobs) }));
  return Array.isArray(rows) ? out : out[0];
}
