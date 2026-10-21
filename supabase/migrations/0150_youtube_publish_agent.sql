-- SketchCast AI — 0150: the YouTube Publishing Agent's queue and rounds
-- ============================================================================
-- Bulk YouTube Posting plan, Phases 2–3 (2026-10-21). Founder: "post 1 video
-- per language a day (if available). that keeps uploads consistent", and "the
-- ability to trigger another set of uploads manually".
--
--   youtube_publish_queue   what an admin ticked in the Library's YouTube view
--                           (/library/translations/youtube): one row per kit,
--                           oldest first per language. pending → selected (in
--                           a round) → queued (its topic_publish job exists)
--                           → done | failed | skipped; cancelled by staff.
--   youtube_publish_rounds  a round takes the oldest pending kit of EVERY
--                           language (at most one each) and the worker posts
--                           them one at a time. 'daily': one per Pacific
--                           quota day, started by the worker after 00:30
--                           Pacific; 'manual': the Library's "Run once more",
--                           inserted by the app as 'requested'.
--
-- The worker (sketchcast-ai catalogue/publish_agent.py) turns each item into
-- an ordinary topic_publish job, so every gate, the own-channel rule, the
-- idempotency and the quota waits of a single post still apply.
-- Service role only: RLS on, no policies. The worker is dark until
-- YOUTUBE_PUBLISH_AGENT=1 and logs once when these tables are missing.
-- ============================================================================

begin;

create table if not exists public.youtube_publish_rounds (
  id            uuid        primary key default gen_random_uuid(),
  trigger       text        not null check (trigger in ('daily', 'manual')),
  quota_day     date        not null,                     -- Pacific day the round belongs to
  status        text        not null default 'requested' check (status in ('requested', 'running', 'done')),
  requested_by  uuid        references public.profiles(id) on delete set null,   -- manual rounds
  created_at    timestamptz not null default now(),
  started_at    timestamptz,
  finished_at   timestamptz,
  summary       jsonb       not null default '{}'::jsonb
);

-- one daily round per quota day; one open round at a time
create unique index if not exists youtube_publish_rounds_one_daily
  on public.youtube_publish_rounds (quota_day) where trigger = 'daily';
create unique index if not exists youtube_publish_rounds_one_open
  on public.youtube_publish_rounds ((true)) where status in ('requested', 'running');

create table if not exists public.youtube_publish_queue (
  id            uuid        primary key default gen_random_uuid(),
  kit_id        uuid        not null references public.topic_kits(id) on delete cascade,
  topic_id      uuid        references public.topics(id) on delete cascade,
  language      text        not null,
  status        text        not null default 'pending'
                            check (status in ('pending', 'selected', 'queued', 'done', 'failed', 'skipped', 'cancelled')),
  round_id      uuid        references public.youtube_publish_rounds(id) on delete set null,
  job_id        uuid        references public.jobs(id) on delete set null,
  attempts      integer     not null default 0,
  last_error    text,
  added_by      uuid        references public.profiles(id) on delete set null,
  added_at      timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- a kit waits in the queue once at a time
create unique index if not exists youtube_publish_queue_one_open
  on public.youtube_publish_queue (kit_id) where status in ('pending', 'selected', 'queued');
create index if not exists youtube_publish_queue_pending
  on public.youtube_publish_queue (language, added_at) where status = 'pending';
create index if not exists youtube_publish_queue_round
  on public.youtube_publish_queue (round_id);

comment on table public.youtube_publish_queue is
  'Translations staff queued for YouTube from the Library; the worker''s publish agent posts the oldest pending kit of each language once a day, plus "Run once more" rounds (0150).';
comment on table public.youtube_publish_rounds is
  'One pass of the YouTube publish agent: at most one kit per language, posted one at a time. daily = once per Pacific quota day; manual = the Library''s Run once more (0150).';

alter table public.youtube_publish_rounds enable row level security;
alter table public.youtube_publish_queue  enable row level security;

commit;
