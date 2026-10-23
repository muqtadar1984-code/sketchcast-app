-- SketchCast AI — 0154: the Pinterest Pin Engine's boards, pins, rounds, stats and token
-- ============================================================================
-- Feature guide + build plan: Edtech/docs/feature-guides/pinterest-pin-engine*.md
-- (approved 2026-10-22). The worker drafts pins from approved catalogue
-- content, a platform admin approves EACH pin in the Library's Pinterest tab
-- (Pinterest's Developer Guidelines: "the end user must choose each Pin to be
-- published"), and the worker posts approved pins in daily rounds — one per
-- language per day, plus the Library's "Run once more" — the same shape as
-- the YouTube Publishing Agent (0150).
--
--   pinterest_boards         one Pinterest account, boards per language ×
--                            subject (+ "Free Worksheets", "Science Diagrams");
--                            planned → approved (by an admin) → created (by
--                            the worker, which then holds the board id).
--   pinterest_pins           one row per pin we intend to post. draft →
--                            in_review → approved → scheduled → posting →
--                            posted, or rejected / failed / retired.
--   pinterest_publish_rounds a round schedules at most N approved pins per
--                            language and the worker posts them one at a time.
--   pinterest_pin_stats      daily metrics for OUR pins only (decision D8).
--   pinterest_oauth          the account's OAuth token as CIPHERTEXT ONLY; the
--                            worker encrypts it with a key that never enters
--                            the database (build plan §3.3). No app route
--                            ever selects it.
--
-- Service role only: RLS on, no policies. The worker is dark until
-- PINTEREST_AGENT=1 and the settings row below says enabled; it ships in
-- dry run.
-- ============================================================================

begin;

-- The two unique indexes on public.jobs below take a SHARE lock on a busy
-- table while they build. Apply off-peak (20:00–05:00 UTC) with the queue
-- idle; and if a long transaction holds jobs, fail fast instead of queueing
-- every job write behind this DDL.
set local lock_timeout = '5s';

create table if not exists public.pinterest_boards (
  id                  uuid        primary key default gen_random_uuid(),
  language            text        not null,
  board_key           text        not null,                -- 'biology' | … | 'free_worksheets' | 'science_diagrams'
  name                text        not null,
  description         text        not null default '',
  status              text        not null default 'planned'
                                  check (status in ('planned', 'approved', 'created', 'archived')),
  pinterest_board_id  text        unique,
  sections            jsonb       not null default '{}'::jsonb,   -- {grade_band: pinterest_section_id}
  approved_by         uuid        references public.profiles(id) on delete set null,
  approved_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (language, board_key)
);

create table if not exists public.pinterest_publish_rounds (
  id            uuid        primary key default gen_random_uuid(),
  trigger       text        not null check (trigger in ('daily', 'manual')),
  day           date        not null,                         -- UTC day the round belongs to
  status        text        not null default 'requested' check (status in ('requested', 'running', 'done')),
  requested_by  uuid        references public.profiles(id) on delete set null,   -- manual rounds
  created_at    timestamptz not null default now(),
  started_at    timestamptz,
  finished_at   timestamptz,
  summary       jsonb       not null default '{}'::jsonb
);

-- one daily round per day; one open round at a time
create unique index if not exists pinterest_publish_rounds_one_daily
  on public.pinterest_publish_rounds (day) where trigger = 'daily';
create unique index if not exists pinterest_publish_rounds_one_open
  on public.pinterest_publish_rounds ((true)) where status in ('requested', 'running');

create table if not exists public.pinterest_pins (
  id                uuid        primary key default gen_random_uuid(),
  source_kind       text        not null
                                check (source_kind in ('topic', 'figure', 'colour', 'preview', 'question', 'book', 'video')),
  source_ref        text        not null,                     -- figure id, asset key, preview path, question id, …
  topic_id          uuid        references public.topics(id) on delete set null,
  kit_id            uuid        references public.topic_kits(id) on delete set null,
  language          text        not null,
  format            text        not null check (format in ('static', 'carousel', 'video')),
  template          text        not null,                     -- 'explainer' | 'diagram' | 'worksheet' | …
  board_id          uuid        references public.pinterest_boards(id) on delete set null,
  grade_band        text,
  title             text,
  description       text,
  alt_text          text,
  link              text,
  utm               jsonb       not null default '{}'::jsonb,
  back_translation  jsonb,                                    -- D3: English beside non-English copy
  ai_modified       boolean     not null default false,       -- D4: model-made artwork is declared
  images            jsonb       not null default '[]'::jsonb, -- [{path, width, height, bytes, dominant_color}]
  content_hash      text,
  status            text        not null default 'draft'
                                check (status in ('draft', 'in_review', 'approved', 'scheduled', 'posting',
                                                  'posted', 'rejected', 'failed', 'retired')),
  precheck          jsonb       not null default '{}'::jsonb, -- {blocking: [...], warnings: [...], checked_at}
  edited            boolean     not null default false,
  reject_reason     text,
  approved_by       uuid        references public.profiles(id) on delete set null,
  approved_at       timestamptz,
  round_id          uuid        references public.pinterest_publish_rounds(id) on delete set null,
  post_token        text,
  post_started_at   timestamptz,
  pinterest_pin_id  text        unique,
  posted_at         timestamptz,
  attempts          integer     not null default 0,
  last_error        text,
  draft_job_id      uuid        references public.jobs(id) on delete set null,
  post_job_id       uuid        references public.jobs(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  -- never draft the same pin twice
  unique (source_kind, source_ref, language, format, template),
  -- an approved pin names who approved it, and when: no path (route, worker or
  -- hand-written SQL) reaches a posting state without a human approval
  constraint pinterest_pins_approval_named
    check (status not in ('approved', 'scheduled', 'posting', 'posted') or (approved_by is not null and approved_at is not null)),
  -- a rejection says why
  constraint pinterest_pins_reject_reason
    check (status <> 'rejected' or coalesce(btrim(reject_reason), '') <> '')
);

-- never post identical pins
create unique index if not exists pinterest_pins_content_hash
  on public.pinterest_pins (content_hash) where content_hash is not null;
-- the round's pick: oldest approved per language
create index if not exists pinterest_pins_queue
  on public.pinterest_pins (language, approved_at) where status = 'approved';
create index if not exists pinterest_pins_status
  on public.pinterest_pins (status, language);
create index if not exists pinterest_pins_topic
  on public.pinterest_pins (topic_id, language, posted_at);

create table if not exists public.pinterest_pin_stats (
  pin_row_id      uuid        not null references public.pinterest_pins(id) on delete cascade,
  day             date        not null,
  impression      integer,
  save            integer,
  pin_click       integer,
  outbound_click  integer,
  video           jsonb,
  provisional     boolean     not null default true,          -- the last ~2 days may still move
  fetched_at      timestamptz not null default now(),
  primary key (pin_row_id, day)
);

create table if not exists public.pinterest_oauth (
  id                 smallint    primary key default 1 check (id = 1),   -- one account
  account_username   text,
  scopes             text[]      not null default '{}',
  ciphertext         text        not null,                   -- Fernet token of the token JSON
  access_expires_at  timestamptz not null,
  refresh_expires_at timestamptz not null,
  refreshed_at       timestamptz not null default now(),
  last_error         text
);

-- one live post at a time; one live draft per topic × language
create unique index if not exists jobs_one_live_pin_post
  on public.jobs ((true)) where type = 'pin_post' and status in ('queued', 'processing');
create unique index if not exists jobs_one_live_pin_draft
  on public.jobs ((params->>'topic_id'), (params->>'language'))
  where type = 'pin_draft' and status in ('queued', 'processing');

comment on table public.pinterest_boards is
  'Boards of the one SketchCast Pinterest account, per language × subject; an admin approves a board before the worker creates it (0154).';
comment on table public.pinterest_pins is
  'Pins the Pinterest Pin Engine drafted; each is approved individually by a platform admin before a round posts it (0154).';
comment on table public.pinterest_publish_rounds is
  'One pass of the Pinterest agent: at most N approved pins per language, posted one at a time. daily = once per UTC day; manual = the Library''s Run once more (0154).';
comment on table public.pinterest_pin_stats is
  'Daily Pinterest analytics for SketchCast''s own pins only (0154).';
comment on table public.pinterest_oauth is
  'The SketchCast Pinterest OAuth token, encrypted by the worker; ciphertext only. Never read by the app (0154).';

alter table public.pinterest_boards         enable row level security;
alter table public.pinterest_pins           enable row level security;
alter table public.pinterest_publish_rounds enable row level security;
alter table public.pinterest_pin_stats      enable row level security;
alter table public.pinterest_oauth          enable row level security;

-- pin images: private; sent to Pinterest as base64, shown in the console via signed URLs
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('pinterest-pins', 'pinterest-pins', false, 20971520, array['image/png', 'image/jpeg', 'video/mp4'])
  on conflict (id) do update
    set public = excluded.public,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;

-- P1 boards (English), waiting for the founder's approval in the Library
insert into public.pinterest_boards (language, board_key, name, description) values
  ('en', 'biology',          'Biology Diagrams & Worksheets',
   'Labelled biology diagrams, clear topic explainers and free worksheets for middle and high school science: cells, body systems, plants, ecology and more. Made by SketchCast for teachers and parents.'),
  ('en', 'chemistry',        'Chemistry Diagrams & Worksheets',
   'Chemistry made visual: atoms, the periodic table, reactions, acids and bases, with free worksheets for middle and high school. Made by SketchCast for teachers and parents.'),
  ('en', 'physics',          'Physics Diagrams & Worksheets',
   'Physics explained with clear diagrams: forces, energy, heat transfer, waves, electricity and magnetism, with free worksheets for school science. Made by SketchCast for teachers and parents.'),
  ('en', 'algebra',          'Algebra Explained',
   'Step-by-step algebra: equations, graphs, sequences and worked examples, with free practice worksheets for middle and high school maths. Made by SketchCast for teachers and parents.'),
  ('en', 'geometry',         'Geometry Explained',
   'Geometry and trigonometry made visual: angles, shapes, circles, Pythagoras and more, with free practice worksheets. Made by SketchCast for teachers and parents.'),
  ('en', 'free_worksheets',  'Free Science & Maths Worksheets',
   'Free printable worksheets with answer keys for school science and maths, matched to Cambridge, CBSE and other curricula. Made by SketchCast for teachers and parents.'),
  ('en', 'science_diagrams', 'Science Diagrams',
   'Clear, labelled science diagrams for teaching and revision: biology, chemistry and physics. Made by SketchCast for teachers and parents.')
on conflict (language, board_key) do nothing;

-- the founder's switch, read by the worker every tick; OFF and in dry run until switched
insert into public.platform_settings (key, value, updated_at)
values ('pinterest_agent', jsonb_build_object(
          'enabled', false,
          'dry_run', true,
          'paused', false,
          'daily_at', '21:00',
          'per_language_per_day', 1,
          'languages', jsonb_build_array('en'),
          'min_topic_gap_days', 7,
          'post_gap_minutes', 5,
          'max_waiting_per_language', 14,
          'summary_email', 'muqtadar.quraishi@sketchcast.app',
          'breaker', jsonb_build_object('tripped', false, 'failures', 0)), now())
on conflict (key) do nothing;

commit;
