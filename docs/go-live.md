# Go-live checklist (owner only)

These are the steps only Ibrahim runs, in order. Nothing in this list has been done by the build: no migration has been
applied to the hosted Supabase (it is shared with haelabs.live), no live Stripe object was created, nothing was deployed,
and no paid provider call was made. Work top to bottom; do not skip ahead.

## 1. Provider accounts and environment variables

Create the accounts that do not exist yet, then add every variable below to Vercel (Production, Preview and Development)
and to `.env.local` for local runs. `.env.example` lists them all with notes.

| Variable | What it is | Notes |
|---|---|---|
| `APP_URL` | The one canonical public URL, e.g. `https://ariyalab.com` | **Required.** Pick www or apex and redirect the other to it: the OAuth consent screen compares the request Origin to `APP_URL`, Stripe return URLs and the MCP connector URL (`APP_URL/api/mcp`) use it. |
| `CRON_SECRET` | Random string | **Required in every environment** before deploy. Every cron route and the signed job ids fail closed without it. |
| `ADMIN_EMAILS` | Comma-separated admin emails | Admins need a confirmed email. |
| `ANTHROPIC_API_KEY` | Claude (script, analysis, moderation) | |
| `KIE_API_KEY`, `KIE_WEBHOOK_SECRET` | kie.ai (video, images) | Set the webhook secret in the kie.ai dashboard to the same value. |
| `FISH_API_KEY` | Fish Audio (voices, cloning) | New account. |
| `GOOGLE_AI_API_KEY` | Google AI Studio / Lyria (music) | New account. |
| `APIFY_TOKEN` | Apify (reference video links) | Existing account. |
| `REPLICATE_API_TOKEN` / `GROQ_API_KEY` | Transcription (Groq first when set, Replicate Whisper otherwise) | |
| `SCRAPECREATORS_API_KEY` | Optional link fetcher | |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob storage | `R2_*` only if moving to Cloudflare R2. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Stripe | See section 4. |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Supabase | |
| `NEXT_PUBLIC_GOOGLE_CLIENT_ID` | Google sign-in button | Google Cloud "Authorized JavaScript origins" must include the production domain (and `http://localhost:3000` for local testing). |
| `NEXT_PUBLIC_SOCIAL_INSTAGRAM`, `NEXT_PUBLIC_SOCIAL_TIKTOK`, `NEXT_PUBLIC_SOCIAL_YOUTUBE` | Footer social links | Icons are hidden while unset. |
| `META_ACCESS_TOKEN`, `META_ADS_TOKEN`, `META_ADS_ACCOUNT_ID`, `NEXT_PUBLIC_TIKTOK_PIXEL_ID` | Ads and pixels | Only needed at step 11. |

Platform:

- **Vercel Pro** is required: the render worker runs with 3009 MB and 300 s (`vercel.json`), and `/api/cron/story-tick`
  runs every minute. On Hobby the cron runs daily and closed-tab progress is much slower.
- Crons in `vercel.json`: `cleanup-history` (daily), `story-tick` (every minute), `oauth-cleanup` (daily),
  `legacy-holds` (every 10 min), `grant-yearly` (daily), `story-holds` (every 10 min), `story-cleanup` (daily).
- Supabase Auth: "Confirm email" must be ON (admin checks and the email claim proof rely on confirmed emails).
- The storage host must not share cookies with the app domain. If you move to Cloudflare R2, serve it with
  `X-Content-Type-Options: nosniff` (a Cloudflare transform rule); Vercel Blob already sends it.

## 2. Review and apply the migrations

Pre-checks on the shared database, before applying anything:

- Duplicate customer links must not exist:
  `select stripe_customer_id, count(*) from profiles where stripe_customer_id is not null group by 1 having count(*) > 1;`
  must return nothing.
- Run the pre-check query in the header of 000100, 000200 and 000500 (no `credit_*` / `story_*` names already taken;
  the haelabs checks for `profiles`).

Apply in this exact order. Every migration is additive (new `credit_` / `story_` objects) except where noted.

| # | File | What it needs |
|---|---|---|
| 1 | `20261114000100_credit_ledger.sql` | Run its header pre-check (no `credit_*` names already taken). Apply **before deploying** any of this code: even with billing v2 off the grant path writes `stripe_events`. |
| 2 | `20261114000150_grants.sql` | After 000100. |
| 3 | `20261114000200_story_schema.sql` | Run its header pre-check (no `story_*` tables already). |
| 4 | `20261114000300_story_oauth.sql` | MCP connector OAuth tables. |
| 5 | `20261114000400_story_runner.sql` | Job runner columns. |
| 6 | `20261114000500_profiles_policy.sql` | **Owner review first.** Touches `profiles`, which is shared with haelabs.live. Run the haelabs pre-checks in its header; skip it if haelabs would be affected. |
| 7 | `20261114000600_credit_legacy_tools.sql` | Apply **before deploy even with billing v2 off** (the old tools call its functions). |
| 8 | `20261114000700_story_cast.sql` | |
| 9 | `20261114000800_story_storyboard.sql` | |
| 10 | `20261114000900_story_audio.sql` | |
| 11 | `20261114001000_story_generate.sql` | Replaces `story_delete_project`. |
| 12 | `20261114001100_story_chat_confirm.sql` | |
| 13 | `20261114001200_story_references.sql` | |
| 14 | `20261114001300_story_render.sql` | |
| 15 | `20261114001400_story_voices.sql` | |
| 16 | `20261116000100_story_mcp_drafts.sql` | Before the MCP code deploys. |
| 17 | `20261116000200_story_mcp_draft_versions.sql` | Before the MCP code deploys. |
| 18 | `20261116000300_story_assets.sql` | Before asset DELETE works. |
| 19 | `20261116000400_billing_v2.sql` | Yearly subscriptions and invoice-grant tables, their functions, and the closed-hold guard (replaces `credit_charge_closed_hold`, same signature). Before deploying the v2 billing code. |
| 20 | `20261116000500_story_cleanup.sql` | Stale-hold sweeper and retention functions. Before the `story-holds` and `story-cleanup` crons run. |

Checks on the real database after applying (they cannot be tested in the in-memory database):

- The service role can write `profiles.stripe_customer_id` (through `credit_link_customer`).
- Two-connection checks: the credit claim advisory lock (two sessions racing one claim) and `story_claim_jobs` (two
  sessions never claim the same job).
- PostgREST passes `RAISE ... USING DETAIL` through as `details` (one `insufficient_credits` call from the app).
- PostgREST treats a missing column in an insert as its default.

## 3. Legacy credit migration (dry run, then for real)

The script moves this app's legacy credit balances (Stripe customer metadata) into the ledger.

1. Dry run now, to see the numbers: `node scripts/migrate-legacy-credits.mjs --cutoff=<planned ISO time of the flip>`.
   It writes nothing. Read the printed rows and totals (`--include-dormant` to also list customers with no plan).
2. The real run happens right after billing v2 is turned on (step 7): dry run again with `--cutoff=<the exact ISO time
   billing_v2 was turned on>`, then
   `node scripts/migrate-legacy-credits.mjs --cutoff=<ISO> --apply --confirm=<rows>:<total>` with the rows and total
   that dry run printed (`--allow-live` is needed with a live key). Keep the JSON report it writes.

After `--apply`, **billing v2 is one-way**: migrated customers live in the ledger. The admin switch refuses to turn
billing v2 off once any customer was migrated (409).

Shared Stripe account: haelabs.live uses the same Stripe customers. Decide whether haelabs keeps its own balances on a
shared customer (this app only reads and writes `ariyalab_*` metadata keys and its own lookup keys).

## 4. Stripe

- Webhook endpoint `APP_URL/api/stripe-webhook`, subscribed to exactly these events (the handlers in
  `pages/api/stripe-webhook.js`):
  - `invoice.payment_succeeded`
  - `checkout.session.completed`
  - `charge.refunded`
  - `charge.dispute.created`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`
- Prices are created lazily on the first checkout click (idempotent on `lookup_key`). Billing v2 keys start with
  `ariya_v2_` and name the amount and credits (`ariya_v2_creator_month_4900_2600`), so a price edited in the admin
  pricing editor becomes a new Stripe price; subscribers keep the price and credits they bought.
- Plan changes go through the Stripe customer portal: /app/billing has a **Manage billing** button
  (`/api/billing/portal`, a portal session for the signed-in buyer's own customer; the return URL is always `APP_URL`).
  A signed-in buyer who already has a plan (also past_due) is refused at checkout (409). The anonymous pay-first
  funnels can buy a v2 plan; when that purchase is claimed by an account that already has a plan, the new
  subscription is cancelled and its first invoice refunded through Stripe, the new customer is not linked and the
  buyer sees "You already have a plan — use Manage billing to change it. Your new payment has been refunded." (or
  "... nothing was charged." for a trial or a 100% coupon). A claimer whose account already has a DIFFERENT Stripe
  customer with no plan is refused the same way: "Buy the plan while signed in so it joins your account." The same
  check runs on `/api/checkout/confirm` (a second plan bought in another tab). Check one such refund in test mode
  (only mocked so far).
- Configure the portal in the Stripe dashboard: the v2 Starter, Creator and Studio prices (monthly and yearly) as the
  products customers may switch between, **upgrades invoiced immediately** (proration "always invoice") and
  **downgrades at the end of the period**: in the portal's subscription-update settings, schedule both
  `decreasing_item_amount` and `shortening_interval` changes at the period end. The code does not rely on this (flips
  between intervals and plans never grant the same paid time twice), it is defence in depth. **The portal configuration is account-wide: the Stripe account is shared
  with haelabs.live**, so check that its settings suit haelabs too (or create a separate portal configuration and pass
  it), and that haelabs' promotion codes are restricted to haelabs' products before `allow_promotion_codes` checkouts
  go live here.
- How a plan change is credited:
  - An upgrade is granted only when its proration invoice is paid (also when paid from the customer balance): the
    difference between the new monthly credits and the highest level already granted this period, **prorated by the
    time left in the period** when the invoice was paid. With prorations left for the next cycle invoice, nothing is
    granted for that period. A downgrade grants nothing; the lower allotment starts at renewal.
  - Monthly to yearly (also a switch invoice with no "unused time" line whose period start moved): the year starts
    with that invoice; its first month is granted at once (`yearly:<sub>:<YYYY-MM-DD>:m0`), the cron grants the other
    eleven (12 per paid year).
  - An upgrade is measured from the highest level already granted for the moment it happens (any window: the
    monthly period, a yearly month, an earlier upgrade, a switch), so a downgrade followed by an upgrade back, or
    flips between monthly and yearly, grant nothing new. A switch into yearly grants month 0 only for the part of the
    month no earlier grant covers, and nothing when nothing was paid. A late upgrade webhook is measured on the
    period its invoice line names.
  - Yearly to a dearer yearly price: the current month's difference is prorated (or, if that month has not been
    granted yet, the cron grants it at the new level), later months at the new level.
- Renewals are granted at the plan the invoice paid for (its own line), not the subscription's plan at that moment.
- Yearly v2 plans: the invoice grants the first month, `/api/cron/grant-yearly` grants each following month
  (`yearly:<subscription>:<YYYY-MM>`).
- Refunds and disputes: a **full** refund or dispute of a yearly invoice reverses month 0 and every month granted so
  far and stops the remaining months; a **partial** one reverses that share of each month granted so far and of each
  later month as it is granted (the months continue). A refund or dispute of an upgrade invoice reverses its share of
  the upgrade grant, takes the same share of the upgrade's step back from every month the cron granted at the raised
  level since the upgrade, and lowers a yearly plan's monthly level by the strict rule: the level before the year's
  first upgrade plus each upgrade's step times the share of it still paid for (refunding an earlier upgrade lowers
  the level even when a later one is still paid). It never stops the year.
- Verify on the first test-mode upgrade that the proration invoice lines carry `proration` and the price (the code
  reads both the 2024-06-20 shape and the newer `parent` / `pricing` shape).
- Several yearly months that come due at once (the cron was down for over a month, or the customer linked their
  account late) are granted one after the other, and the plan rollover rule (at most one month carried over) caps
  the total. Keep the cron running; grant the difference by hand from /admin if it happens.

## 5. Kie webhook secret

Set `KIE_WEBHOOK_SECRET` on Vercel and the same secret in the kie.ai dashboard, then confirm one webhook arrives and is
accepted (the runner also polls, so a missing webhook only slows things down).

## 6. Deploy

Only after steps 1-5 (every migration applied, Stripe webhook and portal configured, kie secret set). billing v2 stays
off. Then check on the deployed app:

- In the function bundles, ffmpeg is traced into the story worker, analyze, assets and render routes, and `sharp` only
  where it is used.
- On a Vercel (linux) function: `ffmpeg -filters | grep ass` lists the `ass` filter; render one frame with captions.
- Vercel keeps a worker running after its caller aborts, and large renders upload to Blob with multipart: confirm both
  on the first long render.
- Each cron answers 200 when called with `Authorization: Bearer $CRON_SECRET` (and 401 without).

## 7. Prices, then flip billing v2

1. Open `/admin` → Pricing. Set the final plan and pack prices, the yearly discount (0 until you set one) and per-quality
   rates. Check the cost per credit and the margin per quality against provider cost.
2. If the live config differs from the built-in defaults, the page warns: the homepage pricing section shows the
   built-in defaults (`lib/pricingConstants.js`), so update those and redeploy to match.
3. Turn billing v2 on (the switch asks for confirmation) and note the exact time. Other server instances pick up config
   changes within 60 s.
4. Run the legacy migration for real right away (step 3, part 2).

## 8. Owner reviews before launch

- Consent wording for voice cloning: third-party processing (Fish Audio) and retention.
- Fish voice provider-side delete is not implemented; the app removes the voice from the account only (the copy says
  "removed from your account").
- Captions in non-Latin scripts need a font with those glyphs (today they get a `captions_missing` warning).
- Paid transcription runs on each render: decide between a render cap and a charge.
- Read the script prompt (Task 13 report) and run it once on the real model.
- When `pricing_config` cannot be read on a cold instance, checkout answers 503 (also for legacy plans) rather than
  sell the wrong plan: accepted.
- Privacy: files of a DELETED project (not an expired one) are not swept by the retention job; they stay in storage
  until removed by hand. Decide whether the delete should remove them.

## 9. Quality comparison and live smoke tests (only with explicit approval and a stated cost)

Each of these spends real money; run one only after approving it and its cost.

- `scripts/provider-smoke.mjs` once per provider (kie, Fish, Google, Apify, Replicate or Groq, Blob).
- Apify: one live reference link longer than 180 s, to confirm it is refused (today after the download, R9) and what
  the download cost.
- The spec 13a quality comparison.
- Kling element-name format (accents are dropped from names) and the real kie/Kling refusal strings.
- Meta Ad Library live check.
- The real Claude connector: add `APP_URL/api/mcp` in claude.ai and in Claude Code and run one tool.
- Google sign-in on `/sign-in`, `/sign-up` and the OAuth consent sign-in.

## 10. Hardening list (known, not blocking)

- `lib/story/analyze.js` runs ffmpeg on reference media without a protocol whitelist or forced demuxer.
- `pages/api/upload-token.js` signed-in limits allow image/* and video/* up to 1 GB on any allowed path (the server
  re-checks on registration).
- Audio handlers: putObject has no deadline signal; the own-recording download timeout (10 min) exceeds the worker
  window.
- Files of a deleted project are not swept by the retention job (only expired projects and the brand/audio upload
  folders are); a future sweep of `story/<id>/` prefixes without a project row would cover them.
- Reference links (R9): a link over 180 s is refused only after the download, when the file is probed; refuse it
  before the download from the provider's metadata.
- Legacy QuickTime files without an `ftyp` box are refused by the upload magic-byte check (customers re-export).

## 11. Turn on ads

Only after everything above: set the Meta and TikTok variables and start campaigns.

---

## Runbook

### Stuck legacy holds (old tools under billing v2)

`/api/cron/legacy-holds` retries holds whose job succeeded but whose charge failed (`settle_retry`). It never releases
them (that would give the work away). Once a row has more than 20 attempts every run logs a line starting with
`[legacyHolds] OPERATOR:`.

Find them:

```sql
select hold_id, user_id, currency, amount, route, provider, job_id, attempts, last_error, created_at, last_attempt_at
  from credit_legacy_holds
 where status = 'settle_retry' and attempts > 20
 order by created_at;
```

End one by hand, after reading `last_error` and fixing its cause:

1. Was it charged already? `select public.credit_hold_charged('<hold_id>');` If true, mark it:
   `select public.credit_legacy_hold_mark('<hold_id>', 'settled', 'ended by operator');`
2. If not, and the job really succeeded, charge it (spends from plan, then top-up):
   `select public.credit_charge_closed_hold('<hold_id>', '<user_id>', '<currency>', <amount>, 'legacy_tool', 'legacy:<route>:<job_id>');`
   (if the hold is still active, `select public.credit_settle('<hold_id>', <amount>, 'legacy_tool', 'legacy:<route>:<job_id>');`)
   then mark it `settled` as above.
3. If the job did not really succeed, release it: `select public.credit_release('<hold_id>');` and mark it `released`.

### Stale story holds

`/api/cron/story-holds` gives back, every 10 minutes, what is left of a story project hold older than 30 minutes that no
job, claim or cast round can still end. Each release is logged as `[holdSweeper] released a stale story hold`. To see
what it would look at:

```sql
select h.id, h.user_id, h.project_id, h.amount, h.remaining, h.created_at
  from credit_holds h
 where h.status = 'active' and h.project_id is not null and h.created_at < now() - interval '30 minutes'
 order by h.created_at;
```

### Retention

`/api/cron/story-cleanup` runs daily. `pricing_config.retentionDays` (default 30) sets how long project files live. It
never deletes a brand-kit or own file (`story_assets`) or a file another unexpired project uses.
