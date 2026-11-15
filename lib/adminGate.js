import { getUserFromRequest } from './supabaseServer.js';
import { adminEmails, isConfirmedAdmin } from './adminEmails.js';

/*
 * The one admin gate for admin API routes and the /admin page.
 *   503  ADMIN_EMAILS is not set (admin tools are off; no built-in address)
 *   401  no session
 *   403  signed in, but the email is not in ADMIN_EMAILS or not confirmed
 */

/** { status: 200, user } or { status, error, code } without responding. Works in getServerSideProps. */
export async function checkAdmin(req, res) {
  if (!adminEmails().length) {
    return { status: 503, error: 'Admin tools are disabled: ADMIN_EMAILS is not set.' };
  }
  const session = await getUserFromRequest(req, res);
  if (!session?.user) return { status: 401, error: 'Authentication required.' };
  if (!isConfirmedAdmin(session.user)) return { status: 403, error: 'Admin only.', code: 'NOT_ADMIN' };
  return { status: 200, user: session.user, supabase: session.supabase };
}

/** For API routes: { user, supabase }, or null after answering 401 / 403 / 503. */
export async function requireAdmin(req, res) {
  const gate = await checkAdmin(req, res);
  if (gate.status === 200) return { user: gate.user, supabase: gate.supabase };
  res.status(gate.status).json(gate.code ? { error: gate.error, code: gate.code } : { error: gate.error });
  return null;
}

// The Supabase project is shared with haelabs.live, so the user list is long:
// read every page until Supabase reports no next page. "Not found" is only
// answered after the last page; if the page bound is ever hit the search is
// reported as incomplete (UserSearchIncompleteError), never as "no user".
export const USERS_PER_PAGE = 1000;
export const MAX_USER_PAGES = 200;
export class UserSearchIncompleteError extends Error {
  constructor() {
    super(`Account search incomplete: more than ${MAX_USER_PAGES * USERS_PER_PAGE} users were read.`);
    this.name = 'UserSearchIncompleteError';
  }
}

/** The auth user with this email (case-insensitive), or null after the last page. */
export async function findUserByEmail(admin, email) {
  const wanted = String(email || '').trim().toLowerCase();
  for (let page = 1; page <= MAX_USER_PAGES; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: USERS_PER_PAGE });
    if (error) throw new Error(`User lookup failed: ${error.message}`);
    const hit = (data?.users || []).find((u) => (u.email || '').toLowerCase() === wanted);
    if (hit) return hit;
    if (data?.nextPage == null) return null;
  }
  throw new UserSearchIncompleteError();
}
