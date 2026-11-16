# Ariya Lab

Ariya Lab is an animated story video maker. You describe a product, an offer or an idea, and it turns that into a short animated video with a script, a cast of characters, a storyboard, generated clips, narration, music and captions.

Built with Next.js 14 (pages router), Supabase (auth and the database), Stripe (plans and top-ups) and Vercel (hosting, Blob storage, cron).

## The maker

Customers start at `/app` and make a video in the maker at `/app/p/[id]`. Each step saves to the project, so they can leave and come back.

1. **Chat**: talk through the idea; the assistant turns it into a brief.
2. **Brief**: purpose, offer, audience and tone. The brand kit (`/app/brand`) fills these in by default. A reference video (an Instagram, TikTok or Facebook link, or an upload) can be analysed so the story follows its structure.
3. **Style**: the look of the animation.
4. **Length**: how many seconds, and narrated or with characters speaking.
5. **Script**: written by Claude, scene by scene. It can be revised with an instruction or edited by hand.
6. **Cast**: one character per role, with picture options to pick from (or the customer's own picture).
7. **Storyboard**: the shot list and a still for each shot.
8. **Generate**: the clips, at the quoted price.
9. **Voice, music and captions**: a preset or cloned voice (or the customer's own recording), made-for-you or uploaded music, caption style.
10. **Video**: everything put together into the final mp4, ready to download.

Slow work runs in the background as jobs (`lib/story/runner.js`): a cron tick every minute and worker routes for narration, music, reference analysis, drafting and the render.

The older single-purpose tools (face swap, image to video and others) are still available from `/app/tools`.

## Credits and plans

Everything is paid in credits. A video costs a one-time project fee (charged when the cast is started) plus the clips, priced per second by quality. The price is always shown first, and the customer confirms the exact number before anything is charged; credits are held while work runs and settled when it finishes. The first still of each shot, the first few narration and music makes and the render are included.

Plans (Starter, Creator, Studio; monthly or yearly) grant credits each period, and top-up packs add more. Plan data is in `lib/pricingConstants.js`; prices can be changed at runtime from the admin page, which writes the `pricing_config` table.

## Use it from Claude

The app is also an MCP server, so customers can make videos by talking to Claude, on their own account and credits. Setup for customers is in [docs/connector.md](docs/connector.md). The connector URL is `APP_URL` + `/api/mcp`.

## Setup

```bash
npm install
cp .env.example .env.local   # then fill in the values
npm run dev                  # http://localhost:3000
```

Every variable is described in `.env.example`. The ones the maker needs:

- `APP_URL` (required): the one public URL of the app. Stripe return URLs, the OAuth consent check and the Claude connector all use it.
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` (server only).
- `CRON_SECRET`: shared by the cron and the worker routes.
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`.
- `ANTHROPIC_API_KEY`, `KIE_API_KEY`, `KIE_WEBHOOK_SECRET`, `GROQ_API_KEY`, `APIFY_TOKEN`, `FISH_API_KEY`, `GOOGLE_AI_API_KEY`, and `REPLICATE_API_TOKEN` for the older tools.
- `BLOB_READ_WRITE_TOKEN` (or all five `R2_*` values for Cloudflare R2).

Set `STORY_MOCK=1` to run the whole maker with local fixtures and no provider calls (no credits spent at any provider). Database changes are in `supabase/migrations`.

## Tests

```bash
npm test
```

Vitest, with an in-memory Postgres (PGlite) that runs the real migrations and every provider in mock mode. Nothing reaches a real provider, Stripe or Supabase. `tests/e2e/mockPipeline.test.js` drives a whole video through the routes, from the brief to the finished render. Each run uses its own temp folder for mock storage and fixtures and removes it at the end.

## Going live

The launch order (provider accounts, migrations, Stripe, deploy, prices, smoke tests) and the runbook are in [docs/go-live.md](docs/go-live.md).
