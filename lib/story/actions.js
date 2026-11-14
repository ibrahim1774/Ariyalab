/*
 * The action table behind POST/PATCH/GET /api/story/projects/[id]/[action]
 * (lib/story/actionRoute.js handleAction). Each lib/story module
 * registers its own actions when it is imported:
 *
 *   registerAction('script', { method: 'POST', handler: async (ctx) => ({ script }) });
 *
 *   method   'GET' | 'POST' | 'PATCH' | 'DELETE'. One name can be registered
 *            once per method (e.g. GET and POST 'script').
 *   status   success status, default 200.
 *   handler  async ({ userId, user, projectId, project, body, req }) -> JSON body.
 *            userId is the signed-in user, user the session user object,
 *            projectId the [id] segment, project that project's row (the
 *            route has already checked it is the caller's; services check
 *            again), body the parsed JSON object ({} if none).
 *            Throw any lib/story error; the route maps it with sendError.
 *
 * This module imports nothing, so feature modules can import it freely.
 */

const METHODS = ['GET', 'POST', 'PATCH', 'DELETE'];
const NAME = /^[a-z][a-z0-9-]*$/;

function table() {
  // On globalThis so a module loaded twice (dev bundles) shares one table.
  if (!globalThis.__storyActions) globalThis.__storyActions = new Map();
  return globalThis.__storyActions;
}

export function registerAction(name, { method, handler, status = 200 } = {}) {
  if (!NAME.test(String(name))) throw new TypeError(`Invalid action name: ${name}`);
  if (!METHODS.includes(method)) throw new TypeError(`Invalid method for action ${name}: ${method}`);
  if (typeof handler !== 'function') throw new TypeError(`Action ${name} needs a handler`);
  const byMethod = table().get(name) || Object.create(null);
  byMethod[method] = { handler, status };
  table().set(name, byMethod);
}

/** The definition for name + method, or null. */
export function getAction(name, method) {
  return (METHODS.includes(method) && table().get(name)?.[method]) || null;
}

/** Methods registered for a name ([] when the action does not exist). */
export function getActionMethods(name) {
  return Object.keys(table().get(name) || {});
}
