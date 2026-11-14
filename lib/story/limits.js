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
 *   daily_limit      429  a free daily cap is used up (projects, analyses, script writes)
 *   chat_limit       429  the project's chat messages (and revises) are used up
 *
 * Paid accounts skip the free checks; only the included chat cap applies.
 * Call it after validation and moderation, right before the work, so a
 * request that fails anyway never uses up a count. Counters go through the
 * story_usage_take SQL function (atomic). Caps can be changed without a
 * deploy: pricing_config key 'free_limits' (shallow-merged over
 * FREE_LIMIT_DEFAULTS) and the included.chat key of getPricing().
 *
 * assertAllowed returns a receipt { userId, counters: [{ key, day }] } naming
 * every count it took (none for a paid daily cap, one chat count for a paid
 * revise). releaseAllowance(receipt) gives exactly those back when the work
 * they were taken for failed.
 *
 * `user` is the session user (it has email and email_confirmed_at). When it is
 * not passed the account is read with the Supabase admin API.
 */

export const FREE_LIMIT_DEFAULTS = Object.freeze({
  projectsPerDay: 3,
  analysesPerDay: 1,
  scriptWritesPerProjectPerDay: 3,
  chatPerProject: 30,
});

/**
 * Actions with free-tier rules.
 *   freeCap    the FREE_LIMIT_DEFAULTS key counted per day on a free account
 *   perProject the daily freeCap counts per project (needs projectId)
 *   chat       counts against the project's chat messages (free and paid; needs projectId)
 */
export const LIMIT_ACTIONS = Object.freeze({
  project_create: { freeCap: 'projectsPerDay' },
  reference_analysis: { freeCap: 'analysesPerDay' },
  script_write: { freeCap: 'scriptWritesPerProjectPerDay', perProject: true },
  // A revise is a request to the model like a chat message, so it uses the same counter.
  script_revise: { chat: true },
  chat_message: { chat: true },
});
// The counter key every chat-like action shares.
const CHAT_COUNTER = 'chat_message';

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

// story_usage counts per day (UTC, sent explicitly so a give-back hits the same
// row). The chat counter uses one fixed day, so it counts for the life of the project.
const PROJECT_COUNTER_DAY = '1970-01-01';
const today = () => new Date().toISOString().slice(0, 10);

const MESSAGES = {
  plan_required: 'This step needs a paid plan. Pick a plan to keep going.',
  email_unverified: 'Confirm your email address to keep going. Check your inbox for the link we sent when you signed up.',
  projectsPerDay: (n) => `Free accounts can start ${n} videos a day. Come back tomorrow, or pick a plan to make more.`,
  scriptWritesPerProjectPerDay: (n) =>
    `Free accounts can write this video's script ${n} times a day. Edit the scenes directly, come back tomorrow, or pick a plan.`,
  analysesPerDay: (n) =>
    `Free accounts can break down ${n} reference ${n === 1 ? 'video' : 'videos'} a day. Come back tomorrow, or pick a plan to do more.`,
  chat: (n) => `This video has used its ${n} chat messages. You can keep editing the script and shots directly.`,
};

// ---------------------------------------------------------------- account checks

/**
 * Paid = an active or trialing subscription (or an admin email), read through
 * the existing entitlement, OR, under billing v2, any credit balance in the
 * ledger (plan + top-up, held credits included). A subscriber at zero
 * balance is still paid.
 */
export async function isPaidUser(userId, { email } = {}) {
  const ent = await getEntitlement({ supabase: getSupabaseAdmin(), userId, email });
  if (ent?.isAdmin || (ent?.tier && ent.tier !== 'none')) return true;
  if (!(await isBillingV2())) return false;
  const balance = await getBalance(userId, 'video');
  return Number(balance?.plan || 0) + Number(balance?.topup || 0) > 0;
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
  return storyDb().rpc('story_usage_take', { p_user: userId, p_action: action, p_limit: limit, p_day: day });
}

const dailyKey = (action, rule, projectId) => (rule.perProject ? `${action}:${projectId}` : action);

async function giveBack(userId, { key, day }) {
  const match = { user_id: userId, day, action: key };
  const db = storyDb();
  // Optimistic decrement: retry if another request changed the count meanwhile.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const [row] = await db.select('story_usage', match);
    if (!row || row.count <= 0) return;
    const updated = await db.update('story_usage', { ...match, count: row.count }, { count: row.count - 1 });
    if (updated.length) return;
  }
}

/**
 * Gives back the counts an assertAllowed receipt took, when the work they
 * were taken for failed. Only the counters in the receipt are touched, so it
 * is a no-op for a receipt that took none (a paid account's daily cap, a
 * gate-only action) or for no receipt. A count never goes below zero.
 */
export async function releaseAllowance(receipt) {
  if (!receipt?.userId || !Array.isArray(receipt.counters)) return;
  for (const counter of receipt.counters) await giveBack(receipt.userId, counter);
}

/** -> receipt { userId, counters } (see the header); throws LimitError when not allowed. */
export async function assertAllowed({ userId, action, projectId, user } = {}) {
  const paidOnly = PAID_ONLY_ACTIONS.includes(action);
  const rule = LIMIT_ACTIONS[action];
  if (!paidOnly && !rule) throw new Error(`Unknown limit action: ${action}`);
  if ((rule?.perProject || rule?.chat) && !projectId) throw new Error(`${action} needs a projectId`);

  const receipt = { userId, counters: [] };
  const account = user || (await deps.getUser(userId));
  const paid = await deps.isPaidUser(userId, { email: account?.email, user: account });

  if (paidOnly) {
    if (!paid) throw new LimitError(MESSAGES.plan_required, { code: 'plan_required', action });
    return receipt;
  }
  if (!paid && !isVerified(account)) throw new LimitError(MESSAGES.email_unverified, { code: 'email_unverified' });

  if (rule.freeCap && !paid) {
    const limit = (await getFreeLimits())[rule.freeCap];
    const counter = { key: dailyKey(action, rule, projectId), day: today() };
    if (!(await take({ userId, action: counter.key, limit, day: counter.day }))) {
      throw new LimitError(MESSAGES[rule.freeCap](limit), { code: 'daily_limit', action });
    }
    receipt.counters.push(counter);
  }
  if (rule.chat) {
    const limit = paid ? (await getPricing()).included.chat : (await getFreeLimits()).chatPerProject;
    const counter = { key: `${CHAT_COUNTER}:${projectId}`, day: PROJECT_COUNTER_DAY };
    if (!(await take({ userId, action: counter.key, limit, day: counter.day }))) {
      await releaseAllowance(receipt); // nothing is done, so nothing stays counted
      throw new LimitError(MESSAGES.chat(limit), { code: 'chat_limit', action });
    }
    receipt.counters.push(counter);
  }
  return receipt;
}
