-- Task 24: voice cloning.
--
-- A clone is paid for with a hold: lib/story/voices.js holds the price, asks the
-- provider, settles the hold when the clone worked and releases it when it did
-- not. hold_id is the hold that is still open for the row; it is cleared once
-- the hold is settled or released, so a row with a hold_id is one whose money
-- still needs closing (a crash in between is repaired by recoverStalledVoices).
--
--   hold_id      the open hold for this attempt (null when closed or none)
--   cost_credits what that hold is for
--   error        why the last attempt failed (customer-readable)
--   attempts     how many times the clone has been tried (a retry adds one)
--
-- One clone at a time per customer: the unique index is the lock, so two
-- requests racing (a double click) cannot both hold and both ask the provider.
--
-- Not applied anywhere yet (go-live checklist, Task 27).

alter table public.story_voices
  add column hold_id uuid,
  add column cost_credits integer check (cost_credits is null or cost_credits > 0),
  add column error text,
  add column attempts integer not null default 1 check (attempts >= 1);

create unique index story_voices_one_pending
  on public.story_voices (user_id)
  where status = 'pending';

-- Recovery looks for rows whose hold is still open.
create index story_voices_open_hold_idx
  on public.story_voices (user_id)
  where hold_id is not null;
