-- Task 20: captions, render, checks.
--
-- A project renders one video at a time. lib/story/render.js startRender inserts
-- the new story_renders row (status 'queued') as its lock: a second start while
-- one is queued or running hits this index and is answered 409 render_busy. Two
-- starts racing for the same version number hit story_renders_version_unique
-- instead; the loser reads the new latest version and then meets this index.
-- A render ends 'done' or 'failed' (the render job's onDone / onFail), which
-- frees the project for the next version.
--
-- Not applied anywhere yet (go-live checklist, Task 27).

create unique index story_renders_one_active
  on public.story_renders (project_id)
  where status in ('queued', 'running');
