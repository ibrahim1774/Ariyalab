-- Sound on everywhere: `mode` (a narrator tells the story, or the characters speak) is the script's style and no
-- longer follows the quality. The old rule "talking only with pro_talking" is dropped. Additive: nothing else changes.
alter table public.story_projects
  drop constraint if exists story_projects_mode_quality;
