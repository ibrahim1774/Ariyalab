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
| `KIE_API_KEY`, `KIE_WEBHOOK_SECRET`, `KIE_WEBHOOK_HMAC_KEY` | kie.ai (video, images) | `KIE_WEBHOOK_SECRET` is our own random string (it signs the callback URL we send). `KIE_WEBHOOK_HMAC_KEY` (optional) is the HMAC key shown in the kie.ai dashboard; when set, kie's signature header is checked too. |
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
| 19 | `20261116000400_billing_v2.sql` | Yearly subscriptions, yearly periods and priced plan lines (plan changes credited by money), their functions, and the closed-hold guard (replaces `credit_charge_closed_hold`, same signature). Before deploying the v2 billing code. |
| 20 | `20261116000500_story_cleanup.sql` | Stale-hold sweeper and retention functions. Before the `story-holds` and `story-cleanup` crons run. |
| 21 | `20261116000600_story_render_charge.sql` | `story_renders.hold_id` and `cost_credits` (paid re-renders). Before deploying the render-charge code: `startRender` writes both columns. |
| 22 | `20261116000700_story_length_range.sql` | The 5 to 120 second video length range. Before deploying the length code. |
| 23 | `20261116000800_story_consistent_cast.sql` | `story_projects.consistent_cast` (same characters or different people in every scene). Before the code that reads it. |
| 24 | `20261116000910_story_plan_requested.sql` | `story_projects.plan_requested` (the "design my video" marker). Before the simple maker deploys. |
| 25 | `20261117000100_story_mode_independent.sql` | `mode` (narrated or talking) independent of quality. Before the sound-on code. |
| 26 | `20261117000200_story_shot_line_index.sql` | `story_shots.line_index` and its use in `story_shots_replace`. Before the speaker-from-script code. |
| 27 | `20261117000300_story_scene_setting.sql` | `story_shots.setting` (the scene setting line). Before the code that carries it in prompts. |
| 28 | `20261117000400_story_shots_replace_setting.sql` | Redefines `story_shots_replace` to keep `line_index` and `setting` (same signature). After 26 and 27. |
| 29 | `20261117000500_story_cast_style_stale.sql` | `story_cast.style_stale` (a character cleared by an art style change and waiting to be drawn again). Before the style-change code. |
| 30 | `20261117000600_story_settings_repair_at.sql` | `story_projects.settings_repair_at` (the scene settings repair marker, one model try per 10 minutes). Before the code that writes it. |

Checks on the real database after applying (they cannot be tested in the in-memory database):

- The service role can write `profiles.stripe_customer_id` (through `credit_link_customer`).
- Two-connection checks: the credit claim advisory lock (two sessions racing one claim) and `story_claim_jobs` (two
  sessions never claim the same job).
- PostgREST passes `RAISE ... USING DETAIL` through as `details` (one `insufficient_credits` call from the app).
- PostgREST treats a missing column in an insert as its default.

## 3. Legacy credit migration (dry run, then for real)

The script moves this app's legacy credit balances (Stripe customer metadata) into the ledger.

Owner decision (2026-11-16): dormant balances (customers with no active plan) ARE moved, so every run below uses
`--include-dormant`.

1. Dry run now, to see the numbers: `node scripts/migrate-legacy-credits.mjs --cutoff=<planned ISO time of the flip> --include-dormant`.
   It writes nothing. Read the printed rows and totals.
2. The real run happens right after billing v2 is turned on (step 7): dry run again with `--cutoff=<the exact ISO time
   billing_v2 was turned on> --include-dormant`, then
   `node scripts/migrate-legacy-credits.mjs --cutoff=<ISO> --include-dormant --apply --confirm=<rows>:<total>` with the rows and total
   that dry run printed (`--allow-live` is needed with a live key). Keep the JSON report it writes.

After `--apply`, **billing v2 is one-way**: migrated customers live in the ledger. The admin switch refuses to turn
billing v2 off once any customer was migrated (409).

Shared Stripe account: haelabs.live uses the same Stripe customers. Decide whether haelabs keeps its own balances on a
shared customer (this app only reads and writes `ariyalab_*` metadata keys and its own lookup keys).

## 4. Stripe

- Webhook endpoint `APP_URL/api/stripe-webhook`, subscribed to exactly these events (the handlers in
  `pages/api/stripe-webhook.js`):
  - `invoice.payment_succeeded`
  - `invoice.paid` (credits only; it also fires for an invoice with nothing to charge, such as a downgrade whose
    unused time goes to the customer balance)
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
  /app/billing shows the current plan (name, monthly or yearly, renewal date, or "Ends on <date>" when cancellation at
  period end is pending); the current plan's button reads "Your plan" and the others "Switch to <name>" and open the
  portal (the plan is read from the buyer's own Stripe customer, cached for a minute: `lib/currentPlan.js`).
  A signed-in buyer who already has a plan (also past_due) is refused at checkout (409). The anonymous pay-first
  funnels can buy a v2 plan; when that purchase is claimed by an account that already has a plan, the new
  subscription is cancelled and its first invoice refunded through Stripe, the new customer is not linked and the
  buyer sees "You already have a plan — use Manage billing to change it. Your new payment has been refunded." (or
  "... nothing was charged." for a trial or a 100% coupon). A claimer whose account already has a DIFFERENT Stripe
  customer with no plan is refused the same way: "Buy the plan while signed in so it joins your account." The same
  check runs on `/api/checkout/confirm` (a second plan bought in another tab). Check one such refund in test mode
  (only mocked so far).
- **The portal is configured by the code, not in the Stripe dashboard** (`lib/stripePortal.js`). With billing v2 on, every
  portal session names a billing-portal configuration owned by this app. Without one Stripe uses the ACCOUNT default,
  and the account is shared with other products (its default portal is "Manage your Prime Barber plan", with that
  product's prices and downgrades applied at once). The first "Manage billing" click creates ours when it is missing,
  found afterwards by metadata `app=ariyalab` plus a short hash of the settings and plan price ids (so a pricing change
  makes a new one; the id is cached in memory for 5 minutes). The code only lists and creates configurations: it never
  updates the account default or any configuration without our metadata. An old one of ours is left active and harmless;
  deactivate it in the dashboard if you like. Its settings:
  - headline "Manage your Ariya Lab plan"; payment method update and invoice history on; customer details off;
  - **cancel** allowed, **at the end of the period** (no proration);
  - **plan changes** (`subscription_update`, price only, quantity fixed at 1) among ONLY this app's v2 plan prices
    (`ariya_v2_` plan keys): the current Starter, Creator and Studio prices, monthly and yearly (created first when
    missing), then the older ACTIVE v2 plan prices that subscribers may still be on after a pricing change, newest
    first, so they can switch too (archived prices are never included). Stripe allows 10 products per configuration and
    each price has its own product: the six current prices always stay and the oldest extras are left out (a warning is
    logged once). The settings hash names the final price list, so a new price makes a new configuration;
  - proration **`always_invoice`**: an upgrade is billed at once, because `lib/grants.js` credits an upgrade only from a
    paid proration invoice;
  - **downgrades and shorter intervals at the end of the period** (`schedule_at_period_end` conditions
    `decreasing_item_amount` and `shortening_interval`: a cheaper plan, or yearly to monthly, starts at the next renewal,
    nothing is refunded or clawed back mid-period). A longer interval (monthly to yearly) and a dearer plan apply at once.
  These fields exist on the pinned API version (2024-06-20, `lib/stripe.js`) and on the installed stripe 22.x types; the
  account's own default API version (2022-08-01) is not used for these calls. Checked in test mode: Stripe accepts and
  returns all of them.
  - Billing v2 off: no configuration is passed (today's behaviour, the account default).
  - If the configuration cannot be made (Stripe error, flag unreadable) the buyer sees "We couldn't open billing. Please
    try again in a moment." and the cause is logged (`[billing/portal] failed`); the portal is never opened without ours.
  - Credits are unchanged by this: the code credits every plan change by the money it moves (below), however the portal
    is set. haelabs' promotion codes must still be restricted to haelabs' products before `allow_promotion_codes`
    checkouts go live here (the account is shared).
- **Owner check after changing plan prices:** open Manage billing as a subscriber who is still on the OLD price (test
  mode) and confirm the portal offers the switch. (Subscribers on an old price still pay it until they switch.)
- **/app/billing and the portal return:** the portal returns to `/app/billing?from=portal` (and a checkout started from
  that page to `?from=checkout`); that visit reads the plan fresh, bypassing the one-minute cache, and drops the marker
  from the address. A buyer on an older (legacy) plan sees it with one line: cancel it in Manage billing, then choose a
  new plan here (the portal offers only v2 prices, so a legacy plan cannot be switched there). If Stripe cannot answer in
  3 seconds the page shows balance and history at once, says "We couldn't load your plan just now." and its plan buttons
  read "Manage billing" instead of "Choose plan" (the checkout's 409 still guards a second plan).
- **Owner checks and decisions (Stripe account level, not code):**
  - Stripe Checkout and the portal pages show the Stripe ACCOUNT's name ("Prime Hub" in test), not "Ariya Lab". That can
    only be changed in Stripe account settings (public business name) or by using a separate Stripe account for Ariya
    Lab. Owner decision; check it before going live.
  - Plan credits stay spendable after a subscription ends (cancelled or expired): this task changes nothing there.
    Owner decision; behaviour as before.
- How subscription invoices are credited (`lib/grants.js grantForInvoice`; first, renewal and plan-change invoices,
  read line by line):
  - A **period line** (not a proration) gives the plan's allotment for the plan that line paid for: a monthly plan its
    monthly credits at once (`invoice:<id>`, rollover rule); a yearly plan starts a yearly period worth 12 months of
    credits, released month by month (month 0 at once, then `/api/cron/grant-yearly`, `yearly:<subscription>:<YYYY-MM>`).
    Coupons do not change the allotment.
  - A **plan change is credited by money.** Each proration line is worth its amount at its own price's rate (the
    price's credits for one period / the price's amount; a yearly price's period is 12 months): a charge
    `floor(amount x rate)`, unused time given back `-ceil(|amount| x rate)`. Proration by time is Stripe's; the code
    never measures time for a change.
    - Monthly lines are netted per invoice: a positive net is granted at once (`upgrade:<invoice>`), a negative net is
      clawed back at once (`downgrade:<invoice>`, reason `plan_change`).
    - Yearly lines add to or take from the **entitlement** of the yearly period they name (its line's period end). A
      period never gives more than its entitlement: anything above it is clawed back at once
      (`period:<sub>:<end>:claw:<n>`). The cron gives each month the plan's monthly level, or less when the money left
      is short (spread over the months left), and keeps the monthly level in reserve for each month still to come;
      what those months can never release (a paid yearly upgrade's step for the current month) is granted with the
      invoice (`period:<sub>:<end>:up:<invoice>`). By the last month the whole entitlement is out.
    - A yearly period the subscription leaves (unused time credited with nothing new charged on it) ends there: no
      later month, and what it gave above the money kept is clawed back.
    - Delivery order does not matter. Stripe does not promise to deliver invoices in order (a retry, a 500, flips
      seconds apart). Unused time given back on a yearly period is recorded against that period even when the
      invoice that starts the period has not been processed yet. When that invoice comes, the period counts every
      line recorded for it, is ended at once if the switch away came first, and gives what it would have given in
      order.
  - It does not matter whether the invoice is paid by card, from the customer balance, or not at all (a negative
    total): money given back to the balance was clawed back when it was given, and the balance then pays later
    invoices like money. So upgrades, downgrades, interval switches and loops of them all come to "credits = money kept
    x rate", within a credit per line (rounding always favours the business). Prorations left for the next renewal
    invoice (`create_prorations`) are credited on that invoice the same way.
  - Within one invoice, clawbacks are applied before grants. A grant's rollover cap is the largest monthly level
    among the invoice's plans, so a switch to a smaller plan never expires credits that are about to be clawed, or the
    old plan's credits for the time just used. The rollover rule applies again at the next renewal. A customer who
    did not spend never ends a plan change owing anything. A plan change's clawback (reason `plan_change`) takes what
    is available; what it cannot take because the credits were already spent is **owed** (`plan_debt` on the
    account) and taken from the next plan grants (renewal, upgrade, yearly month; ledger reason `plan_debt`, ref
    `<grant ref>:debt`), since the money for that time went back to the customer's balance and pays those grants. So
    spending every credit before a downgrade never farms: what was delivered beyond the money kept is exactly what is
    still owed, and it does not grow from one plan change to the next. A customer who cancels while owing keeps that
    one change's spent credits (their unused balance stays in Stripe).
  - Only a plan-change invoice's own unused-time lines can create debt, and only up to what they took off the
    period's money. Refund and dispute clawbacks never create debt (as before: credits spent before a refund are not
    taken back). Neither does the cron when it brings a period down to its money (reason `plan_adjustment`; for
    example, a refund whose own settlement failed and that the cron finished first). The database refuses debt for
    any other reason (`credit_plan_clawback` raises `plan_debt_reason`). One consequence: if a plan-change invoice
    dies after recording its lines and the cron settles the period before Stripe retries the invoice, that change's
    clawback is booked without debt.
  - A line in another currency than its price (currency options, adaptive pricing) is skipped and logged: v2 prices
    are USD only.
- Refunds and disputes take back, of each invoice, the share of money returned (refunded plus disputed, over what the
  invoice cost): the same share of a monthly renewal grant and of a plan change's net grant (cumulative per grant), and
  of the invoice's part of each yearly period's entitlement, then the period gives back anything above the lowered
  entitlement at once (the month's step a yearly upgrade granted with its invoice loses its share at once too). The
  clawback is worked out from what was already given and taken, never from a marker written first, so a retry after a
  failure finishes the job. A partial refund of a yearly invoice takes nothing yet when what was given is still under
  the money kept; the later months are smaller (spread) and the year gives exactly the money kept. A full refund or
  dispute of the invoice that started a yearly period stops it. Refunding a plan change does not change the
  subscription in Stripe: when you refund an upgrade by hand, also move the subscription back (without proration), or
  Stripe will later credit unused time of a plan that was never paid for.
- Verify on the first test-mode plan changes (upgrade, downgrade, monthly to yearly and back) that the invoice lines
  carry `proration`, the price, `amount` and `period` (the code reads the 2024-06-20 shape and the newer `parent` /
  `pricing` shape), and that the interval change bills the new period as a full line.
- Several yearly months that come due at once (the cron was down for over a month, or the customer linked their
  account late) are granted one after the other, and the plan rollover rule (at most one month carried over) caps
  the total. Keep the cron running; grant the difference by hand from /admin if it happens.

## 5. Kie webhook secret

Set `KIE_WEBHOOK_SECRET` on Vercel to a random string (it signs the callback URL we send; kie.ai never needs it). To
also check kie's own signature, copy the webhook HMAC key from the kie.ai dashboard into `KIE_WEBHOOK_HMAC_KEY`. Then
confirm one webhook arrives and is accepted (the runner also polls, so a missing webhook only slows things down).

## 6. Deploy

Only after steps 1-5 (every migration applied, Stripe webhook configured, portal checked in test mode, kie secret set). billing v2 stays
off. Then check on the deployed app:

- In the function bundles, ffmpeg is traced into the story worker, analyze, assets and render routes, and `sharp` only
  where it is used.
- On a Vercel (linux) function: `ffmpeg -filters | grep ass` lists the `ass` filter; render one frame with captions.
- Vercel keeps a worker running after its caller aborts, and large renders upload to Blob with multipart: confirm both
  on the first long render.
- Each cron answers 200 when called with `Authorization: Bearer $CRON_SECRET` (and 401 without).
- Each worker route (`/api/story/worker/audio`, `/api/story/worker/analyze`, `/api/story/worker/draft`,
  `/api/story/render-worker`) answers 200 to a POST with `Authorization: Bearer $CRON_SECRET` and no cookie (and 401
  without the bearer). A non-2xx kick is logged as `[story] worker kick <path> answered <status>`.

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
- Paid transcription runs on each render. A cap is built (10 renders per project in any 24 hours, pricing_config
  `free_limits.rendersPerProjectPer24h`); decide whether renders should also be charged.
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
- Reference pictures with a first frame (read from kie.ai 2026-11-17, not tested live): Seedance 2 Mini says `reference_image_urls` (up to 9) "cannot be combined with first_frame_url" and the modes are mutually exclusive; Gemini Omni says `first_frame_url` cannot be combined with `image_urls` (up to 6). So Seedance and Omni clips send the still as the first frame only, with no reference pictures (the still already carries the characters). Revisit if kie lifts this; only Kling takes character elements. No warning is shown for it.
- Gemini Omni request shape and Seedance/Omni sound checked against the live API (field names read from kie.ai 2026-11-17: `first_frame_url`, `image_urls`, `duration` as a number, `resolution`, `aspect_ratio`; no audio field is sent, sound is assumed on; Seedance `generate_audio: true`).
- Check hosted pricing_config rows for saved perSecond rates from before 2026-11-17; an old row overrides the new defaults and breaks the 70% rule.
- Kling element-name format (accents are dropped from names) and the real kie/Kling refusal strings.
- Meta Ad Library live check.
- The real Claude connector: add `APP_URL/api/mcp` in claude.ai and in Claude Code and run one tool.
- Google sign-in on `/sign-in`, `/sign-up` and the OAuth consent sign-in.

## 10. Hardening list (known, not blocking)

- `pages/api/upload-token.js` signed-in limits allow image/* and video/* up to 1 GB on any allowed path (the server
  re-checks on registration).
- Audio handlers: the own-recording download timeout (10 min) exceeds the worker window.
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
