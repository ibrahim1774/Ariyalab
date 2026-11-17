-- Simple maker: the customer pressed "Looks good, design my video". Only while this is true may the simple view start the
-- free parts of the plan (storyboard, first pictures, voice, music) by itself; cleared when the plan is complete.
-- A project opened from the detailed editor never has it, so it never starts anything on its own. Additive only.
alter table public.story_projects
  add column if not exists plan_requested boolean not null default false;
