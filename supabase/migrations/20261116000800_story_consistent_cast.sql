-- Simple maker: does the video keep the same characters in every scene? True by default.
-- The script step sets it false when the idea or the example video calls for different people in each scene; then
-- shots are pictured and made without the cast's reference pictures and the cast step is skipped. Additive only.
alter table public.story_projects
  add column if not exists consistent_cast boolean not null default true;
