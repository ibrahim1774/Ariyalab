-- Task 26 round 3: the MCP drafting job that wrote a script version.
--
-- A drafting job (lib/story/draftJobs.js) that died after saving its script
-- version is retried by the runner. The retry looks for a version carrying its
-- own job id and, finding one, finishes without writing again. Versions written
-- on the website leave it null.
--
-- Apply together with 20261116000100 (not applied anywhere yet; go-live checklist, Task 27).

alter table public.story_scripts
  add column draft_job_id uuid references public.story_jobs (id) on delete set null;

create index story_scripts_draft_job_idx on public.story_scripts (draft_job_id) where draft_job_id is not null;
