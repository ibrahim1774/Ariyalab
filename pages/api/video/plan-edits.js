import Anthropic from '@anthropic-ai/sdk';

import { getUserFromRequest } from '../../../lib/supabaseServer';
import { getEntitlement } from '../../../lib/entitlement';
import { KEY } from '../../../lib/metaKeys';
import { validateEditPlan, SCHEMA_DESCRIPTION, OPERATION_TYPES } from '../../../lib/editPlan';

/*
 * Chat planner. Does NOT charge credits, but it makes a paid Anthropic
 * call, so it is limited to admins and accounts holding credits, and
 * the input size is capped.
 *
 * Body: { currentPlan, userMessage, chatHistory? }
 * Returns: { plan, assistantMessage, clarifyingQuestion? }
 *   - plan: validated edit plan (unchanged on clarifying questions)
 *   - assistantMessage: short chat reply for the UI
 */

const MAX_HISTORY_MESSAGES = 10;
const MAX_HISTORY_MESSAGE_CHARS = 2000;
const MAX_PLAN_JSON_CHARS = 20000;

function hasCredits(entitlement) {
  if (entitlement?.isAdmin) return true;
  // Active plans report creditsRemaining; trialing ones report KEY.credits.
  const credits = Number(entitlement?.creditsRemaining ?? entitlement?.[KEY.credits] ?? 0);
  return credits > 0;
}

function oversizeError({ currentPlan, userMessage, chatHistory }) {
  if (JSON.stringify(currentPlan).length > MAX_PLAN_JSON_CHARS) {
    return `currentPlan is too large (max ${MAX_PLAN_JSON_CHARS} characters).`;
  }
  if (userMessage.length > MAX_HISTORY_MESSAGE_CHARS) {
    return `userMessage is too long (max ${MAX_HISTORY_MESSAGE_CHARS} characters).`;
  }
  if (chatHistory === undefined || chatHistory === null) return null;
  if (!Array.isArray(chatHistory)) return 'chatHistory must be an array.';
  if (chatHistory.length > MAX_HISTORY_MESSAGES) {
    return `chatHistory is too long (max ${MAX_HISTORY_MESSAGES} messages).`;
  }
  for (const m of chatHistory) {
    const content = m?.content;
    if (content !== undefined && typeof content !== 'string') return 'chatHistory content must be text.';
    if (typeof content === 'string' && content.length > MAX_HISTORY_MESSAGE_CHARS) {
      return `chatHistory messages are limited to ${MAX_HISTORY_MESSAGE_CHARS} characters.`;
    }
  }
  return null;
}

const SYSTEM_PROMPT = `You are a video editing assistant inside a web app.

The user has uploaded a video and wants to edit it. Your job: given their request and the current edit plan, return an updated edit plan as JSON.

${SCHEMA_DESCRIPTION}

Rules:
1. Return ONLY a single JSON object. No markdown fences, no prose around it.
2. The JSON must have this exact shape:
   {
     "plan": { ...full updated edit plan with sourceUrl, duration, width, height, operations[] },
     "assistantMessage": "<one short sentence telling the user what you did>",
     "clarifyingQuestion": "<optional — only if the request is ambiguous>"
   }
3. Preserve sourceUrl, duration, width, height from the current plan exactly.
4. Generate unique operation ids like "op_<random>".
5. If the user's request is ambiguous (e.g. "make it shorter" without saying how much), keep the operations array unchanged and set clarifyingQuestion to ask for the missing detail.
6. Allowed operation types: ${OPERATION_TYPES.join(', ')}. Never invent any other type.
7. To remove an operation, omit it from the new operations array. To reorder, return them in the desired order.`;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const session = await getUserFromRequest(req, res);
  if (!session) return res.status(401).json({ error: 'Authentication required.' });

  const { currentPlan, userMessage, chatHistory } = req.body || {};
  if (!currentPlan || typeof currentPlan !== 'object') {
    return res.status(400).json({ error: 'currentPlan required' });
  }
  if (typeof userMessage !== 'string' || !userMessage.trim()) {
    return res.status(400).json({ error: 'userMessage required' });
  }
  const tooBig = oversizeError({ currentPlan, userMessage, chatHistory });
  if (tooBig) return res.status(422).json({ error: tooBig });

  let entitlement;
  try {
    entitlement = await getEntitlement({
      supabase: session.supabase,
      userId: session.user.id,
      user: session.user,
    });
  } catch (err) {
    return res.status(500).json({ error: `Entitlement check failed: ${err.message}` });
  }
  if (!hasCredits(entitlement)) {
    return res.status(402).json({ error: 'paywall', tier: entitlement?.tier || 'none' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Editor not configured (missing ANTHROPIC_API_KEY).' });
  }

  // Validate the incoming plan first — protects against a corrupted
  // localStorage payload poisoning the AI's input.
  const inboundCheck = validateEditPlan(currentPlan);
  if (!inboundCheck.valid) {
    return res.status(400).json({ error: 'currentPlan invalid', details: inboundCheck.errors });
  }

  const anthropic = new Anthropic({ apiKey });

  // Build the messages: prior chat history (if any) + the current
  // turn. We always include the current plan in the user message so
  // Claude has the latest state even if chatHistory was truncated.
  const history = Array.isArray(chatHistory)
    ? chatHistory.slice(-MAX_HISTORY_MESSAGES).filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content)
    : [];

  const messages = [
    ...history.map((m) => ({ role: m.role, content: m.content })),
    {
      role: 'user',
      content: `Current edit plan:\n${JSON.stringify(currentPlan, null, 2)}\n\nMy request: ${userMessage}`,
    },
  ];

  async function callClaude(extraSystemNote) {
    const result = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 2000,
      system: [
        {
          type: 'text',
          text: SYSTEM_PROMPT + (extraSystemNote ? `\n\n${extraSystemNote}` : ''),
          cache_control: { type: 'ephemeral' }, // reuse across turns
        },
      ],
      messages,
    });
    const textBlock = result.content.find((b) => b.type === 'text');
    return textBlock ? textBlock.text : '';
  }

  function tryParse(text) {
    if (!text) return null;
    // Strip any accidental code fences.
    const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    try {
      return JSON.parse(cleaned);
    } catch {
      return null;
    }
  }

  try {
    let raw = await callClaude();
    let parsed = tryParse(raw);

    // If parse failed or the plan is invalid, retry once with the
    // validation errors fed back as a corrective hint.
    if (!parsed || !parsed.plan) {
      raw = await callClaude(
        `Your previous response could not be parsed as JSON. Return ONLY the JSON object — nothing else.`
      );
      parsed = tryParse(raw);
    }

    if (!parsed || !parsed.plan) {
      return res.status(502).json({
        error: 'Could not parse AI response. Try rephrasing your request.',
      });
    }

    const planCheck = validateEditPlan(parsed.plan);
    if (!planCheck.valid) {
      raw = await callClaude(
        `Your last edit plan was invalid: ${planCheck.errors.join('; ')}. Return a corrected plan.`
      );
      parsed = tryParse(raw);
      if (!parsed || !parsed.plan) {
        return res.status(502).json({
          error: 'AI returned an invalid plan twice. Try rephrasing.',
          details: planCheck.errors,
        });
      }
      const retry = validateEditPlan(parsed.plan);
      if (!retry.valid) {
        return res.status(502).json({
          error: 'AI returned an invalid plan.',
          details: retry.errors,
        });
      }
    }

    return res.status(200).json({
      plan: parsed.plan,
      assistantMessage: parsed.assistantMessage || 'Updated.',
      clarifyingQuestion: parsed.clarifyingQuestion || null,
    });
  } catch (err) {
    console.error('[video/plan-edits] failed', err);
    return res.status(500).json({ error: err.message || 'Plan generation failed.' });
  }
}
