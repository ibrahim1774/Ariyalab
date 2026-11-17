-- Render charge (owner decision 2026-11-16). Applies after 20261116000500_story_cleanup.sql.
-- Additive: two nullable columns on story_renders; no function, policy or shared table changes.
--
-- The first finished render of a project is free (pricing included.render); every start after that holds
-- pricing renderRegen credits (lib/story/render.js startRender) and the render job settles it when the video is
-- stored, or the runner releases it when the render fails. The row keeps what the start held:
--   hold_id       the credit hold of this render (null for an included one). No foreign key: the id is written
--                 before the hold exists, so a request killed in between leaves a pointer recoverStalledRender
--                 can still end (a release of an unknown hold is a no-op).
--   cost_credits  what the start priced it at (0 = included).
-- story_release_orphan_hold (20261116000500) already ends a render hold nothing points at any more; the sweeper
-- runs recoverStalledRender first, which fails a dead start's row and releases its hold.
--
-- Not applied anywhere yet (docs/go-live.md).

alter table public.story_renders
  add column hold_id uuid,
  add column cost_credits integer check (cost_credits is null or cost_credits >= 0);
