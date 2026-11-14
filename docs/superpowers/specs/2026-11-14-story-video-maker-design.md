# Ariya Lab redesign: animated story video maker

**Date:** 2026-11-14
**Status:** Draft, waiting for Ibrahim's approval
**Branch:** `redesign/story-video-maker`

Lines marked **(call)** are choices Claude made that Ibrahim has not explicitly agreed to. Everything else is what he asked for.

---

## 1. Intent and why

Ibrahim makes animated story ads by hand with Claude (the "Watch" and "So I got serious" barber reels). People keep asking him how to make them. He wants to sell that process as a product:

- A customer talks to a chat, says what they want, and gets a finished animated story video.
- The customer can be promoting anything: a physical product, an app or SaaS, coaching, a course, a local service, a personal brand, or nothing (just a story).
- It is sold as a monthly subscription with credits, plus credit top-ups, promoted with Meta ads.
- It must be cost-effective for him (target 40 to 50% gross margin on credits) and understandable for the customer (they see the price before spending).

The existing Ariya Lab app (this repo) is redesigned into this product. It already has login, Stripe billing, kie.ai video generation and Vercel hosting.

## 2. Goals

1. One guided flow that takes a customer from an idea, or a reference video, to a finished captioned video with voice and music.
2. Output quality at the level of the barber reels when the customer picks the top quality level.
3. The customer picks a quality level per video (and per shot) and always sees the credit cost first.
4. Credits priced so every plan and top-up keeps 40 to 50% margin at full usage, with the rates changeable without a deploy.
5. A new homepage and dashboard in the style of the Uvera reference video (section 9).
6. The same backend reachable from the website and from an MCP connector.
7. Only self-serve providers: sign up, add a card, use in production the same day.

## 3. Non-goals

- Realistic UGC talking-head videos as a new feature. The old tools stay as they are (section 12).
- A timeline editor. Customers change things by editing the script, re-rolling shots and chatting.
- Team accounts, an affiliate system, a mobile app.
- Listing in Claude's public connector directory. Its policy bans AI video generators, so the connector is installed by link.
- YouTube links at launch. No reliable self-serve way to fetch the file was found. Upload covers it.

## 4. Anti-goals (would make this a failure even if it works)

- A customer can spend Ibrahim's money without paying. The current code has several such holes (section 11).
- Margin goes negative for heavy users or when a provider raises prices.
- Videos with pauses, robotic voices, characters that change between shots, or captions outside the safe band. These are the things Ibrahim rejected in his own ads.
- The product copies a reference video's actual footage, audio, script lines or characters. It reuses structure only.
- The word "Pixar", "Disney", or any studio, character or celebrity name appears in the UI, presets, prompts or ads.
- Serving customers from a consumer subscription (Higgsfield plan credits or the Higgsfield connector). Only pay-as-you-go APIs.

## 5. Constraints

- Stack stays Next.js 14 pages router on Vercel, Supabase, Stripe, kie.ai. JavaScript, CSS Modules.
- Stripe and Supabase are shared with a second site, haelabs.live (`lib/metaKeys.js`). Nothing in this work may change shared metadata keys, shared tables or shared Stripe products in a way that breaks that site. New tables get a `story_` prefix. **(call)**
- Kling 3.0 on kie.ai: 3 to 15 seconds per clip, up to 3 character elements with 2 to 4 reference images each, native audio optional, results deleted after 14 days, 20 new requests per 10 seconds.
- Vercel functions time out at 300 seconds, so the pipeline needs a durable job runner.
- kie.ai has no uptime guarantee and jobs can stick. Design for failure, not for the happy path.

## 6. Approaches considered

| | A. Story maker first | B. Reel remaker first | C. Sell by hand first |
|---|---|---|---|
| Launches with | Describe a story, get a video | Paste or upload a reel, get your version | Landing page; videos made by hand |
| For | Builds the shared 80% first; least legal exposure in ads | Strongest hook; nobody does it well | Proves demand before building |
| Against | The remake hook arrives second | Scraping and "remake" pitch carry the most risk | Does not scale; not the product |

**Picked: A, expanded.** Ibrahim chose A and then asked for the remake path, audio upload, voice cloning, screen recordings, brand assets and the MCP connector to be in scope together. So this document covers all of it, built in the stage order of section 13. The describe-a-story path is finished first because every other feature feeds into the same cast, storyboard, shot and render steps.

## 7. What the customer can do

### 7.1 Account

- Sign up, log in, subscribe, buy top-ups (existing Supabase auth and Stripe Checkout).
- See the credit balance on every screen.
- See a history of what each credit was spent on.

### 7.2 Dashboard

- Projects as cards: thumbnail, title, status (draft, generating, finished, failed), length, date.
- New video, reopen, duplicate, download, delete.
- A brand kit page (7.4).

### 7.3 Making a video

One page: chat on the left, the project on the right. The steps are a visible stepper so the customer always knows where they are. They can go back to any earlier step; going back marks later steps as out of date rather than deleting them.

1. **Start.** Two doors:
   - *Describe it.* A text box.
   - *Start from a video.* Upload a file, or paste an Instagram, TikTok, Facebook or Meta Ad Library link.
2. **What is this video for?** Physical product, app or SaaS, coaching or course, local service, personal brand, or just a story. One or two sentences about the offer and the audience. Optional: attach brand assets (7.4).
3. **Style.** Presets with a sample image each: 3D animated family film, 2D cartoon, anime, clay, comic book, flat motion graphic, watercolor storybook. Free-text style also allowed. **(call: this starter list)**
4. **Length and quality.** Target length (15, 30, 45, 60 seconds; up to 75). Quality level (section 8). Aspect 9:16 by default, 1:1 and 16:9 available. The estimated credit cost updates as they change these.
5. **Breakdown** (only when they started from a video). A plain beat sheet of the reference: each shot's time, what happens, what is said, why it works. Read-only.
6. **Script.** A scene list. Each scene has narration or dialogue lines and a one-line description of what is seen. The customer edits text directly or asks the chat ("make the opening funnier", "the girlfriend should say the booking line"). Script rules are in 7.5.
7. **Cast.** For each character the script needs, three generated options. The customer picks one, or describes a change and regenerates, or uploads their own reference image (for example a mascot). Each picked character gets a cast sheet: front, three-quarter, face close-up.
8. **Storyboard.** One still per shot, in order, with the line under it. Per shot: re-roll, edit the description, change quality level, mark it as "my footage" and attach a screen recording or clip instead of generating. This step is cheap, and nothing expensive runs until it is approved.
9. **Voice and sound.**
   - Narrated videos: pick a stock narrator voice, or use a cloned voice (7.6), or upload a finished voice track.
   - Talking videos: characters speak with the video model's own voices.
   - Music: generated from a mood description (the reference's mood is suggested when there is one), or uploaded, or none.
   - Captions: on or off, three caption styles. Default is the premium serif with the spoken word in the accent colour, placed lower-middle inside the safe band (y 285 to 1635 on 1080x1920).
10. **Generate.** "Generate all" or shot by shot. The exact credit cost is shown and must be confirmed. Progress is per shot. The customer can close the tab and come back.
11. **Review.** Play each shot. Re-roll any shot (20% of the project's shots are free, then normal price). Regenerate narration after a script edit.
12. **Finish.** The server assembles the final video: clips joined on the cut list, the customer's own footage placed where they marked it, narration, music ducked under the voice, captions burned in, loudness set to -14 LUFS. Preview, download MP4, and re-render after changes without paying for shots again.

### 7.4 Brand kit and references

Saved per account, reusable across projects, and attachable per project:

- Logo, brand colours, product photos, a mascot or spokesperson image.
- Screen recordings and other video clips of the app or product.
- A short description of the offer, audience and tone.
- Words or claims to avoid.

Product photos and mascot images can be used as reference images when stills are generated, so the real product appears in scenes. Screen recordings are placed as whole shots or as an inset inside a generated shot (for example on a phone the character is holding). **(call: inset is a framed overlay added in the edit, not generated into the clip)**

### 7.5 Script rules built into the writer

Taken from what worked on the barber reels:

- Hook in the first two seconds that names the audience or the doubt.
- One natural mention of the offer per video, said by the character who would really say it, at a beat that already fits. No feature lists. The story must still work if the mention is removed.
- No guarantees of results, no "free" on its own, plain spoken language, no dashes in lines.
- A call to action is optional and off by default for story videos. **(call)**
- When adapting a reference: keep the beat structure and pacing, write new lines, new characters, new setting.

### 7.6 Voice cloning

- The customer uploads or records 10 to 60 seconds of a voice and ticks a statement that it is their voice or they have permission.
- The clone is saved to their account and can narrate any project.
- The whole narration is generated in one pass and then sliced at silences, because separate sentence generations drift in pitch.

### 7.7 MCP connector

A remote MCP server at `/api/mcp` on the same deployment, installed in Claude by pasting its URL (custom connector). The customer signs in with their Ariya Lab account through OAuth. It spends the same credits.

The OAuth layer is built inside this app (authorization code with PKCE and dynamic client registration; the consent page reuses the existing Supabase login session; tokens stored hashed in `story_oauth_*` tables). Supabase's own OAuth server is not switched on, because the Supabase project is shared with haelabs.live. **(call)**

Tools mirror the web steps: create project, analyze reference, get or set script, generate cast, pick cast, generate storyboard, get cost quote, generate shots, get job status, render, get result. Long jobs return a job id that Claude polls. Any step that spends credits returns a quote first and needs a confirm call. **(call: tool list and confirm-before-spend)**

## 8. Quality levels and credits

Prices and the plan table will be tuned later (Ibrahim's instruction). The mechanism is fixed now; the numbers below are the starting values and live in a database table so they can change without a deploy.

| Level | Model on kie.ai | Provider cost per generated second |
|---|---|---|
| Standard | Kling 3.0 standard 720p, silent | $0.0755 |
| Pro narrated | Kling 3.0 pro 1080p, silent | $0.101 |
| Pro talking | Kling 3.0 pro 1080p, native audio | $0.151 |
| Economy (hidden until tested) | Seedance 2.0 Mini 720p | $0.041 |

- Credits are charged on **generated** seconds, never finished seconds, because Kling bills a 3 second minimum per shot.
- Starting rates: Standard 11 credits per second, Pro narrated 14, Pro talking 21, Economy 8. Project fee 90 credits (analysis, script, cast, voice, music, render). Still re-roll 2. Shot re-roll at the shot's rate after the free 20%.
- Starting plans: $29 = 1,500 credits, $49 = 2,600, $99 = 5,400. Top-ups $15 = 700, $40 = 1,900, $100 = 5,000. At these values a credit costs about $0.0092 to deliver and margins are 46 to 53% after an assumed Stripe fee of 2.9% + $0.30.
- Plan credits roll over for one month, then expire. Top-up credits do not expire. **(call)**
- Yearly plans exist at 20% off the monthly price. Their credits are granted monthly by a scheduled job (Stripe sends no monthly invoice for a yearly plan), with the same one-month rollover. **(call)**
- A free account can go as far as the script (and the breakdown). Cast, stills and video need a paid plan. **(call)**

**Limits on the cheap steps (all calls, all in `pricing_config`):**

- Free accounts: 1 reference analysis and 3 projects per day, 30 chat messages per project, verified email required. Reference files capped at 100 MB and 3 minutes.
- The 90-credit project fee is taken when the first cast is generated, which is the first step that costs real money. It is not refunded if the project is abandoned.
- Included per project: 2 cast regenerations per character, 3 narration generations, 3 music generations, 150 chat messages. Past that: cast regeneration 5 credits, narration 5, music 5, and chat stops with a message asking the customer to continue by editing directly.
- Voice clone creation: 20 credits each.

## 9. Look and feel

Reference: the Uvera landing page recording Ibrahim supplied (`~/Downloads/d7290c88d4753c25943378b507dc0d47.mp4`, 30 seconds). Frames from it, in order, are saved in `docs/superpowers/specs/assets/uvera-reference/sheet_0.jpg` to `sheet_4.jpg`. Match the style and section order with Ariya Lab's own name, logo and words.

- **Theme:** light. Warm cream background (about `#FDFBF5`), one orange accent (about `#F08A4B`), near-black text, soft white cards with light shadows. Replaces the dark "Obsidian & Platinum" theme across the app.
- **Type:** a clean geometric sans for everything; one word per headline in the accent colour and italic.
- **Shapes:** pill buttons with a small arrow, 16 to 24px card radius, a floating rounded nav bar that stays on top while scrolling.
- **Motion:** sections fade and rise in on scroll; a soft blurred glow behind the hero; the hero video row slides continuously.

**Homepage sections, in order:**

1. Nav: logo, Home, How it works, Pricing, FAQ, Login, "Get Started".
2. Hero: small live counter line, two-line headline, one-line subhead, two buttons, a sliding row of vertical video cards (centre one larger) showing animated story clips across different business types.
3. How it works: three cards joined by arrows ("Describe it", "Pick your cast", "Get your video").
4. Pricing: monthly/yearly toggle, three cards, the middle one dark and marked most popular, a row of small reassurance ticks under them.
5. FAQ accordion.
6. Closing call to action in a soft gradient card.
7. Footer: logo, blurb, three link columns, social icons.

The reference showed no dashboard, so the dashboard and the maker page are designed in the same theme **(call)**: left sidebar (Projects, Brand kit, Voices, Billing, More tools), credit balance top right, project cards in a grid.

Example clips for the hero come from Ibrahim's own finished story videos until customer examples exist. **(call)**

## 10. How it is built

### 10.1 Providers (all self-serve)

| Step | Provider | Notes |
|---|---|---|
| Video clips | kie.ai Kling 3.0 | Already integrated in `lib/kie.js`; add callbacks, character elements, std/pro modes |
| Stills and cast sheets | kie.ai Nano Banana (latest) | About $0.02 per image; a call already exists inline in `pages/api/glow-up.js` |
| Reference download | ScrapeCreators | About $0.002 per fetch; Instagram, TikTok, Facebook, Ad Library |
| Cut detection | ffmpeg scene detect | Already bundled |
| Transcript with word times | Groq Whisper | About $0.04 per audio hour |
| Analysis | Claude Haiku (latest) on sampled frames | Anthropic key already in the repo |
| Script, shot prompts, chat | Claude Sonnet (latest) | Budget $0.50 per project |
| Narration and voice clone | Fish Audio | Terms for use inside a paid product must be read before launch |
| Music | Google Lyria | About $0.08 per track; terms to be read before launch |
| Storage | Cloudflare R2 | Every generated file is copied here on completion |
| Failover for video | Higgsfield pay-as-you-go API | Optional, added last |

Every provider sits behind a small interface (`generateClip`, `generateImage`, `synthesizeVoice`, and so on) so one can be swapped without touching the pipeline. Model ids and prices are read from config.

ElevenLabs and Suno are deliberately not used: ElevenLabs requires its $299 plan and a registered company to embed in a product, and Suno's API is invite-only.

### 10.2 Data (new Supabase tables, `story_` prefix)

- `story_projects`: owner, title, purpose, offer text, style, target length, aspect, default quality, status, current step.
- `story_references`: project, source type (upload or link), file, cut list, transcript, beat sheet.
- `story_scripts`: project, version, scenes (JSON).
- `story_cast`: project, character name, description, chosen image, cast sheet images, candidate images.
- `story_shots`: project, order, scene, description, line, duration, quality, source (generated or customer footage), still, clip, status, attempt count.
- `story_assets`: owner, kind (logo, product photo, screen recording, audio, voice sample), file, metadata. The brand kit.
- `story_voices`: owner, provider voice id, name, consent record (time, IP, statement text).
- `story_jobs`: project, shot, kind, provider, provider task id, status, cost, timestamps.
- `story_renders`: project, version, file, settings.
- `credit_ledger`: owner, amount (+/-), reason, project, shot, job, balance after, created. Append-only.
- `credit_holds`: owner, project, amount, status.
- `pricing_config`: action, quality, credits. Editable from the admin page.
- `stripe_events`: event id (unique). For webhook dedupe.

Row-level security: a user reads and writes only their own rows; credit and job tables are written only by the server.

### 10.3 Credits

- The balance is the sum of the ledger, changed only inside a Postgres function that locks the user's row, so two requests cannot spend the same credits.
- Starting a paid step places a hold for its quoted cost. Each finished shot settles its part. A failed, stuck or blocked shot releases its part automatically.
- Stripe remains the source of truth for subscription status only. Balances move out of Stripe customer metadata.
- Existing balances are migrated once into the ledger (section 12).

### 10.4 Job runner

- A durable workflow per project step **(call: Vercel Workflow if it runs on the pages router; otherwise Inngest. The builder tests this first.)**
- Shots are submitted to kie.ai with a callback URL; a signed webhook marks them done and copies the file to R2.
- A sweeper runs every few minutes: any shot waiting more than 10 minutes is cancelled, its hold released, and it is resubmitted once.
- A global throttle keeps submissions under kie.ai's limit.
- The browser reads status from the database (polling every few seconds), so closing the tab loses nothing.

### 10.5 Analysis of a reference video

1. Download (upload or ScrapeCreators) into temporary storage.
2. ffmpeg scene detection gives the cut list; cuts closer than 0.3 seconds are merged.
3. Audio goes to Whisper for words with times.
4. Two or three frames per shot, downscaled, plus the transcript go to Claude, which returns the beat sheet as structured data.
5. Music mood is described from the audio's tempo and loudness curve. **(call: best effort; skipped if it adds a dependency)**
6. The source file and its audio are deleted after analysis. Only the beat sheet is kept.

The customer ticks a statement that they have the right to use the reference for inspiration. A DMCA contact is listed in the footer.

### 10.6 Consistent characters

- Cast sheets are generated once per character and stored.
- Each shot's still is generated with the cast sheets of the characters in that shot, the style preset, and any product photo as reference images.
- The clip is generated image-to-video from that still, also passing the characters as Kling elements.
- Voice wording for a character is identical in every prompt, with no emotion words, because Kling has no voice reference.

### 10.7 Final render

- ffmpeg on a Vercel function with the concat demuxer, so there is no 5-clip or 60-second cap. **(call: ffmpeg rather than Remotion, to reuse what is deployed; revisit if caption quality falls short)**
- Captions: word times from Whisper on the final narration, corrected by spreading words across each speech stretch by syllable count; each word on screen at least 0.42 seconds; a caption never crosses a cut. Rendered as ASS subtitles if the bundled ffmpeg supports them, otherwise as pre-rendered images.
- Customer footage is trimmed to its shot length and scaled to fit; insets are overlaid with a rounded frame.
- Music: start a few seconds in to skip soft intros, reduce sub bass, duck under voice, final loudness -14 LUFS.
- Automatic checks before the customer sees it: every script word present in the transcript of the final audio, no silence longer than 0.6 seconds, loudness in range. A failed check triggers one automatic fix attempt and is otherwise shown as a warning.

### 10.8 Chat

The chat is Claude with tools that read and change the project (edit a scene, regenerate a character, change a shot description, quote a cost). It cannot spend credits without the customer pressing a confirm button. Prompt moderation (the existing `lib/moderation.js`, fixed) runs on all customer text and uploaded images, and fails closed.

### 10.9 Page structure

- `/` new homepage. `/pricing` anchors into it.
- `/app` dashboard. `/app/new` and `/app/p/[id]` the maker. `/app/brand`, `/app/voices`, `/app/billing`.
- `/api/story/*` for the web app, `/api/mcp` for the connector, `/api/webhooks/kie` for callbacks.
- Shared components replace the six near-copy creator pages for anything new.

### 10.10 File retention (added 2026-11-14 at Ibrahim's request)

To keep storage cost down, generated and uploaded project media is deleted automatically 30 days after it was created: reference uploads, stills, cast images, clips, narration and music tracks, and finished renders. A daily job removes the files and marks the project "expired"; the script, shot list and settings stay, so the customer can regenerate (at normal credit cost) but not re-download. The finish screen and each project card show the date the files will be removed, and the customer is told to download before then. Brand kit uploads (logo, product photos, recordings) and cloned voices are kept while the account exists. The retention period is one config value (`retentionDays`, default 30).

## 11. Fixes required before any advertising

Found in the audit of the current code and confirmed by a second read:

1. `/api/swap` starts paid Replicate jobs with no credit check.
2. `/api/upload-token` and `/api/moderate-image` spend money with no login.
3. Credit deduction is read-then-write on Stripe metadata, so parallel requests double-spend.
4. Top-ups can be granted twice (webhook and `/confirm` race) and replayed after 11 checkouts; webhook events are not deduplicated; handler errors return 200.
5. A checkout session id works as a bearer token in `/api/checkout/confirm` and `/api/checkout/claim-ticket`.
6. `profiles.stripe_customer_id` is probably writable by the user; check the policy in Supabase.
7. `/api/status` has no ownership check.
8. Overlay `color` is spliced unvalidated into the ffmpeg filter string.
9. The moderation blocklist alternates block and pass on the same input (a `/g` regex reused with `.test()`), and the AI layers fail open.
10. Refunds and disputes are not handled; credits are not clawed back.

Items 3 and 4 are solved by the ledger. The rest are direct fixes.

## 12. Existing product and customers

- **Old tools** (Image to Video, Face Swap, UGC Creator, Glow Up, Interior Design, Video Editor): kept working, restyled to the new theme, moved under "More tools" in the dashboard. They get the security fixes and charge through the new ledger. No new features. **(call)**
- **Old funnels** (`/ugc-2`, `/ugc-3`, `/local-business`, `/real-estate` and their pricing pages): left live and untouched until Ibrahim turns their ads off, then removed. **(call)**
- **One video-credit currency.** The ledger holds new credits only. Old video credits are converted once at a fixed rate that preserves what they could buy: an old credit bought 1/100 of a second of Kling 1080p with audio, a new credit buys 1/21, so 100 old credits become 21 new credits. **(call)**
- **Old plans and packs:** stop being sold when the new plans go live. Until that moment the old billing code runs unchanged and the ledger is not live. At go-live the old funnels' checkout buttons point at the new plans. Existing subscribers keep their old price; each renewal grants the converted amount of new credits. **(call; needs Ibrahim's decision, see section 15)**
- **Image credits** (Glow Up and Interior Design, sold as $5/$15/$30 packs): kept as a second currency in the same ledger table (`currency` column: `video` or `image`), not merged. Image packs stay on sale for those two tools only. **(call)**
- **haelabs.live:** untouched.

## 13. Build order

Stages, each ending in something that can be checked. Time is build time with AI, not calendar time.

1. **Safety and ledger** (about 1 to 2 hours): section 11 fixes, credit ledger, holds, webhook dedupe, pricing config, balance migration script (not run until approved).
2. **Theme, homepage, dashboard shell** (1 to 2 hours): new design tokens, nav, homepage sections, dashboard and empty maker page.
3. **Story path** (3 to 5 hours): data tables, job runner, script writer, style presets, cast, storyboard, shot generation, review.
4. **Finish** (1 to 2 hours): narration, music, captions, render, automatic checks.
5. **References** (1 to 2 hours): upload and link ingestion, analysis, breakdown, adapted script.
6. **Brand kit, own footage, audio upload, voice cloning** (1 to 2 hours).
7. **MCP connector** (2 to 3 hours, including the OAuth layer).
8. **New plans live, quality test, failover** (1 to 2 hours plus test spend).

A quality test of about $50 (Standard against Pro, and Economy) runs at the end of stage 3, before plan prices are finalised.

## 13a. Quality bar

The yardsticks are two of Ibrahim's finished videos in `~/Desktop/Ecom/Other/Prime Barber IOS App/`: `13-got-serious-fast-cut-story` for Pro narrated and `12-watch-animated-story` (v3, with subtitles) for Pro talking. At the end of stage 4 the builder makes one video of each kind through the product, with no hand fixes, and Ibrahim judges them side by side with the originals. He is the only judge. If captions or cuts fall short, the fallback is to move the final render to Remotion (the barber reels' renderer; project at `~/Duplicate UGC/remotion-voiceagent`) before stage 5 starts. **(call)**

## 14. Left to the builder

- Exact component breakdown, file names and CSS.
- Vercel Workflow or Inngest, decided by a quick compatibility test.
- ASS captions or pre-rendered caption images, decided by what the bundled ffmpeg supports.
- The prompts for analysis, script writing, cast and shots (start from the barber-reel method in `~/Duplicate UGC/CHAT-HANDOFF-2026-11-14.md`, section 3 and 4).
- Sampling rate of frames for analysis and the exact merge threshold for cuts.
- MCP tool names and schemas within the list in 7.7.
- Test coverage: at minimum the ledger functions, hold and settle logic, webhook dedupe, and pricing arithmetic.

## 15. Needs Ibrahim before or during the build

1. Accounts and API keys: ScrapeCreators, Groq, Fish Audio, Google AI Studio (Lyria), Cloudflare R2. Later: Higgsfield API.
2. kie.ai balance for testing (about $50).
3. Product name and logo: keep "Ariya Lab" or rename.
4. Confirm the plan for old plans, old funnels and existing subscribers (section 12).
5. Judge the two test videos at the end of stage 4 (section 13a).
6. Read and accept the Fish Audio and Lyria terms for use inside a paid product, or pick alternatives.

## 16. Risks

| Risk | Mitigation |
|---|---|
| kie.ai outage, stuck jobs, or price rise | Provider interface, sweeper with auto-release, prices in config, Higgsfield failover, copy files to R2 |
| Re-rolls eat the margin | Storyboard approval before video, metered re-rolls, holds per project |
| Copyright or platform complaint about remakes | Structure only, source deleted after analysis, rights statement, DMCA contact, upload offered first, no studio or character names |
| Voice cloning misuse | Consent statement recorded, clone private to the account |
| Quality below the barber reels | Automatic checks, per-shot re-roll, Pro levels use the same model and settings; hand polish is not replicated in the first version |
| Trial abuse from ad traffic | Free tier stops at the script; no free images or video |
| Breaking haelabs.live | New prefixed tables, no change to shared keys or products |
