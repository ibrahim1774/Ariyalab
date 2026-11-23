/*
 * "Has this customer already chosen the story maker in this tab?" Kept in sessionStorage (this tab only, survives a reload),
 * with a memory copy for when storage is unavailable. AppShell sets it on any /app page other than the home and when a link
 * moves within /app; the /app home sets it for ?maker=1 and reads it so an old-plan customer is never bounced out of the
 * story maker. Signing out clears it (lib/signOut.js), so the next person on the tab is treated fresh.
 */
const KEY = 'ariya_in_app';
let inApp = false;

export function markInApp() {
  inApp = true;
  try { window.sessionStorage.setItem(KEY, '1'); } catch {}
}

export function wasInApp() {
  if (inApp) return true;
  try { return window.sessionStorage.getItem(KEY) === '1'; } catch { return false; }
}

export function clearInApp() {
  inApp = false;
  try { window.sessionStorage.removeItem(KEY); } catch {}
}

export const _resetInApp = clearInApp;
