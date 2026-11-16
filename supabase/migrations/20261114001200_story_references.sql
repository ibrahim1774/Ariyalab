-- Story video maker, Task 22: reference ingestion and analysis.
--
-- Adds to story_references (created in 20261114000200_story_schema.sql) what
-- the analysis stores beyond the cut list, transcript and beat sheet:
--
--   frames               [{ ord, url, key }]: one stored thumbnail per beat (the
--                        only files kept after analysis; the source video and its
--                        audio are deleted). The retention job must delete these keys.
--   hook, structure      the model's one-line reading of the hook and the structure
--   suggested_mode       'narrated' | 'talking': how the reference is told
--   rights_confirmed     the customer's rights checkbox (rights_confirmed_at and
--                        rights_statement already exist and hold its time and text)
--   provider_started_at  set just BEFORE the first paid provider call of the
--                        analysis (download, transcription or the model). A failed
--                        analysis gives the free daily count back only while it is null.
--   job_id               the analyze job working on this reference
--
-- Additive only: new nullable or defaulted columns on a story_ table.

alter table public.story_references
  add column frames jsonb not null default '[]'::jsonb,
  add column hook text,
  add column structure text,
  add column suggested_mode text check (suggested_mode in ('narrated', 'talking')),
  add column rights_confirmed boolean not null default false,
  add column provider_started_at timestamptz,
  add column job_id uuid;
