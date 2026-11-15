/*
 * Who is an admin. Import-free so middleware (edge runtime) can use it.
 *
 * ADMIN_EMAILS (comma-separated) is the only source: there is no built-in
 * address. An admin must also have a CONFIRMED email (Supabase sets
 * email_confirmed_at, older accounts confirmed_at), because the admin tier
 * spends real provider money without limit and the admin tools move credits
 * between accounts. Anyone can sign up with an address they do not own.
 */

/** The configured admin emails, lower-cased. [] when ADMIN_EMAILS is unset or blank. */
export function adminEmails() {
  return String(process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function isEmailConfirmed(user) {
  return Boolean(user?.email_confirmed_at || user?.confirmed_at);
}

/** True only for a user object whose confirmed email is in ADMIN_EMAILS. */
export function isConfirmedAdmin(user) {
  const email = String(user?.email || '').trim().toLowerCase();
  if (!email || !isEmailConfirmed(user)) return false;
  return adminEmails().includes(email);
}
