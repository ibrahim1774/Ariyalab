// Turns a StoryApiError (lib/story/client.js) into what the customer sees:
// a title, a message and one next action. Pure, so tests can call it directly.

export function signInHref(returnTo) {
  const path = typeof returnTo === 'string' && returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/app';
  return `/sign-in?returnTo=${encodeURIComponent(path)}`;
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
