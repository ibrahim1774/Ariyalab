import { getBalance } from '../credits.js';
import { getEntitlement } from '../entitlement.js';
import { isBillingV2 } from '../billingFlags.js';
import { getPricing, readPricingConfig } from '../pricing.js';
import { getSupabaseAdmin } from '../supabaseServer.js';
import { storyDb } from './db.js';
import { LimitError } from './errors.js';

/*
 * Free-tier gates and per-project caps (spec section 8).
 *
 *   await assertAllowed({ userId, action, projectId?, user? })
 *
 * Throws LimitError (lib/story/errors.js maps the status from the code):
 *   plan_required    402  a paid-only step on a free account
 *   email_unverified 403  a free account whose email is not confirmed
 *   daily_limit      429  a free daily cap is used up (projects, analyses)
 *   chat_limit       429  the project's chat messages are used up
 *
 * Paid accounts skip the free checks; only the included chat cap applies.
 * Call it after validation and moderation, right before the work, so a
 * request that fails anyway never uses up a count. Counters go through the
 * story_usage_take SQL function (atomic). Caps can be changed without a
 * deploy: pricing_config key 'free_limits' (shallow-merged over
 * FREE_LIMIT_DEFAULTS) and the included.chat key of getPricing().
 *
 * `user` is the session user (it has email and email_confirmed_at). When it is
 * not passed the account is read with the Supabase admin API.
 */

export const FREE_LIMIT_DEFAULTS = Object.freeze({ projectsPerDay: 3, analysesPerDay: 1, chatPerProject: 30 });

/** Actions with free-tier rules. freeCap names the FREE_LIMIT_DEFAULTS key counted per day. */
export const LIMIT_ACTIONS = Object.freeze({
  project_create: { freeCap: 'projectsPerDay' },
  reference_analysis: { freeCap: 'analysesPerDay' },
  script_write: {}, // writing and revising the script; a free account can go this far
  chat_message: { perProject: true },
});

/** Steps that need a paid plan (spec 8: a free account can go as far as the script). */
export const PAID_ONLY_ACTIONS = Object.freeze([
  'cast_generate',
  'cast_regenerate',
  'stills_generate',
  'shots_generate',
  'shot_reroll',
  'narration_generate',
  'music_generate',
  'render',
  'voice_clone',
]);

// story_usage counts per day. Per-project counters use one fixed day, so they
// count for the life of the project.
const PROJECT_COUNTER_DAY = '1970-01-01';

const MESSAGES = {
  plan_required: 'This step needs a paid plan. Pick a plan to keep going.',
  email_unverified: 'Confirm your email address to keep going. Check your inbox for the link we sent when you signed up.',
  projectsPerDay: (n) => `Free accounts can start ${n} videos a day. Come back tomorrow, or pick a plan to make more.`,
  analysesPerDay: (n) =>
    `Free accounts can break down ${n} reference ${n === 1 ? 'video' : 'videos'} a day. Come back tomorrow, or pick a plan to do more.`,
  chat: (n) => `This video has used its ${n} chat messages. You can keep editing the script and shots directly.`,
};

// ---------------------------------------------------------------- account checks

/**
 * Paid = an active subscription or any credit balance. Billing v2 reads the
 * credit ledger (plan + top-up credits, held ones included); before v2 it is
 * the existing entitlement (an active or trialing subscription, or an admin
 * email).
 */
export async function isPaidUser(userId, { email } = {}) {
  if (await isBillingV2()) {
    const balance = await getBalance(userId, 'video');
    return Number(balance?.plan || 0) + Number(balance?.topup || 0) > 0;
  }
  const ent = await getEntitlement({ supabase: getSupabaseAdmin(), userId, email });
  return Boolean(ent?.isAdmin || (ent?.tier && ent.tier !== 'none'));
}

async function getUserById(userId) {
  const { data, error } = await getSupabaseAdmin().auth.admin.getUserById(userId);
  if (error) throw error;
  return data?.user || null;
}

let deps = { isPaidUser, getUser: getUserById };

/** Tests replace the account checks. Call with no argument to restore the real ones. */
export function setLimitsDeps({ isPaidUser: paid, getUser } = {}) {
  deps = { isPaidUser: paid || isPaidUser, getUser: getUser || getUserById };
}

const isVerified = (user) => Boolean(user?.email_confirmed_at || user?.confirmed_at);

// ---------------------------------------------------------------- caps

export async function getFreeLimits() {
  const row = (await readPricingConfig()).find((r) => r.key === 'free_limits');
  const override = row?.value && typeof row.value === 'object' && !Array.isArray(row.value) ? row.value : {};
  return { ...FREE_LIMIT_DEFAULTS, ...override };
}

async function take({ userId, action, limit, day }) {
  return storyDb().rpc('story_usage_take', { p_user: userId, p_action: action, p_limit: limit, ...(day ? { p_day: day } : {}) });
}

export async function assertAllowed({ userId, action, projectId, user } = {}) {
  const paidOnly = PAID_ONLY_ACTIONS.includes(action);
  const rule = LIMIT_ACTIONS[action];
  if (!paidOnly && !rule) throw new Error(`Unknown limit action: ${action}`);
  if (rule?.perProject && !projectId) throw new Error(`${action} needs a projectId`);

  const account = user || (await deps.getUser(userId));
  const paid = await deps.isPaidUser(userId, { email: account?.email, user: account });

  if (paidOnly) {
    if (!paid) throw new LimitError(MESSAGES.plan_required, { code: 'plan_required', action });
    return;
  }
  if (!paid && !isVerified(account)) throw new LimitError(MESSAGES.email_unverified, { code: 'email_unverified' });

  if (rule.freeCap && !paid) {
    const limit = (await getFreeLimits())[rule.freeCap];
    if (!(await take({ userId, action, limit }))) {
      throw new LimitError(MESSAGES[rule.freeCap](limit), { code: 'daily_limit', action });
    }
  }
  if (rule.perProject) {
    const limit = paid ? (await getPricing()).included.chat : (await getFreeLimits()).chatPerProject;
    if (!(await take({ userId, action: `${action}:${projectId}`, limit, day: PROJECT_COUNTER_DAY }))) {
      throw new LimitError(MESSAGES.chat(limit), { code: 'chat_limit', action });
    }
  }
}
