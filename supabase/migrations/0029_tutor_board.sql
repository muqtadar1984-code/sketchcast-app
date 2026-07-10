-- 0029 — AI Tutor Phase 1: the persistent teaching BOARD (ERE / TAL).
--
-- Instead of a frozen clip per reply, the coach teaches on ONE board per
-- (student, lesson) that persists across turns and reloads: the tutor emits TAL,
-- the engine applies it to a scene graph, and every follow-up MUTATES the objects
-- already on the board. Three tables:
--   * tutor_board       — the current scene graph (source of truth) per session.
--   * tutor_board_event — append-only log of every mutation (the Phase-2/3 spine).
--   * tutor_tal_cache   — dedupe identical grounded turns (question × board state).
-- Board + events are PRIVATE to the student (teachers/parents see only the
-- existing aggregate recap, never raw board or chat).
--
-- Additive + idempotent. Safe to run as ONE execution.

-- ── tutor_board — one persistent board per (student, assigned lesson) ─────────
create table if not exists public.tutor_board (
  id            uuid primary key default gen_random_uuid(),
  student_id    uuid not null references public.profiles(id) on delete cascade,
  generation_id uuid not null references public.generations(id) on delete cascade,
  book_id       uuid not null,
  chapter_num   int  not null,
  scene_graph   jsonb not null default '{"scene":"","nodes":[]}'::jsonb, -- ERE SceneGraph.toJSON()
  board_hash    text not null default '',                                -- ERE SceneGraph.stateHash()
  turn          int  not null default 0,                                 -- turns applied so far
  event_seq     int  not null default 0,                                 -- next event sequence
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (student_id, generation_id)
);
alter table public.tutor_board enable row level security;
-- The student owns and reads/writes their own board. Teachers/parents get NO raw
-- board access (aggregate recap only, via the existing recap route). Server writes
-- go through the service role, which bypasses RLS.
drop policy if exists tutor_board_student_rw on public.tutor_board;
create policy tutor_board_student_rw on public.tutor_board
  for all using (student_id = auth.uid()) with check (student_id = auth.uid());

-- ── tutor_board_event — append-only mutation log (replay/assessment spine) ────
create table if not exists public.tutor_board_event (
  id         uuid primary key default gen_random_uuid(),
  board_id   uuid not null references public.tutor_board(id) on delete cascade,
  seq        int  not null,
  ts         real,                                    -- session-clock seconds (deterministic)
  actor      text not null check (actor in ('tutor','student','system')),
  type       text not null,
  target     text,
  payload    jsonb,
  cause      text,
  created_at timestamptz not null default now()
);
create index if not exists tutor_board_event_lookup on public.tutor_board_event (board_id, seq);
alter table public.tutor_board_event enable row level security;
-- Student may READ their own board's events. Writes are service-role only
-- (append-only); no client insert/update/delete.
drop policy if exists tutor_board_event_student_read on public.tutor_board_event;
create policy tutor_board_event_student_read on public.tutor_board_event
  for select using (board_id in (select id from public.tutor_board where student_id = auth.uid()));
revoke insert, update, delete on public.tutor_board_event from anon, authenticated;

-- ── tutor_tal_cache — dedupe identical grounded turns ────────────────────────
-- A turn is a pure function of (chapter, question, board state), so the same
-- question against the same board replays for $0. SERVICE-ROLE ONLY.
create table if not exists public.tutor_tal_cache (
  id            uuid primary key default gen_random_uuid(),
  book_id       uuid not null,
  chapter_num   int  not null,
  question_norm text not null,
  board_hash    text not null,
  tal           jsonb not null,
  narration     text,
  created_at    timestamptz not null default now(),
  unique (book_id, chapter_num, question_norm, board_hash)
);
alter table public.tutor_tal_cache enable row level security; -- service-role only
revoke all on public.tutor_tal_cache from anon, authenticated;
