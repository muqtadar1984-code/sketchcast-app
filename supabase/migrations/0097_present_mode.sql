-- 0097 — Present mode, Phase 2: the board a teacher drives in front of a class.
--
-- Phase 0 measured whether live ink is fast enough (0096, present_probe) and
-- Phase 1 built the board as a library. This is where a lesson becomes a ROW:
-- one session per period taught, the roll she wrote on, and — separately — a
-- record of what she actually put in front of the class.
--
-- FIVE TABLES, AND THE FOURTH IS THE ONE WORTH EXPLAINING.
--
--   present_sessions     one period. Carries the TIMETABLE CONTEXT: which class,
--                        which slot, which book/chapter/part she set out to teach.
--   present_pages        what sits UNDER the ink on each page of the roll.
--   present_strokes      the ink. Append-only; undo is a tombstone, never a
--                        delete, so the client's log and this table are folds of
--                        the same sequence and can be reconciled rather than
--                        diffed. Same discipline as credit_ledger.
--   present_items        what she ACTUALLY SHOWED, in order.
--   present_last_taught  where each class has got to, so the context bar is one
--                        tap from the second lesson onward.
--
-- WHY present_items EXISTS AT ALL. A session's CONTEXT and its CONTENT are not
-- the same thing, and conflating them breaks two things quietly. She can pull in
-- a cumulative revision worksheet spanning chapters 1-5 while the timetable slot
-- says Chapter 4 Part 2 (see 0061 revision papers: kind='worksheet',
-- params.revision=true, chapter_ref NULL, params.chapters=[...]). Without a
-- record of what was opened, (a) the after-lesson note would describe the
-- TIMETABLE rather than the lesson — exactly the failure the whole feature is
-- meant to avoid — and (b) the last-taught pointer would be tempted to advance
-- to chapter 5 because that is what was on screen.
--
-- Hence the rule this schema is shaped around and which the app must honour:
-- ONLY THE SLOT'S OWN VIDEO OR KIT WORKSHEET ADVANCES present_last_taught.
-- Revising chapters 1-5 is recorded in present_items and moves nothing.
--
-- STUDENT VISIBILITY IS PHASE 3 AND DELIBERATELY ABSENT HERE. Every policy below
-- is the teacher reading her own rows. The roll and the recap reach students
-- through a later migration, once there is a published thing to reach them with;
-- granting it now would be granting access to a half-written board.
--
-- Additive + idempotent. Safe to re-run.

-- DDL on a live database should never queue behind a long transaction. Several
-- FKs below touch profiles/classes/books/generations — all busy tables.
set local lock_timeout = '5s';

-- ── one period taught ────────────────────────────────────────────────────────
create table if not exists public.present_sessions (
  id            uuid primary key default gen_random_uuid(),
  teacher_id    uuid not null references public.profiles(id) on delete cascade,
  school_id     uuid references public.schools(id) on delete set null,
  -- Nullable throughout: Present mode must open for an independent teacher with
  -- no school, no timetable and no class. The context bar is a convenience, and
  -- a board that refuses to start without one would be useless to the people
  -- most likely to try it first.
  class_id      uuid references public.classes(id) on delete set null,
  subject       text,
  book_id       uuid references public.books(id) on delete set null,
  chapter_num   int,
  part          int,
  -- Which timetable cell this was, for later analysis of coverage vs plan.
  slot_day      int,
  slot_period   int,
  started_at    timestamptz not null default now(),
  ended_at      timestamptz,
  page_count    int not null default 1,
  pdf_path      text,                    -- artifacts bucket, once exported
  recap_draft   text,                    -- what the model wrote
  recap_body    text,                    -- what she published, after editing
  recap_published_at timestamptz
);
create index if not exists present_sessions_teacher_idx
  on public.present_sessions (teacher_id, started_at desc);
create index if not exists present_sessions_class_idx
  on public.present_sessions (class_id, started_at desc);

-- ── what sits under the ink ──────────────────────────────────────────────────
create table if not exists public.present_pages (
  session_id uuid not null references public.present_sessions(id) on delete cascade,
  idx        int  not null,
  -- {kind:'blank'} | {kind:'frame',src,generation_id,t} | {kind:'question',...}
  background jsonb not null default '{"kind":"blank"}'::jsonb,
  primary key (session_id, idx)
);

-- ── the ink ──────────────────────────────────────────────────────────────────
create table if not exists public.present_strokes (
  session_id uuid not null references public.present_sessions(id) on delete cascade,
  seq        int  not null,
  page_idx   int  not null,
  tool       text not null check (tool in ('pen', 'highlighter', 'eraser')),
  color      text not null,
  width      real not null check (width > 0),
  -- Flat [x,y,w, x,y,w, ...] in PAGE units (1600x900). Not pixels: a stroke
  -- drawn on a panel has to render on a laptop, print to PDF and reappear on a
  -- student's phone. The third value is a WIDTH MULTIPLIER resolved at capture
  -- time, not raw pressure — most panels report a constant 0.5 for ever, and a
  -- roll that stored the raw signal could never be re-rendered as it looked.
  pts        jsonb not null,
  -- Undo. A tombstone, never a delete: the row keeps its place in the sequence
  -- so a replay can never resurrect what she removed.
  voided_at  timestamptz,
  primary key (session_id, seq)
);
create index if not exists present_strokes_page_idx
  on public.present_strokes (session_id, page_idx);

-- ── what she actually showed ─────────────────────────────────────────────────
create table if not exists public.present_items (
  session_id    uuid not null references public.present_sessions(id) on delete cascade,
  seq           int  not null,
  -- ON DELETE SET NULL, not cascade: a lesson's record of "she showed the
  -- worksheet" must survive that worksheet being regenerated or withdrawn.
  generation_id uuid references public.generations(id) on delete set null,
  kind          text not null check (kind in ('video', 'worksheet', 'blank')),
  -- {part} | {question_ids:[...]} | {video_t_end}
  detail        jsonb,
  opened_at     timestamptz not null default now(),
  primary key (session_id, seq)
);
create index if not exists present_items_generation_idx
  on public.present_items (generation_id);

-- ── where each class has got to ──────────────────────────────────────────────
-- Keyed by SUBJECT as well as class: a class has Science and Mathematics, and
-- they are at different chapters. Keyed by teacher too, so RLS is a row check
-- rather than a join, and so a covering teacher cannot silently move a
-- colleague's pointer.
create table if not exists public.present_last_taught (
  teacher_id  uuid not null references public.profiles(id) on delete cascade,
  class_id    uuid not null references public.classes(id) on delete cascade,
  subject     text not null,
  book_id     uuid references public.books(id) on delete set null,
  chapter_num int,
  part        int,
  updated_at  timestamptz not null default now(),
  primary key (teacher_id, class_id, subject)
);

-- ── access ───────────────────────────────────────────────────────────────────
-- Belt AND braces, matching 0079 / 0086 / 0093 / 0096. RLS alone holds these
-- shut today — no write policy exists, so writes are denied by default — but
-- that is ONE mechanism and it is the one a future `disable row level security`
-- removes in a single statement. The grant layer denies independently. Nothing
-- legitimate loses access: every /api/present/* route reads and writes through
-- the service role, which bypasses both.
do $$
declare t text;
begin
  foreach t in array array[
    'present_sessions', 'present_pages', 'present_strokes',
    'present_items', 'present_last_taught'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

-- The teacher reads her own work. Nobody else reads anything here yet — student
-- visibility arrives in Phase 3, against a PUBLISHED recap rather than a live
-- board. The child tables reach their owner through their session.
drop policy if exists present_sessions_own_read on public.present_sessions;
create policy present_sessions_own_read on public.present_sessions
  for select using (teacher_id = auth.uid());

drop policy if exists present_pages_own_read on public.present_pages;
create policy present_pages_own_read on public.present_pages
  for select using (exists (
    select 1 from public.present_sessions s
    where s.id = present_pages.session_id and s.teacher_id = auth.uid()));

drop policy if exists present_strokes_own_read on public.present_strokes;
create policy present_strokes_own_read on public.present_strokes
  for select using (exists (
    select 1 from public.present_sessions s
    where s.id = present_strokes.session_id and s.teacher_id = auth.uid()));

drop policy if exists present_items_own_read on public.present_items;
create policy present_items_own_read on public.present_items
  for select using (exists (
    select 1 from public.present_sessions s
    where s.id = present_items.session_id and s.teacher_id = auth.uid()));

drop policy if exists present_last_taught_own_read on public.present_last_taught;
create policy present_last_taught_own_read on public.present_last_taught
  for select using (teacher_id = auth.uid());

comment on table public.present_sessions is
  'Present mode: one row per period taught on the classroom board. Carries the TIMETABLE context (class, slot, intended book/chapter/part) — what was actually shown is present_items, which is deliberately a different thing.';
comment on table public.present_items is
  'Present mode: what the teacher actually put in front of the class, in order. NOT the same as the session''s timetable context — a cumulative revision worksheet spans chapters the slot knows nothing about. Grounds the after-lesson recap in what was SHOWN rather than SCHEDULED, and is why only the slot''s own part may advance present_last_taught.';
comment on table public.present_last_taught is
  'Present mode: where each (teacher, class, subject) has got to, so the context bar is one tap from the second lesson onward. ONLY the slot''s own video or kit worksheet advances this — revising chapters 1-5 must not claim chapter 5 is taught.';
