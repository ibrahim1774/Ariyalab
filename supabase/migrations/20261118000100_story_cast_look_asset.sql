-- "Make them look like a picture" (paid): the customer's own picture a character's current round was drawn from.
-- Additive: one nullable column, nothing else changes. Kept on the round so the screen can say "Drawn to look like <picture>";
-- every new round clears it (lib/story/cast.js claimRound), and a deleted picture just clears it (on delete set null).
-- It is not an "in use" mark: the picture can be deleted after the drawing without asking (lib/story/assets.js is unchanged).
alter table public.story_cast
  add column if not exists look_asset_id uuid references public.story_assets (id) on delete set null;
