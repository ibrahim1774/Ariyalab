import { getBrowserSupabase } from './supabase';
import { clearInApp } from './appVisit';
import { _resetLegacyPlan } from './useLegacyPlan';

/** Sign the visitor out and send them to the home page. Shared by the site nav and the app shell. */
export async function signOutAndGoHome(router) {
  const supabase = getBrowserSupabase();
  if (!supabase) return;
  await supabase.auth.signOut();
  clearInApp();
  _resetLegacyPlan();
  router.push('/');
}
