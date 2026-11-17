-- A character drawn in an art style the project no longer uses. Set when the style changes while the character has pictures;
-- cleared when the character's pictures are made again. Additive: one boolean column with a default, nothing else changes.
alter table public.story_cast add column if not exists style_stale boolean not null default false;
