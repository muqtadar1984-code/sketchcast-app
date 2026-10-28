-- 0161: the book app's store (books.sketchcast.app, Slice 1 — founder 2026-10-27).
--
-- A study-guide book's whole life, recorded: its revisions (each chapter's
-- full structured text per book revision), the approvals that cover them, the
-- pipeline stages it went through, the runs and findings those stages left,
-- its files (stored in a private S3 bucket; this table only indexes them),
-- label points, costs and open items.
--
-- Same doctrine as platform_admins (0014): deny-by-default RLS with NO
-- policies, and no grants to anon/authenticated. Only the service role (the
-- books.* server routes, behind the @sketchcast.app staff gate, and the
-- worker's importer) can read or write. Nothing here is visible to a teacher,
-- student or parent session.
--
-- Revisions and approvals are IMMUTABLE: a trigger refuses UPDATE and DELETE,
-- so approved text can never be silently altered. A correction is a new
-- revision; a new approval is a new row.
--
-- Run as ONE execution. Idempotent.

-- ── Books ────────────────────────────────────────────────────────────────────
create table if not exists public.pub_works (
  uid              text primary key,          -- ULID from the engine (pub.works.uid locally)
  slug             text not null unique,
  title            text not null,
  subtitle         text,
  subject_strand   text not null,              -- e.g. science/biology
  curriculum_code  text not null,              -- primary curriculum, e.g. cambridge_ls_science_0893
  grade_band       text,
  age_band         text,
  language         text not null default 'en',
  status           text not null default 'scoping',  -- the lifecycle stage the book is in
  current_revision text,                       -- pub_book_revisions.key the app opens on
  facts            jsonb not null default '{}', -- pages, questions, figures … of the current revision
  brief            jsonb not null default '{}', -- scope as data (curricula, grades, strands, directives)
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- One row per book revision (first draft, Revision 2 … 4.1). Ordered by ordinal.
create table if not exists public.pub_book_revisions (
  work_uid    text not null references public.pub_works(uid) on delete cascade,
  key         text not null,                   -- 'r0' (first approved drafts), 'r1', 'r2', 'r3', 'r4', 'r4.1'
  ordinal     int  not null,
  label       text not null,                   -- 'Revision 4.1'
  summary     text,
  created_at  timestamptz not null default now(),
  primary key (work_uid, key)
);

-- A chapter's full structured manuscript at one book revision: plan,
-- sections (typed blocks) and exercises, exactly as the engine wrote them.
create table if not exists public.pub_chapter_revisions (
  id              bigserial primary key,
  work_uid        text not null references public.pub_works(uid) on delete cascade,
  revision_key    text not null,
  chapter         int  not null,
  title           text not null,
  body            jsonb not null,             -- {plan, sections, exercises, review?, layout_choice?}
  content_sha256  text not null,              -- sha256 of canonical {sections, exercises} (sort_keys)
  figure_refs     text[] not null default '{}',
  words           int,
  questions       int,
  source_path     text,                       -- the file it was imported from, relative to the book folder
  created_at      timestamptz not null default now(),
  unique (work_uid, revision_key, chapter),
  foreign key (work_uid, revision_key) references public.pub_book_revisions(work_uid, key)
);
create index if not exists pub_chrev_work_idx on public.pub_chapter_revisions (work_uid, chapter);

-- ── The life of the book ─────────────────────────────────────────────────────
create table if not exists public.pub_stages (
  id          bigserial primary key,
  work_uid    text not null references public.pub_works(uid) on delete cascade,
  ordinal     int  not null,
  key         text not null,                   -- registry key: scope, drafting, expansion, theme_gate_d, …
  title       text not null,
  summary     text,
  status      text not null default 'done',    -- not_started|running|needs_approval|done|failed|open
  started_on  date,
  finished_on date,
  revision_key text,
  sources     text[] not null default '{}',    -- folders/files of the book folder this stage left
  detail      jsonb not null default '{}',
  unique (work_uid, key)
);

create table if not exists public.pub_approvals (
  id             bigserial primary key,
  work_uid       text not null references public.pub_works(uid) on delete cascade,
  kind           text not null,                -- gate_a|gate_b|gate_d|book|controlled_revision|kdp|…
  scope          text not null,                -- book|chapter
  chapter        int,
  revision_key   text,
  stage_key      text,
  label          text,
  approved_by    text not null,                -- 'founder' in the engine's records; a user id once approved in-app
  approved_on    date not null,
  basis          text,
  content_sha256 text,
  hash_of        text,
  hash_verified  boolean,                      -- the importer re-computed the hash and it matched
  waived         jsonb not null default '[]',
  open_flags     jsonb not null default '[]',
  created_at     timestamptz not null default now()
);
create index if not exists pub_appr_work_idx on public.pub_approvals (work_uid, approved_on);

create table if not exists public.pub_runs (
  id           bigserial primary key,
  work_uid     text not null references public.pub_works(uid) on delete cascade,
  stage_key    text not null,
  label        text not null,
  chapters     int[] not null default '{}',
  status       text not null default 'done',   -- queued|running|waiting_capacity|paused|done|failed|cancelled
  usd          numeric(10,4),
  started_at   timestamptz,
  finished_at  timestamptz,
  detail       jsonb not null default '{}',    -- per-chapter results, params, errors
  source_path  text,
  created_at   timestamptz not null default now()
);
create index if not exists pub_runs_work_idx on public.pub_runs (work_uid, stage_key);

create table if not exists public.pub_findings (
  id            bigserial primary key,
  work_uid      text not null references public.pub_works(uid) on delete cascade,
  revision_key  text not null,                 -- the revision whose audit raised it
  chapter       int,
  finding_key   text,                          -- the engine's id, e.g. ch03-F004
  source        text not null,                 -- academic_audit|gates|uniqueness|layout|compiler|…
  severity      text,                          -- P0|P1|P2|blocker|warn
  agreement     text,                          -- CONFIRMED|SINGLE
  category      text,
  location      text,
  quote         text,
  problem       text,
  fix           text,
  confidence    numeric(4,3),
  raised_by     text[] not null default '{}',
  ruling        jsonb,                         -- the other validator's adjudication
  status        text not null default 'open',  -- open|accepted|applied|rejected|deferred
  decision      jsonb,                         -- applied what / verified by whom / reason
  created_at    timestamptz not null default now()
);
create index if not exists pub_find_work_idx on public.pub_findings (work_uid, revision_key, chapter);

create table if not exists public.pub_artifacts (
  id            bigserial primary key,
  work_uid      text not null references public.pub_works(uid) on delete cascade,
  stage_key     text,
  revision_key  text,
  chapter       int,
  kind          text not null,                 -- book_pdf|print_pdf|kdp_interior|kdp_cover|gate_d_packet|qa_report|…
  title         text not null,
  rel_path      text not null,                 -- path inside the book folder
  bytes         bigint,
  sha256        text,
  content_type  text,
  storage       text not null default 's3',    -- s3|local (not uploaded)
  storage_key   text,                          -- the S3 object key
  created_at    timestamptz not null default now(),
  unique (work_uid, rel_path)
);

create table if not exists public.pub_annotations (
  work_uid    text not null references public.pub_works(uid) on delete cascade,
  figure_ref  text not null,                   -- fig:… / asset:… / book:…
  body        jsonb not null,                  -- {size, anchors{label:[x,y]}, unverified[], history[]}
  primary key (work_uid, figure_ref)
);

create table if not exists public.pub_cost_lines (
  id            bigserial primary key,
  work_uid      text not null references public.pub_works(uid) on delete cascade,
  stage_key     text not null,
  revision_key  text,
  chapter       int,
  provider      text,
  model         text,
  role          text,
  input_tokens  bigint,
  output_tokens bigint,
  usd           numeric(10,4) not null default 0,
  source_path   text
);
create index if not exists pub_cost_work_idx on public.pub_cost_lines (work_uid, stage_key);

create table if not exists public.pub_open_items (
  id          bigserial primary key,
  work_uid    text not null references public.pub_works(uid) on delete cascade,
  key         text not null,
  title       text not null,
  detail      text,
  owner       text,
  status      text not null default 'open',    -- open|parked|done
  created_at  timestamptz not null default now(),
  unique (work_uid, key)
);

-- Per-book access. The founder holds every right by default (books.* gate);
-- anyone else needs a row, and only @sketchcast.app staff may be granted.
create table if not exists public.pub_members (
  work_uid    text references public.pub_works(uid) on delete cascade,  -- NULL = every book
  user_id     uuid not null references public.profiles(id) on delete cascade,
  role        text not null check (role in ('editor','reviewer','approver')),
  granted_by  uuid references public.profiles(id) on delete set null,
  granted_at  timestamptz not null default now(),
  revoked_at  timestamptz
);
create unique index if not exists pub_members_uniq
  on public.pub_members (coalesce(work_uid, '*'), user_id, role) where revoked_at is null;

-- ── Immutability ─────────────────────────────────────────────────────────────
create or replace function public.pub_refuse_change() returns trigger
  language plpgsql set search_path = '' as
$$ begin
  raise exception '% rows are immutable (book revisions and approvals are never changed; write a new row)', tg_table_name;
end $$;

drop trigger if exists pub_chapter_revisions_immutable on public.pub_chapter_revisions;
create trigger pub_chapter_revisions_immutable before update or delete on public.pub_chapter_revisions
  for each row execute function public.pub_refuse_change();
drop trigger if exists pub_approvals_immutable on public.pub_approvals;
create trigger pub_approvals_immutable before update or delete on public.pub_approvals
  for each row execute function public.pub_refuse_change();

-- ── Deny by default ──────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['pub_works','pub_book_revisions','pub_chapter_revisions','pub_stages','pub_approvals',
                           'pub_runs','pub_findings','pub_artifacts','pub_annotations','pub_cost_lines',
                           'pub_open_items','pub_members'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;
revoke all on function public.pub_refuse_change() from public, anon, authenticated;
