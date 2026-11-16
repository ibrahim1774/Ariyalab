-- Task 26 round 2: MCP drafting jobs (job kind 'script', lib/story/draftJobs.js).
--
-- A drafting job carries the free-tier count its MCP tool took (payload.receipt).
-- When the job ends without a draft, onDone or onFail gives that count back. The
-- runner may run those hooks again (apply retries), so the give-back is claimed
-- first with a compare and set on this column: only the call that moves it from
-- null gives the count back.
--
-- Not applied anywhere yet (go-live checklist, Task 27).

alter table public.story_jobs
  add column allowance_returned_at timestamptz;

comment on column public.story_jobs.allowance_returned_at is
  'When the count a drafting job carried (payload.receipt) was given back; set once, by compare and set (Task 26).';
