-- When the scene settings repair (lib/story/storyboard.js repairSettings) last asked the model for this project: at most
-- one try per 10 minutes, so a repair that keeps failing never makes a model call on every build. Additive and nullable.
alter table public.story_projects
  add column if not exists settings_repair_at timestamptz;
