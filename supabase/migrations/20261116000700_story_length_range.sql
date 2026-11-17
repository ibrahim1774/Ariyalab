-- Simple maker: a video may be 7 to 120 seconds long (was 15 to 75). Every older row is inside the new range.
alter table public.story_projects drop constraint if exists story_projects_seconds_check;
alter table public.story_projects
  add constraint story_projects_seconds_check check (seconds between 7 and 120);
