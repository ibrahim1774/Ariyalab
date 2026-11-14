# Story Video Maker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Each task is one implementer, one reviewer gate, one commit series.

**Goal:** Turn Ariya Lab into a chat-guided maker of animated story videos with credits, a new light theme, reference-video analysis, brand kit, voice cloning and an MCP connector.

**Architecture:** All product logic lives in `lib/story/*` and is called by thin pages-router API routes and by the MCP server, so web and connector share one backend. Paid work runs through a database job queue advanced by an idempotent `tick` (cron, provider webhooks and status polls all call it), with credits held up front and settled or released per shot in Postgres functions. Every outside service sits behind `lib/providers/*` with a mock mode so the whole pipeline runs in tests and local dev without keys.

**Tech Stack:** Next.js 14 pages router, JavaScript (ESM), CSS Modules, Supabase Postgres + auth, Stripe, kie.ai, Anthropic SDK, fluent-ffmpeg, Vitest, PGlite (for SQL function tests).

**Spec:** `docs/superpowers/specs/2026-11-14-story-video-maker-design.md`. Read it before any task. Reference frames for the theme: `docs/superpowers/specs/assets/uvera-reference/`.

## Global Constraints

- Branch `redesign/story-video-maker`. Never push, deploy, apply a migration to the hosted Supabase, or change anything in the live Stripe account. Those are Ibrahim's go-live steps (Task 27 writes the checklist).
- Supabase and Stripe are shared with haelabs.live. Do not alter `profiles`, `videos`, `app_settings`, `moderation_results`, or any key under `shared` in `lib/metaKeys.js`. New tables are prefixed `story_`, `credit_`, or are `pricing_config` / `stripe_events`.
- JavaScript only, ESM imports, CSS Modules, no Tailwind, no TypeScript. Follow the patterns in `lib/supabaseServer.js` (`getUserFromRequest`, `getSupabaseAdmin`).
- Every API route that can cost money authenticates the user and goes through `lib/credits.js`. No route spends before a hold or spend succeeds.
- Never write "Pixar", "Disney", or any studio, character or celebrity name in UI copy, presets, prompts or tests' expected copy. The 3D preset is named "3D animated family film".
- Captions and important text stay inside y 285 to 1635 on a 1080x1920 frame.
- Provider prices and credit rates come from `lib/pricing.js` (backed by `pricing_config`), never hard-coded in routes or components.
- `STORY_MOCK=1` makes every provider return fixtures from `tests/fixtures/`. Tests always run with it. No test calls a real provider.
- TDD: write the listed tests first, see them fail, implement, see them pass, commit. Commit messages end with `Co-Authored-By: Claude <model> <noreply@anthropic.com>` per the session's attribution rule.
- `npm test` (vitest run) and `npm run build` must pass at the end of every task.

## Review Focus

1. **Tab closed or callback lost mid-generation.** A clip job with no callback for 10 minutes is swept: marked failed, its part of the hold released, resubmitted once. Test in Task 12 (`sweeper releases and retries once`) and Task 16.
2. **Double submit.** Two simultaneous "generate" calls, or a Stripe webhook delivered twice, produce one hold and one grant. Tests in Task 3 (`concurrent holds cannot overdraw`), Task 5 (`same event id grants once`), Task 16 (`second generate while holding returns 409`).
3. **Provider refuses a shot** (content filter, brand name, child-related). That shot becomes `blocked` with a plain message, its credits are released, the other shots continue. Test in Task 16.
4. **Odd reference videos.** No speech, one single shot, longer than 3 minutes, over 100 MB, or a link that cannot be fetched: each gives a clear error or a usable beat sheet, never a crash or a charge. Tests in Task 22.
5. **Edits after generation.** Changing one scene's line marks only its shots stale; unchanged clips are not regenerated or re-charged; re-render is free. Tests in Task 15 and Task 20.

## Execution model

Ibrahim's instruction: Sonnet or Opus build, Opus reviews, Fable reviews the hard parts.

| Label | Meaning |
|---|---|
| Build: Sonnet | Well-specified UI, CRUD, glue |
| Build: Opus | Concurrency, money, media pipeline, security |
| Review: Opus | Default reviewer for every task |
| Review: Fable | Added second review for money, auth and concurrency tasks, and the final branch review |

## File structure

```
supabase/migrations/20261114_credit_ledger.sql      credit tables + functions
supabase/migrations/20261114_story_schema.sql       story_* tables, RLS, job claim function
supabase/migrations/20261114_story_oauth.sql        OAuth tables for MCP
lib/credits.js            ledger access (only caller of credit SQL functions)
lib/pricing.js            rates, quotes, plan table
lib/billingFlags.js       billing_v2 flag
lib/providers/{llm,image,video,tts,music,stt,fetchVideo,storage,mock}.js
lib/story/{projects,script,cast,storyboard,shots,audio,captions,render,checks,analyze,assets,voices,runner,limits,chatTools}.js
lib/story/prompts/{script,analysis,cast,shot,styles}.js
lib/mcp/{server,tools,oauth}.js
pages/api/story/...       thin routes
pages/api/webhooks/kie.js
pages/api/cron/{story-tick,grant-yearly}.js
pages/api/mcp.js, pages/api/oauth/{register,authorize,token}.js, pages/.well-known handled via next.config rewrites
components/ui/*           Button, Card, Pill, Accordion, Stepper, Modal, Toast
components/marketing/*    homepage sections
components/app/*          AppShell, ProjectCard, CreditBadge
components/maker/*        ChatPanel and one component per step
pages/index.js (new), pages/legacy-home.js (old index moved), pages/app/*
styles/theme.css          new tokens
tests/**                  vitest; tests/helpers/{db.js,mockEnv.js}; tests/fixtures/*
```

## Shared contracts

These names are fixed. A task may add helpers but may not rename these.

**Credits (`lib/credits.js`)** — all amounts are positive integers, `currency` is `'video'` or `'image'`:

```js
getBalance(userId, currency = 'video')            // -> { plan, topup, held, available }
grantCredits({ userId, currency, amount, bucket, reason, ref })   // bucket 'plan'|'topup'; idempotent on (reason, ref); -> balance
renewPlanCredits({ userId, allotment, ref })      // plan = min(plan, allotment) + allotment; idempotent on ref
spendCredits({ userId, currency, amount, reason, ref })           // throws InsufficientCreditsError
holdCredits({ userId, currency, amount, projectId })              // -> holdId; throws InsufficientCreditsError
settleHold({ holdId, amount, reason, ref })       // moves amount from hold to spent; idempotent on ref
releaseHold({ holdId, amount })                   // amount omitted = release the rest
clawback({ userId, currency, amount, reason, ref })               // may take balance to 0, never below
export class InsufficientCreditsError extends Error {}            // .needed, .available
```

Spending takes from `plan` first, then `topup`.

**Pricing (`lib/pricing.js`)**:

```js
getPricing()                                      // -> { perSecond: {economy:8, standard:11, pro_narrated:14, pro_talking:21}, projectFee:90, stillReroll:2, castRegen:5, narrationRegen:5, musicRegen:5, voiceClone:20, freeRerollShare:0.2, included:{castRegenPerCharacter:2, narration:3, music:3, chat:150} }
quoteShot({ quality, seconds })                   // -> credits; seconds is generated seconds, min 3, rounded up
quoteProject({ shots, feeAlreadyCharged })        // -> { total, lines:[{label, credits}] }
PLANS_V2 = { starter:{usd:29, credits:1500}, creator:{usd:49, credits:2600}, studio:{usd:99, credits:5400} }
TOPUPS_V2 = { s:{usd:15, credits:700}, m:{usd:40, credits:1900}, l:{usd:100, credits:5000} }
YEARLY_DISCOUNT = 0.2
LEGACY_TO_V2 = 21 / 100
```

**Providers** — each returns plain objects, throws `ProviderError` (`.code`: `'blocked' | 'failed' | 'rate_limited' | 'config'`, `.message` safe to show):

```js
// llm.js
completeJSON({ tier, system, messages, schema, maxTokens })   // tier 'fast'|'smart' -> parsed object
chatWithTools({ system, messages, tools, onToolCall })        // -> { messages }
// image.js
submitImage({ prompt, refs, aspect, size })       // -> { provider, taskId }
getImage({ provider, taskId })                    // -> { status:'pending'|'done'|'failed'|'blocked', url, error }
// video.js
QUALITIES = ['economy','standard','pro_narrated','pro_talking']
submitClip({ quality, imageUrl, prompt, seconds, aspect, elements, callbackUrl })  // -> { provider, taskId }
getClip({ provider, taskId })                     // -> same shape as getImage
parseCallback(provider, body)                     // -> { taskId, status, url, error }
// tts.js
listVoices()                                      // -> [{ id, name, gender, sampleUrl }]
synthesize({ voiceId, text })                     // -> { buffer, mime }
cloneVoice({ sampleUrl, name })                   // -> { voiceId }
// music.js
generateMusic({ prompt, seconds })                // -> { buffer, mime }
// stt.js
transcribe({ filePath })                          // -> { text, words:[{ w, start, end }] }
// fetchVideo.js
fetchReference(url)                               // -> { filePath, platform }; throws ProviderError code 'failed' with a customer-readable message
// storage.js
putObject({ key, body, contentType })             // -> public url; R2 when R2_* env set, else Vercel Blob
mirrorUrl({ srcUrl, key })                        // -> public url
```

**Story data shapes** (JSON stored in tables):

```js
Scene  = { id, title, visual, lines:[{ speaker, text }] }          // speaker 'narrator' or a cast name
Shot   = { id, project_id, ord, scene_id, description, line, seconds, quality, source:'generated'|'footage', footage_asset_id, inset_asset_id, still_url, clip_url, status, stale, attempts }
// Shot.status: 'draft'|'still_pending'|'still_ready'|'queued'|'generating'|'ready'|'failed'|'blocked'
Beat   = { ord, start, end, visual, said, why }
Project.step: 'brief'|'breakdown'|'script'|'cast'|'storyboard'|'audio'|'generate'|'review'|'done'
Job.kind: 'analyze'|'script'|'cast_image'|'still'|'clip'|'narration'|'music'|'voice_clone'|'render'
Job.status: 'queued'|'running'|'done'|'failed'|'blocked'
```

**Story services** (`lib/story/*`, every function takes `{ userId, ... }` and enforces ownership):

```js
// projects.js
createProject({ userId, input })  getProject({ userId, id })  listProjects({ userId })
updateProject({ userId, id, patch })  deleteProject({ userId, id })  duplicateProject({ userId, id })
// script.js
writeScript({ userId, projectId })                 // from brief, or from beat sheet when a reference exists -> script version
reviseScript({ userId, projectId, instruction })   updateScene({ userId, projectId, sceneId, patch })
checkScriptRules(scenes)                           // -> [{ sceneId, rule, message }]
// cast.js
generateCast({ userId, projectId })                regenerateCharacter({ userId, projectId, castId, note })
pickCast({ userId, projectId, castId, candidateIndex })   setCastImage({ userId, projectId, castId, assetId })
// storyboard.js
buildShotList({ userId, projectId })               generateStills({ userId, projectId, shotIds })
updateShot({ userId, projectId, shotId, patch })   markStale({ projectId, sceneIds })
// shots.js
quoteGeneration({ userId, projectId, shotIds })    // -> { total, lines, holdNeeded }
startGeneration({ userId, projectId, shotIds, confirmTotal })   // throws QuoteChangedError if confirmTotal != quote
rerollShot({ userId, projectId, shotId })
// audio.js
setAudioPlan({ userId, projectId, plan })          generateNarration({ userId, projectId })   generateMusic({ userId, projectId })
// render.js
startRender({ userId, projectId })                 // enqueues a render job -> renderId
// analyze.js
startAnalysis({ userId, projectId, source })       // source { type:'upload', assetId } | { type:'link', url }
// runner.js
enqueue({ projectId, shotId, kind, payload })      tick({ projectId, limit })   handleProviderCallback(provider, body)   sweep({ now })
// limits.js
assertAllowed({ userId, action })                  // throws LimitError for free-tier and per-project caps
```

**HTTP** — all under `/api/story`, JSON, 401 without a session, 402 `{ error:'insufficient_credits', needed, available }`, 409 for a conflicting in-flight action, 422 for validation or moderation:

```
GET/POST   /projects                 GET/PATCH/DELETE /projects/[id]
POST       /projects/[id]/[action]   action in: duplicate, analyze, script, revise, scene, cast, cast-regen, cast-pick,
                                     shots, stills, shot, quote, generate, reroll, audio, narration, music, render
GET        /projects/[id]/status     -> { project, shots, cast, jobs, balance, render }   (also calls tick for this project)
POST       /chat                     GET/POST/DELETE /assets     GET/POST/DELETE /voices     GET /pricing
```

---

## Stage 1: Safety and ledger

### Task 1: Test harness and input-safety fixes

Build: Sonnet. Review: Opus.

**Files:** Create `vitest.config.js`, `tests/helpers/mockEnv.js`, `tests/moderation.test.js`, `tests/editPlan.test.js`. Modify `package.json` (add `vitest`, `@electric-sql/pglite` dev deps; `"test": "vitest run"`), `lib/moderation.js`, `lib/editPlan.js`, `lib/ffmpegRender.js`.

**Tests:**
- `regexCheck gives the same answer three times in a row` for one blocked and one clean prompt (today it alternates).
- `screenText rejects when the LLM check throws` and `screenImage rejects when the image cannot be fetched` (fail closed; throw `ModerationError` with reason `'unavailable'`).
- `validateEditPlan rejects overlay color "red:fontfile=/etc/passwd"` and accepts `#FFAA00` and `#fa0`.

**Implementation notes:** drop the `g` flag from the module-level regexes; overlay color must match `/^#([0-9a-f]{3}|[0-9a-f]{6})$/i` in `validateEditPlan`, and `ffmpegRender` re-checks before splicing.

### Task 2: Close the unpaid-spend routes

Build: Opus. Review: Opus, Fable.

**Files:** Modify `pages/api/swap.js`, `pages/api/upload-token.js`, `pages/api/moderate-image.js`, `pages/api/status.js`, `middleware.js`. Create `tests/api/unpaidRoutes.test.js`, `tests/helpers/apiMock.js` (builds `req`/`res` and stubs `getUserFromRequest`, Stripe and Replicate modules).

**Tests:**
- `/api/swap` with zero credits returns 402 and does not call Replicate; with credits it reserves `FACE_SWAP_COST` once.
- `/api/upload-token` without a session returns 401, except for a request whose `clientPayload.surface` is `'face-swap-anon'`, which gets a token capped at 25 MB and image content types only.
- `/api/moderate-image` without a session returns 401.
- `/api/status` for a prediction id not in the caller's pending list or history returns 404.

**Notes:** `/api/character-frame` already charges 100 for the face-swap flow; make the charge happen in exactly one place and have the other verify a signed short-lived token (HMAC with `CRON_SECRET`) so the flow costs 100 once. Record prediction ownership when a job is created so `/api/status` can check it.

### Task 3: Credit ledger schema and functions

Build: Opus. Review: Opus, Fable.

**Files:** Create `supabase/migrations/20261114_credit_ledger.sql`, `tests/helpers/db.js`, `tests/sql/creditLedger.test.js`.

**Schema:** `credit_accounts(user_id uuid, currency text, plan_balance int, topup_balance int, held int, primary key(user_id, currency), all >= 0)`; `credit_ledger(id bigserial, user_id, currency, delta int, bucket text, reason text, ref text, project_id uuid, balance_after int, created_at, unique(user_id, currency, reason, ref))`; `credit_holds(id uuid, user_id, currency, amount int, remaining int, project_id uuid, status text 'active'|'closed', created_at)`; `credit_pending_grants(stripe_customer_id text, currency, amount, bucket, reason, ref, claimed_by uuid, unique(reason, ref))`; `stripe_events(id text primary key, received_at)`; `pricing_config(key text primary key, value jsonb, updated_at)`. RLS on: owners may `select` their own account, ledger and holds; no client writes.

**Functions (security definer, `select ... for update` on the account row):** `credit_grant`, `credit_renew_plan`, `credit_spend`, `credit_hold`, `credit_settle`, `credit_release`, `credit_clawback`, `credit_claim_pending(p_customer text, p_user uuid)`, matching the `lib/credits.js` contract. Insufficient funds raise `insufficient_credits`.

**`tests/helpers/db.js`:** `createTestDb()` boots PGlite, creates stub `auth.uid()` and an `auth.users` table, applies every file in `supabase/migrations/2026111*` in order, returns `{ query, close }`.

**Tests:** grant then balance; duplicate `(reason, ref)` grant is a no-op; spend takes plan before topup; spend over balance raises; hold reduces `available` not `plan`; `concurrent holds cannot overdraw` (two holds of 60 against 100 in parallel transactions, exactly one succeeds); settle is idempotent on ref and cannot exceed `remaining`; release returns the rest; renew caps rollover (`plan 400, allotment 1500 -> 1900`; `plan 2000, allotment 1500 -> 3000`); clawback floors at 0; pending grant is claimed once.

### Task 4: Credits and pricing libraries

Build: Sonnet. Review: Opus.

**Files:** Create `lib/credits.js`, `lib/pricing.js`, `lib/billingFlags.js`, `tests/credits.test.js`, `tests/pricing.test.js`.

**Consumes:** Task 3 functions via `getSupabaseAdmin().rpc(...)`; tests inject the PGlite db through `setCreditsDb(db)`.

**Tests:** each `lib/credits.js` function maps to its SQL function and surfaces `InsufficientCreditsError` with `needed` and `available`; `quoteShot({quality:'pro_narrated', seconds:2.2})` is `42` (3 second minimum x 14); `quoteShot({quality:'standard', seconds:4.1})` is `55`; `quoteProject` for 15 pro_narrated shots of 3 seconds with the fee not yet charged totals `720`; `getPricing()` merges `pricing_config` rows over the defaults and caches for 60 seconds; `isBillingV2()` reads `pricing_config` key `billing_v2` (default false).

### Task 5: Stripe grant paths made safe

Build: Opus. Review: Opus, Fable.

**Files:** Modify `pages/api/stripe-webhook.js`, `pages/api/checkout/confirm.js`, `pages/api/checkout/claim-ticket.js`, `pages/api/checkout/claim.js`. Create `lib/grants.js`, `tests/api/stripeGrants.test.js`.

**Produces:** `grantForCheckoutSession(session)` and `grantForInvoice(invoice)` in `lib/grants.js`: the single place credits are granted, idempotent on the Stripe object id. With `billing_v2` off they call the existing legacy grant code but record the id in `stripe_events` first; with it on they call `grantCredits` / `renewPlanCredits`, or write `credit_pending_grants` when the customer has no linked user.

**Tests:** `same event id grants once`; webhook and `/confirm` racing on one session grant once; a handler error returns 500 (so Stripe retries) and does not record the event; `/confirm` with a session whose `client_reference_id` or customer email does not match the caller returns 403; replaying an old top-up session after 11 newer ones grants nothing; `charge.refunded` and `charge.dispute.created` call `clawback` for the credits that purchase granted (v2 only).

### Task 6: Billing v2 adapter, legacy migration script, profile policy

Build: Opus. Review: Opus, Fable.

**Files:** Modify `lib/entitlement.js` (when `isBillingV2()`: `getEntitlement` reads `getBalance`, `reserveCredits`/`refundCredits`/`decrementCredits` call `lib/credits.js`; legacy path unchanged otherwise), `pages/api/glow-up.js` (use the shared entitlement; image credits via currency `'image'`; stop resetting purchased image credits). Create `scripts/migrate-legacy-credits.mjs`, `supabase/migrations/20261114_profiles_policy.sql`, `tests/entitlementV2.test.js`, `tests/migrateLegacy.test.js`.

**Tests:** with v2 on, two parallel `reserveCredits(100)` against 150 give one success and one `InsufficientCreditsError`; old tools' prices are multiplied by `LEGACY_TO_V2` and rounded up when v2 is on (100 legacy credits per second -> 21); the migration script in `--dry-run` prints per-customer `{ legacyCredits, v2Credits, imageCredits }` and writes nothing; run twice for real against the test db it grants once (ref `legacy-migration:<customerId>`).

**Notes:** the profiles migration only adds a policy so a user cannot update `stripe_customer_id` (column-level revoke plus server-side link through the service role in `linkStripeCustomerToProfile`). It is additive and must not change how haelabs reads the table. Include a comment block at the top stating that Ibrahim must review before applying.

## Stage 2: Theme, homepage, dashboard

### Task 7: Design tokens, UI primitives, page chrome

Build: Sonnet. Review: Opus.

**Files:** Create `styles/theme.css`, `components/ui/{Button,Card,Pill,Accordion,Stepper,Modal,Toast}.js` with `.module.css`, `components/marketing/{MarketingNav,MarketingFooter}.js`, `components/app/{AppShell,CreditBadge}.js`, `tests/ui/primitives.test.js` (add `@testing-library/react`, `jsdom`). Modify `styles/globals.css`, `pages/_app.js`.

**Decisions:** tokens `--bg:#FDFBF5; --surface:#FFFFFF; --text:#16130F; --text-dim:#6B645A; --accent:#F08A4B; --accent-deep:#DB6F2E; --border:rgba(22,19,15,.08); --radius-card:20px; --radius-pill:999px`. Fonts: `Outfit` for display and body (one family), accent word in italic with `--accent`. Old token names in `globals.css` (`--surface-0..3`, `--gold*`, `--glass-*`, `--shadow-*`) are remapped to light values so legacy CSS modules keep rendering. `_app.js` chooses chrome by route: `/` and marketing pages get `MarketingNav` + `MarketingFooter`; `/app/*` gets `AppShell` (sidebar: Projects, Brand kit, Voices, Billing, More tools; `CreditBadge` top right reading `/api/entitlement`); every other route keeps the existing `Navbar` and `Footer`.

**Tests:** `Button` renders an arrow and `variant="primary"|"ghost"|"dark"`; `Accordion` opens one item at a time; `Stepper` marks steps done, current and stale.

### Task 8: Homepage

Build: Sonnet. Review: Opus.

**Files:** Move `pages/index.js` to `pages/legacy-home.js` (unchanged behaviour). Create `pages/index.js`, `components/marketing/{Hero,VideoRail,HowItWorks,PricingSection,Faq,ClosingCta}.js` with `.module.css`, `public/examples/README.md`, `tests/ui/home.test.js`.

**Decisions:** sections in the spec's section 9 order. Hero headline: "Animated story videos for *anything* you sell"; subhead: "Describe your story or start from a video you like. Get a finished, captioned video in minutes."; buttons "Make your first video" (to `/app/new`, or `/sign-up` when signed out) and "See examples". `VideoRail` reads `public/examples/manifest.json` (array of `{ src, poster, label }`) and renders gradient placeholders when it is empty. `PricingSection` reads `PLANS_V2`, `YEARLY_DISCOUNT` and shows "about N videos" computed from `quoteProject` for a 45 second Pro narrated video. FAQ has 8 questions covering what it is, business types, quality levels, credits, references, ownership of output, cancelling, and Claude connector. Sections fade in with one `IntersectionObserver` hook; respect `prefers-reduced-motion`.

**Tests:** renders all seven sections; pricing shows `$29`, `$49`, `$99` monthly and `$23.20`, `$39.20`, `$79.20` yearly; no forbidden word (see Global Constraints) appears in the rendered text.

### Task 9: Dashboard shell, billing page, legacy pages pass

Build: Sonnet. Review: Opus.

**Files:** Create `pages/app/index.js`, `pages/app/billing.js`, `pages/app/tools.js`, `components/app/ProjectCard.js`, `pages/api/story/pricing.js`. Modify `middleware.js` (protect `/app`, `/api/story`), `pages/dashboard/index.js` (redirect to `/app`), legacy CSS modules where contrast breaks.

**Decisions:** `/app` lists projects from `GET /api/story/projects` (empty state with a "New video" button until Task 10 lands the route; code against the contract). `/app/billing` shows balance split (plan, top-up, held), ledger history, plan and top-up buttons using the existing `/api/checkout`. `/app/tools` links the six legacy tools.

**Verification:** run the dev server and screenshot `/`, `/app`, `/app/billing`, `/face-swap`, `/ugc`, `/glow-up`, `/interior-design`, `/video/editing`, `/history`, `/ugc-2`, `/local-business` at 1440 and 390 wide; fix any unreadable text or invisible control on legacy pages.

## Stage 3: Story path

### Task 10: Story schema and project service

Build: Opus. Review: Opus.

**Files:** Create `supabase/migrations/20261114_story_schema.sql`, `lib/story/projects.js`, `pages/api/story/projects/index.js`, `pages/api/story/projects/[id]/index.js`, `tests/story/projects.test.js`.

**Schema:** tables from spec 10.2 with the Shared-contract shapes, plus `story_usage(user_id, day, action, count)` for limits and `story_jobs` columns `(id, project_id, shot_id, kind, payload jsonb, provider, provider_task_id, status, attempts, hold_id, cost_credits, error, run_after, locked_until, created_at, updated_at)`. Function `story_claim_jobs(p_project uuid, p_limit int)` selects queued jobs `for update skip locked`, sets `status='running'`, `locked_until = now() + interval '2 minutes'`. RLS: owner select on all; owner insert/update only on `story_projects`, `story_scripts`, `story_assets`; everything else server-only.

**Tests:** create with input `{ purpose:'coaching', offer:'...', style:'3d_family', seconds:45, aspect:'9:16', quality:'pro_narrated' }` returns step `'brief'`; another user's `getProject` throws `NotFoundError`; `seconds` outside 15 to 75 and unknown `purpose`/`style`/`quality` are rejected; delete removes child rows; duplicate copies script and cast but not clips.

### Task 11: Providers and mock mode

Build: Opus. Review: Opus.

**Files:** Create everything under `lib/providers/`, `tests/fixtures/{clip.mp4,still.png,voice.mp3,music.mp3,reference.mp4}` (generated with ffmpeg in a `scripts/make-fixtures.mjs`), `tests/providers/*.test.js`. Modify `lib/kie.js` (add `callBackUrl`, `kling_elements`, `mode` std/pro, sound flag; keep existing exports working), `.env.example` (all 21 existing names plus `STORY_MOCK`, `GROQ_API_KEY`, `SCRAPECREATORS_API_KEY`, `FISH_API_KEY`, `GOOGLE_AI_API_KEY`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_PUBLIC_URL`, `KIE_WEBHOOK_SECRET`).

**Decisions:** quality map — `economy: seedance-2.0-mini 720p`, `standard: kling-3.0 std 720p sound off`, `pro_narrated: kling-3.0 pro 1080p sound off`, `pro_talking: kling-3.0 pro 1080p sound on`; model ids live in one `MODEL_IDS` object. Image model id in the same object, default the kie Nano Banana id already used in `pages/api/glow-up.js`. LLM tiers: `fast` = latest Haiku, `smart` = latest Sonnet, ids in one constant, verified against the Anthropic docs with the claude-api skill. A missing key throws `ProviderError` code `'config'` naming the env var. kie returns rate limits inside HTTP 200 bodies: map to `'rate_limited'`.

**Tests (all in mock mode plus pure-function tests):** `submitClip` builds the expected kie body for each quality (snapshot of the request body with a stubbed `fetch`); seconds clamp to 3 to 15 for Kling and 4 to 15 for Seedance; `parseCallback` maps kie success, fail and content-refusal payloads; `storage.putObject` chooses R2 when env is set and Blob otherwise; mock mode returns fixture URLs without any network call (assert `fetch` not called).

### Task 12: Job runner

Build: Opus. Review: Opus, Fable.

**Files:** Create `lib/story/runner.js`, `pages/api/webhooks/kie.js`, `pages/api/cron/story-tick.js`, `tests/story/runner.test.js`. Modify `vercel.json` (cron `* * * * *` for `/api/cron/story-tick`).

**Behaviour:** `tick` claims jobs, submits at most 15 new provider tasks per call (throttle under kie's 20 per 10 seconds), polls running jobs whose `locked_until` passed, and calls the per-kind `onDone(job, result)` handler registered by later tasks through `registerHandler(kind, { run, onDone, onFail })`. Completed media is mirrored with `storage.mirrorUrl` before the job is marked done. `handleProviderCallback` verifies `KIE_WEBHOOK_SECRET` (query token), finds the job by `provider_task_id`, and finishes it; a callback for an already-finished job is ignored. `sweep` fails `running` jobs older than 10 minutes, releases their hold share, and re-queues them when `attempts < 2`. The cron route requires `CRON_SECRET`.

**Tests:** claim is exclusive across two concurrent ticks; `sweeper releases and retries once` then fails for good on the second timeout; duplicate callback is a no-op; a `'rate_limited'` submit leaves the job queued with `run_after` 10 seconds ahead; a `'blocked'` result marks the job blocked and calls `onFail` with `blocked: true`; throttle never submits more than 15 in one tick.

### Task 13: Script writer

Build: Opus. Review: Opus.

**Files:** Create `lib/story/script.js`, `lib/story/prompts/{script,styles}.js`, `lib/story/limits.js`, `pages/api/story/projects/[id]/[action].js` (dispatcher; this task adds `script`, `revise`, `scene`), `tests/story/script.test.js`.

**Decisions:** `styles.js` exports `STYLES = { '3d_family', '2d_cartoon', 'anime', 'clay', 'comic', 'flat_motion', 'watercolor', 'custom' }`, each `{ label, promptFragment, sampleImage }`. The script prompt encodes spec 7.5 and takes `{ purpose, offer, audience, avoid, seconds, mode:'narrated'|'talking', beats? }`; shot count target is `round(seconds / 3)`. `checkScriptRules` enforces deterministically: first line at most 12 words; no `—`, `–` or ` - ` in lines; the word "free" not alone; no "guarantee" forms; at most one scene flagged `mention:true`; total spoken words within `seconds x 2.2` to `seconds x 3.0`. `writeScript` retries once with the violations fed back, then returns the script with remaining violations attached for the UI. Moderation (`screenText`) runs on the brief and on every customer edit. `limits.assertAllowed` implements the free-tier and per-project caps from spec section 8.

**Tests:** rule checker flags each violation with the right `rule`; a mocked LLM response with a dash triggers one retry; revising one scene bumps the version and calls `markStale` for that scene only; a free user's fourth project in a day throws `LimitError`; text failing moderation returns 422 and stores nothing.

### Task 14: Cast

Build: Sonnet. Review: Opus.

**Files:** Create `lib/story/cast.js`, `lib/story/prompts/cast.js`; extend the action dispatcher (`cast`, `cast-regen`, `cast-pick`); `tests/story/cast.test.js`.

**Behaviour:** `generateCast` asks the LLM (`fast`) for the character list from the script (`[{ name, description, voiceNote }]`, max 5), charges the 90-credit project fee once (`spendCredits`, ref `project-fee:<projectId>`), and enqueues 3 `cast_image` jobs per character. Picking a candidate enqueues one cast-sheet job (front, three-quarter, close-up in one image) using the pick as reference. Regeneration beyond 2 per character costs `castRegen`. A free-plan user gets 402 with `error:'plan_required'`.

**Tests:** fee charged exactly once across repeated calls; 3 jobs per character; third regeneration charges 5; pick without finished candidates returns 409.

### Task 15: Storyboard

Build: Opus. Review: Opus.

**Files:** Create `lib/story/storyboard.js`, `lib/story/prompts/shot.js`; extend dispatcher (`shots`, `stills`, `shot`); `tests/story/storyboard.test.js`.

**Behaviour:** `buildShotList` turns scenes into shots (LLM `smart` returns `[{ sceneId, description, line, seconds, cast:[names] }]`; seconds 3 to 6; sum within 10% of target x 1.0). Rebuilding preserves shots whose `scene_id`, `description` and `line` are unchanged (keeps their still and clip). `generateStills` enqueues `still` jobs with refs = cast sheets of the named cast (max 3) + product photo if attached; first still per shot is free, re-roll costs `stillReroll`. `updateShot` patching `description` clears the still and sets `stale` on the clip; patching `quality` only changes price. `markStale` flags shots of the given scenes.

**Tests:** preserved shots keep `clip_url` after a one-scene edit and the edited scene's shots are `stale`; still refs never exceed 3 cast sheets; re-roll charges 2; a shot with `source:'footage'` gets no still job.

### Task 16: Quote, generate, re-roll

Build: Opus. Review: Opus, Fable.

**Files:** Create `lib/story/shots.js`; extend dispatcher (`quote`, `generate`, `reroll`); create `pages/api/story/projects/[id]/status.js`; `tests/story/generate.test.js`.

**Behaviour:** `quoteGeneration` prices only shots that are generated-source and not `ready` (or are `stale`). `startGeneration` requires `confirmTotal === quote.total`, places one hold, enqueues a `clip` job per shot with its share in `cost_credits`. Clip `onDone`: settle the share (ref `clip:<jobId>`), set shot `ready`. `onFail`: release the share, set `failed` or `blocked` with a customer-readable message. When no jobs remain the hold is closed. `rerollShot`: free while `rerollsUsed < ceil(shots x 0.2)`, else holds the shot's price. The status route returns the contract shape and calls `tick({ projectId, limit: 15 })`.

**Tests:** quote for 15 pro_narrated 3 second shots is 630; `confirmTotal` mismatch throws `QuoteChangedError` (409); `second generate while holding returns 409`; insufficient credits returns 402 and enqueues nothing; one blocked shot releases 42 and the other 14 settle; free re-roll count for 15 shots is 3; the fourth re-roll holds credits; a full mock run ends with `held === 0` and ledger sum equal to the quote.

### Task 17: Maker UI

Build: Sonnet. Review: Opus.

**Files:** Create `pages/app/new.js`, `pages/app/p/[id].js`, `components/maker/{MakerLayout,StepStart,StepPurpose,StepStyle,StepLength,StepScript,StepCast,StepStoryboard,StepGenerate,StepReview,QuoteBar,ShotCard,useProject}.js` with CSS modules, `tests/ui/maker.test.js`.

**Decisions:** `useProject(id)` polls `/status` every 3 seconds while any job is active, every 15 otherwise. The stepper follows `Project.step`; earlier steps stay clickable; stale steps show a badge. `QuoteBar` is always visible from the length step on, showing estimated credits, balance and the shortfall with a top-up link. Generate opens a confirm modal with the line items from `/quote` and sends `confirmTotal`. Every error from the contract (401, 402, 409, 422) has a specific message and next action. Layout works at 390 wide (chat collapses to a bottom sheet).

**Tests:** stepper reflects step and stale state; generate button disabled until all generated-source shots have stills; 402 response renders the top-up prompt; confirm modal posts the quoted total.

### Task 18: Chat

Build: Opus. Review: Opus.

**Files:** Create `lib/story/chatTools.js`, `pages/api/story/chat.js`, `components/maker/ChatPanel.js`, `tests/story/chat.test.js`.

**Behaviour:** tools exposed to the model: `get_project`, `revise_script`, `update_scene`, `regenerate_character`, `update_shot`, `set_style`, `set_length`, `get_quote`. No tool spends credits beyond the included allowances; spending actions return `{ needsConfirm:true, quote }` and the panel renders a confirm button that calls the normal route. The system prompt carries the project state summary and the spec 7.5 rules. Messages stored in `story_chat(project_id, role, content, created_at)` (add to the Task 10 migration file as a follow-up statement). Per-project message cap from `limits`.

**Tests:** a tool call for another user's project is refused; the 151st message returns the cap message without calling the LLM; a spend-type request yields `needsConfirm` and no ledger change; customer text is moderated.

## Stage 4: Finish

### Task 19: Narration, music, audio plan

Build: Sonnet. Review: Opus.

**Files:** Create `lib/story/audio.js`; extend dispatcher (`audio`, `narration`, `music`); `components/maker/StepAudio.js`; `tests/story/audio.test.js`.

**Behaviour:** audio plan `{ mode:'narrated'|'talking', voiceId, voiceTrackAssetId, music:{ type:'generated'|'upload'|'none', prompt, assetId }, captions:{ on, style:'serif_accent'|'bold_pop'|'clean' } }`. Narration is one `synthesize` call over all narrator lines joined with sentence breaks, then sliced per line at silences (`ffmpeg silencedetect`, threshold -35 dB, min 0.25 s); if slice count mismatches line count, fall back to proportional split by character count. Three free generations each for narration and music, then `narrationRegen` / `musicRegen`. Music prompt always appends "full from the first second, no soft intro".

**Tests:** slicer returns one segment per line on the fixture with known silences; mismatch triggers the proportional fallback; fourth narration charges 5; uploaded track bypasses TTS.

### Task 20: Captions, render, checks

Build: Opus. Review: Opus, Fable.

**Files:** Create `lib/story/captions.js`, `lib/story/render.js`, `lib/story/checks.js`, `pages/api/story/render-worker.js` (`maxDuration: 300`, memory 3009), `scripts/make-caption-font.md`, `public/fonts/` (one serif display font with an open licence), `tests/story/captions.test.js`, `tests/story/render.test.js`.

**Behaviour:**
- `captions.buildCaptionEvents({ words, cuts, style })`: group words into phrases of at most 4 words that never cross a cut; within each speech stretch re-time words by syllable count; minimum 0.42 s per word; returns ASS text when `ffmpeg -filters` lists `ass`/`subtitles`, otherwise PNG overlays via `sharp` (add dependency) with enable windows. Vertical position: centre at y 1250 on 1080x1920, scaled for other aspects, always within 285 to 1635.
- `render`: normalise each clip (fps 30, target resolution, trim to shot seconds), concat with the concat demuxer, overlay footage shots and insets (rounded frame), mix narration + per-clip native audio (talking mode) + music with `sidechaincompress` ducking, high-pass music at 40 Hz, start music 4 s in when the track is long enough, `loudnorm` to -14 LUFS, burn captions, upload via `storage.putObject`, write `story_renders`. Rendering never charges credits.
- `checks.run({ renderPath, scriptWords })`: Whisper the final audio and require 95% of script words; no silence over 0.6 s (talking or narrated); integrated loudness -15 to -13 LUFS. One automatic retry of the mix on failure, then warnings saved on the render row.

**Tests:** syllable re-timing keeps total stretch duration and enforces 0.42 s minimum; no caption event spans a cut time; computed y position stays in the safe band for 9:16, 1:1 and 16:9; rendering 4 fixture clips with narration and music produces an mp4 whose duration is within 0.1 s of the shot sum, with one audio stream at -14 ±1 LUFS (measured with `ffmpeg ebur128`); re-render after a caption-style change creates version 2 and no ledger rows.

### Task 21: Finish UI

Build: Sonnet. Review: Opus.

**Files:** Create `components/maker/StepFinish.js`, `components/app/VideoPlayer.js`; modify `pages/app/index.js` (thumbnails, download, duplicate, delete). Extend dispatcher (`render`, `duplicate`).

**Tests:** warnings from `checks` render as a dismissible list; download uses the render URL with a filename from the project title; render button shows progress from `/status`.

**Gate after this task:** run the full mock pipeline in the browser, then stop and report to Ibrahim for the quality comparison in spec 13a (needs real keys and his judgement).

## Stage 5: References

### Task 22: Reference ingestion and analysis

Build: Opus. Review: Opus.

**Files:** Create `lib/story/analyze.js`, `lib/story/prompts/analysis.js`, `components/maker/{StepReference,StepBreakdown}.js`; extend dispatcher (`analyze`); modify `pages/api/upload-token.js` (allow video for authenticated story uploads up to 100 MB); `tests/story/analyze.test.js`.

**Behaviour:** `analyze` job: get the file (asset or `fetchReference`), probe duration (reject over 180 s), scene-detect with threshold 0.22 and merge cuts closer than 0.3 s, extract 2 frames per shot scaled to 448 wide (cap 80 frames), `transcribe`, LLM `fast` returns `{ beats: Beat[], hook, structure, musicMood, mode }`, save to `story_references`, delete the source file and audio. Links allowed only for hosts `instagram.com`, `tiktok.com`, `facebook.com`, `fb.watch`; anything else returns 422 "Upload the file instead". The rights statement checkbox value and timestamp are stored. `writeScript` with a reference passes beats and instructs: keep beat order and pacing, new lines, new characters, new setting, none of the reference's sentences.

**Tests:** fixture reference yields a cut list and beats with ascending times; no-speech fixture still yields beats with empty `said`; a single-shot video yields one beat; a 181 s file, a 101 MB file and a youtube link each return their specific 422 message and create no job; the source file is deleted after analysis; adapted script contains no sentence from the transcript (checked by normalised string match in the rule checker, retry once).

## Stage 6: Brand kit, own footage, audio, voices

### Task 23: Brand kit, product references, own footage

Build: Sonnet. Review: Opus.

**Files:** Create `lib/story/assets.js`, `pages/api/story/assets.js`, `pages/app/brand.js`, `components/maker/AssetPicker.js`, `tests/story/assets.test.js`. Modify `lib/story/storyboard.js`, `lib/story/render.js`, `components/maker/ShotCard.js`.

**Behaviour:** asset kinds `logo|product|mascot|recording|clip|audio|voice_sample`; images moderated on upload; brand text fields (`offer`, `audience`, `tone`, `avoid`, colours) stored on a `story_brand` row and prefilled into new projects. A shot can be set to `source:'footage'` with `footage_asset_id` and `{ trimStart, fit:'cover'|'contain' }`, or keep `generated` and add `inset_asset_id` with `{ x, y, w }` in percent. `avoid` words are appended to the script rule checker.

**Tests:** footage shots are excluded from quotes; product asset appears in still refs; an avoid word in a line is flagged; deleting an asset in use returns 409 listing the projects.

### Task 24: Audio upload and voice cloning

Build: Sonnet. Review: Opus.

**Files:** Create `lib/story/voices.js`, `pages/api/story/voices.js`, `pages/app/voices.js`, `tests/story/voices.test.js`. Modify `lib/story/audio.js`, `components/maker/StepAudio.js`.

**Behaviour:** clone requires a sample of 10 to 60 s and `consent: true`; stores the statement text, time and request IP in `story_voices`; costs `voiceClone`; clones are private to the owner. Uploaded voice track or music: mp3, wav or m4a up to 20 MB, probed with ffprobe.

**Tests:** missing consent returns 422 and charges nothing; another user's voice id in an audio plan returns 404; a 9 second sample is rejected; clone charges 20 once.

## Stage 7: MCP connector

### Task 25: OAuth server

Build: Opus. Review: Opus, Fable.

**Files:** Create `supabase/migrations/20261114_story_oauth.sql`, `lib/mcp/oauth.js`, `pages/api/oauth/{register,authorize,token}.js`, `pages/oauth/consent.js`, `tests/mcp/oauth.test.js`. Modify `next.config.js` (rewrites for `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource` to API routes), `middleware.js`.

**Decisions:** authorization code with PKCE S256 only; dynamic client registration; access tokens are random 32-byte values stored as SHA-256 hashes, 1 hour life; refresh tokens rotate; redirect URIs must be https (or localhost) and exactly match registration; consent page requires the Supabase session and shows the client name. Verify the current MCP authorization spec requirements against the official docs before implementing.

**Tests:** wrong `code_verifier` is rejected; a code is single-use; unregistered redirect URI is rejected; an expired access token returns 401 with a `WWW-Authenticate` header pointing at the resource metadata; refresh rotation invalidates the old refresh token.

### Task 26: MCP server and tools

Build: Opus. Review: Opus.

**Files:** Create `lib/mcp/{server,tools}.js`, `pages/api/mcp.js`, `tests/mcp/tools.test.js`, `docs/connector.md` (install steps for customers). Add `@modelcontextprotocol/sdk`.

**Tools:** `create_project`, `analyze_reference`, `get_project`, `write_script`, `set_script`, `generate_cast`, `pick_cast`, `generate_storyboard`, `get_quote`, `generate_video` (requires `confirm_total`), `get_status`, `render`, `get_result`. Each maps to one `lib/story` function with the token's user id. Long work returns immediately with the project id and status text telling the model to poll `get_status`. Streamable HTTP transport, stateless.

**Tests:** a tool call without a valid token is 401; `generate_video` without `confirm_total` returns the quote and spends nothing; a full mock sequence through the tools ends in a render URL; tools cannot reach another user's project.

## Stage 8: Plans, admin, go-live

### Task 27: New plans, yearly grants, admin pricing, go-live checklist

Build: Opus. Review: Opus, Fable.

**Files:** Modify `lib/stripe.js` (add v2 plans, yearly prices and top-ups under new `lookup_key`s prefixed `ariya_v2_`; legacy ones untouched), `pages/api/checkout.js`, `lib/grants.js`, `pages/admin/index.js` (pricing_config editor, `billing_v2` switch, cost-per-credit readout), old funnel pricing pages (buttons use v2 plans when `billing_v2` is on). Create `pages/api/cron/grant-yearly.js`, `docs/go-live.md`, `tests/plansV2.test.js`.

**Tests:** monthly invoice paid calls `renewPlanCredits` with the plan's allotment; yearly subscribers get one grant per month from the cron, idempotent on `yearly:<subId>:<YYYY-MM>`; a legacy subscriber's renewal grants `ceil(legacyCredits x 21 / 100)`; admin routes reject non-admins; checkout with v2 off still sells legacy plans.

**`docs/go-live.md`** lists, in order, the steps only Ibrahim runs: create provider accounts and env vars, review and apply the four migrations, run the legacy migration in dry-run then for real, set the kie webhook secret, flip `billing_v2`, quality comparison, turn on ads.

### Task 28: End-to-end mock test and branch review

Build: Opus. Review: Fable (whole branch).

**Files:** Create `tests/e2e/mockPipeline.test.js`, update `README.md` to describe the real product.

**Tests:** one test drives create → script → cast → pick → shots → stills → quote → generate → narration → music → render entirely in mock mode against PGlite and asserts: a render row with a URL, `held === 0`, ledger total equals fee plus quote, no job left non-terminal. A second test repeats it starting from the fixture reference video.

**Then:** `npm test`, `npm run build`, browser walkthrough of `/`, `/app`, the maker and one legacy tool, and the final whole-branch review.
