-- SketchCast AI — 0149: YouTube upload safety and the quota ledger
-- ============================================================================
-- Bulk YouTube Posting plan, Phase 1 (2026-10-21). The worker's topic_publish
-- job (sketchcast-ai catalogue/publish.py) gains three protections before
-- bulk posting runs hundreds of uploads through deploys and reaper requeues:
--
--   1. topic_publications.upload_token / upload_started_at — written JUST
--      BEFORE videos.insert; the video carries the tag 'sc-' || the token's
--      first 10 characters. A row with a token and no youtube_video_id was
--      interrupted between YouTube accepting the file and the database
--      hearing about it; the next run looks for the tag on the channel and
--      ADOPTS that video instead of uploading a second copy.
--   2. youtube_quota_ledger — one row per (Pacific quota day, channel): the
--      units of the general 10,000-unit pool the worker spent, the uploads,
--      and a per-method call count. videos.insert is counted in `uploads`,
--      not `units` (the 2026-10-21 Heat Transfer pilot put 12 uploads
--      through one quota day without a quota error).
--   3. youtube_quota_add() — the one atomic increment the worker calls after
--      each YouTube call, so two workers never lose each other's counts.
--
-- The worker detects a database without these (it writes the row without
-- the two columns and logs the ledger once), so this may be applied before
-- or after the worker deploy. Service role only: RLS on, no policies.
-- ============================================================================

begin;

alter table public.topic_publications
  add column if not exists upload_token      text,
  add column if not exists upload_started_at timestamptz;

comment on column public.topic_publications.upload_token is
  'Written by the worker just before videos.insert; the video carries the tag sc-<first 10 chars>. Token set + no youtube_video_id = an interrupted upload the next run looks for on the channel before uploading again (0149).';
comment on column public.topic_publications.upload_started_at is
  'When the upload carrying upload_token began (0149).';

create table if not exists public.youtube_quota_ledger (
  quota_day        date        not null,              -- the Pacific calendar day YouTube's quota resets on
  channel_language text        not null,              -- the channel the calls were made against
  units            integer     not null default 0,    -- general-pool units (documented costs), videos.insert excluded
  uploads          integer     not null default 0,    -- videos.insert calls that returned a video
  calls            jsonb       not null default '{}'::jsonb,  -- {"captions.insert": 3, ...}
  updated_at       timestamptz not null default now(),
  primary key (quota_day, channel_language)
);

comment on table public.youtube_quota_ledger is
  'YouTube Data API spend per Pacific quota day and channel, written by the worker (youtube_quota_add) after each call. One Google project serves every channel, so the day''s total is the sum over channels (0149).';

alter table public.youtube_quota_ledger enable row level security;

create or replace function public.youtube_quota_add(
  p_day date, p_channel text, p_method text, p_units integer, p_uploads integer
) returns void
language sql
set search_path = public
as $$
  insert into public.youtube_quota_ledger as l (quota_day, channel_language, units, uploads, calls, updated_at)
  values (p_day, p_channel, greatest(coalesce(p_units, 0), 0), greatest(coalesce(p_uploads, 0), 0),
          jsonb_build_object(p_method, 1), now())
  on conflict (quota_day, channel_language) do update
    set units      = l.units + excluded.units,
        uploads    = l.uploads + excluded.uploads,
        calls      = l.calls || jsonb_build_object(p_method, coalesce((l.calls ->> p_method)::integer, 0) + 1),
        updated_at = now();
$$;

revoke all on function public.youtube_quota_add(date, text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.youtube_quota_add(date, text, text, integer, integer) to service_role;

commit;
