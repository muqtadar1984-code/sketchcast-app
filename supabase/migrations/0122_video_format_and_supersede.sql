-- 0122_video_format_and_supersede
--
-- A YouTube video's file cannot be replaced once uploaded, so a rendering
-- upgrade never reaches the videos already on the channel. Whether an old
-- video is worth re-rendering and superseding is the founder's call, video
-- by video (2026-09-26). Three additions give that decision its facts and
-- its manual step; nothing is automatic.
--
--   1. platform_settings (key -> jsonb) — one row, 'video_format', written by
--      the worker on every boot (sketchcast-ai shared/video_format.py):
--      {version, changes: {"1": ..., "2": ...}, recorded_at}. The portal
--      reads it to say which published videos predate the current format.
--      Service role only: no policies, the routes read it with the admin
--      client.
--   2. topic_publications.format_version — the version stamped on the
--      presentation when it rendered, copied by the publish job. NULL means
--      posted before the stamp existed, which the portal reads as 1.
--   3. topic_publications.superseded_by / superseded_at — set by the
--      worker's topic_supersede job (queued by the publish route's
--      `supersede` action) once the old video's description points at the
--      new one and a public old video has been made unlisted. A superseded
--      row is no longer "the live video" and no longer counts as outdated.

create table if not exists public.platform_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
comment on table public.platform_settings is
  'Key/value settings written by the worker for the portal to read (e.g. video_format). Service role only.';
alter table public.platform_settings enable row level security;

alter table public.topic_publications
  add column if not exists format_version integer,
  add column if not exists superseded_by uuid references public.topic_publications(id) on delete set null,
  add column if not exists superseded_at timestamptz;
comment on column public.topic_publications.format_version is
  'The video format version (sketchcast-ai shared/video_format.py) the posted video was rendered with; NULL = before the stamp existed (read as 1).';
comment on column public.topic_publications.superseded_by is
  'The newer publication this video now points at (its description carries the link; a public video was made unlisted).';

create index if not exists topic_publications_live_idx
  on public.topic_publications (format_version)
  where youtube_video_id is not null and superseded_by is null;
