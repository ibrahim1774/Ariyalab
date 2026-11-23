/*
 * "Has this customer already been inside the story maker in this tab?" Kept in memory only, so a fresh tab or a full
 * page load starts clean. AppShell sets it on any /app page other than the home and when a link leaves /app;
 * the /app home reads it so an old-plan customer who clicks around inside the app is never sent away.
 */
let inApp = false;

export function markInApp() {
  inApp = true;
}

export function wasInApp() {
  return inApp;
}

export function _resetInApp() {
  inApp = false;
}
