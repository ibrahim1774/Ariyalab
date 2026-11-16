// Turns a StoryApiError (lib/story/client.js) into what the customer sees:
// a title, a message and one next action. Pure, so tests can call it directly.

export function signInHref(returnTo) {
  const path = typeof returnTo === 'string' && returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/app';
  return `/sign-in?returnTo=${encodeURIComponent(path)}`;
}

// Account-wide daily caps. script_write is counted per video, so it has its own wording.
const LIMIT_NOUN = { project_create: ['new video', 'new videos'], reference_analysis: ['video analysis', 'video analyses'] };

/** Says what the daily limit counts when the server tells us the limit and the action. */
function dailyLimitMessage(body) {
  const n = Number(body?.limit);
  if (!Number.isFinite(n)) return 'You have reached today\u2019s limit. Come back tomorrow, or pick a plan for more.';
  if (body?.action === 'script_write') {
    return `You have rewritten this video\u2019s script ${n} ${n === 1 ? 'time' : 'times'} today. Edit the scenes directly, come back tomorrow, or pick a plan for more.`;
  }
  const [one, many] = LIMIT_NOUN[body?.action] || ['try', 'tries'];
  return `You have used your ${n} ${n === 1 ? one : many} for today. Come back tomorrow, or pick a plan for more.`;
}

const num = (n) => Number(n || 0).toLocaleString();

/**
 * -> { title, message, action: { label, href } | null, refresh: boolean, signIn: boolean, field: string|null }
 * `refresh` means the screen should reload its data (a 409). `signIn` means send the customer to sign in.
 */
export function describeError(err, { returnTo } = {}) {
  const status = err?.status ?? 0;
  const code = err?.code || '';
  const server = (err?.serverMessage || '').trim();
  const out = { title: '', message: '', action: null, refresh: false, signIn: false, field: err?.field || null };

  // Codes first: the same status can mean different things (a 429 is a daily limit or a chat limit).
  if (code === 'daily_limit') {
    return { ...out, title: 'Daily limit reached', message: dailyLimitMessage(err?.body), action: { label: 'See plans', href: '/app/billing' } };
  }
  if (code === 'chat_limit') {
    return { ...out, title: 'Chat limit reached', message: 'This video has used all its included changes.', action: { label: 'See plans', href: '/app/billing' } };
  }
  if (code === 'script_blocked') {
    return { ...out, title: 'That script could not be written', message: server || 'Change the brief and try again.', action: { label: 'Edit the brief', step: 'purpose' } };
  }
  if (code === 'provider_failed') {
    return { ...out, title: 'That did not work', message: server || 'Something went wrong while making that. Please try again.', action: { label: 'Try again', retry: true } };
  }
  if (code === 'retry_not_available') {
    return { ...out, title: 'Nothing to try again', message: server || 'Describe a change and make new pictures instead.', refresh: true };
  }
  if (code === 'sheet_limit') {
    return { ...out, title: 'Character sheet limit reached', message: server || 'Your pick is saved. Make new pictures to get a new character sheet.', refresh: true };
  }
  if (code === 'rebuild_loses_clips') {
    const n = Number(err?.body?.count);
    const what = Number.isFinite(n) && n > 0 ? `${n} finished ${n === 1 ? 'clip' : 'clips'}` : 'finished clips';
    return { ...out, title: 'Finished clips would be replaced', message: `This rebuild replaces ${what}. Confirm to rebuild anyway.` };
  }
  if (code === 'needs_rebuild') {
    return { ...out, title: 'Rebuild the storyboard first', message: server || 'Your script changed since the storyboard was made.', action: { label: 'Go to the storyboard', step: 'storyboard' } };
  }
  if (code === 'already_ready' || code === 'reroll_not_available') {
    return { ...out, title: 'This shot cannot be made that way', message: server || 'Reload to see where this shot is.', refresh: true };
  }
  if (code === 'quote_changed') {
    return { ...out, title: 'The price changed', message: server || 'Check the new total below, then confirm again.', refresh: true };
  }

  if (status === 401) {
    return { ...out, title: 'Please sign in', message: 'Your session ended. Sign in again and you will come right back here.', action: { label: 'Sign in', href: signInHref(returnTo) }, signIn: true };
  }
  if (status === 402 && code === 'plan_required') {
    return { ...out, title: 'This step needs a plan', message: server || 'Cast, pictures and video are part of a plan. Pick one to carry on.', action: { label: 'See plans', href: '/app/billing' } };
  }
  if (status === 402) {
    const needed = Number(err?.needed);
    const available = Number(err?.available);
    const known = Number.isFinite(needed) && Number.isFinite(available);
    const message = known
      ? `You need ${num(Math.max(0, needed - available))} more credits. This takes ${num(needed)} and you have ${num(available)}.`
      : 'You do not have enough credits for this.';
    return { ...out, title: 'Not enough credits', message, action: { label: 'Top up credits', href: '/app/billing' } };
  }
  if (status === 403) {
    return { ...out, title: 'One more thing first', message: server || 'Please confirm your email address, then try again.' };
  }
  if (status === 409) {
    return { ...out, title: 'Already in progress', message: server || 'This is already running. We are refreshing so you can see where it is.', refresh: true };
  }
  if (status === 400 || status === 422) {
    return { ...out, title: status === 400 ? 'That text cannot be used' : 'Please check this', message: server || 'Please check what you entered and try again.' };
  }
  if (status === 429) {
    return { ...out, title: 'Slow down a moment', message: server || 'That is a lot at once. Wait a moment and try again.' };
  }
  if (status === 503) {
    return { ...out, title: 'Try again in a moment', message: 'Try again in a moment.' };
  }
  if (status === 404) {
    return { ...out, title: 'Not found', message: server || 'We could not find that.' };
  }
  if (status === 0) {
    return { ...out, title: 'No connection', message: 'We could not reach the server. Check your connection and try again.' };
  }
  return { ...out, title: 'Something went wrong', message: 'Something went wrong on our side. Please try again.' };
}
