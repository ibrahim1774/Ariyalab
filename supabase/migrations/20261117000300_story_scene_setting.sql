-- A scene's setting line (place, time of day, lighting, what each character wears and carries), written by the shot planner and
-- carried by every shot of the scene so each still and clip prompt can name it. Null for shots planned before this existed:
-- their prompts are made as they were. Additive: one nullable column; story_shots_replace is not changed (the planner's
-- setting is written onto the scene's shots right after the swap, lib/story/storyboard.js saveSettings).
alter table public.story_shots add column if not exists setting text check (setting is null or char_length(setting) <= 1000);
