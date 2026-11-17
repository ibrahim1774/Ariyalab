import { getBrowserSupabase } from './supabase';

/** Sign the visitor out and send them to the home page. Shared by the site nav and the app shell. */
export async function signOutAndGoHome(router) {
  const supabase = getBrowserSupabase();
  if (!supabase) return;
  await supabase.auth.signOut();
  router.push('/');
}
