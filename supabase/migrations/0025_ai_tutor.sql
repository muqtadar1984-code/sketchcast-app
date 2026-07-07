-- 0025 — AI Tutor (Pro+) foundation: grounding source, answer cache, transcript.
--
-- The tutor is a REAL-TIME route in the app (not the batch worker). It grounds
-- every answer STRICTLY on the chapter's own analysis + lesson script, serves
-- repeats from a shared cache (near-$0), and keeps a transcript for the life of
-- the account (removed on account deletion via ON DELETE CASCADE).
--
-- Additive + idempotent. Safe to run as ONE execution.

-- ── 1) chapter_grounding — the tutor's source of truth ───────────────────────
-- Persisted by the worker when a chapter is analysed/generated (the Agent-2
-- concept analysis + the Agent-3 lesson narration text). Keyed per book+chapter
-- so it's shared across every generation of that chapter. SERVICE-ROLE ONLY —
-- the tutor route reads it server-side; no client ever touches raw grounding.
create table if not exists public.chapter_grounding (
  book_id       uuid not null references public.books(id) on delete cascade,
  chapter_num   int  not null,
  chapter_title text,
  concepts      jsonb,   -- Agent-2 analysis: concepts + definitions + prerequisites + difficulty
  script_text   text,    -- Agent-3 narration text (the lesson's own words) — best grounding for "matches the lesson"
  updated_at    timestamptz not null default now(),
  primary key (book_id, chapter_num)
);
alter table public.chapter_grounding enable row level security; -- no policies → service-role only
revoke all on public.chapter_grounding from anon, authenticated;

-- ── 2) tutor_qa — the shared answer cache (replaces the old JSON bank) ────────
-- Fuzzy-match repeats server-side via pg_trgm on a normalised question. A hit is
-- a $0 replay; auto-verified after enough uses. SERVICE-ROLE ONLY.
create extension if not exists pg_trgm;
create table if not exists public.tutor_qa (
  id            uuid primary key default gen_random_uuid(),
  book_id       uuid not null references public.books(id) on delete cascade,
  chapter_num   int  not null,
  question_text text not null,
  question_norm text not null,  -- lower/trimmed for matching
  answer_text   text not null,
  is_verified   boolean not null default false, -- flips true after N confirmed uses (safe-serve gate)
  usage_count   int not null default 1,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz not null default now()
);
create index if not exists tutor_qa_lookup on public.tutor_qa (book_id, chapter_num);
create index if not exists tutor_qa_trgm on public.tutor_qa using gin (question_norm gin_trgm_ops);
alter table public.tutor_qa enable row level security; -- service-role only
revoke all on public.tutor_qa from anon, authenticated;

-- ── 3) tutor_messages — the chat transcript ──────────────────────────────────
-- Kept for the account's lifetime; ON DELETE CASCADE from the student's profile
-- means deleting the account deletes the transcript. RLS: a student reads/writes
-- their own; the teacher who owns the assigned generation may READ (review).
create table if not exists public.tutor_messages (
  id            uuid primary key default gen_random_uuid(),
  student_id    uuid not null references public.profiles(id) on delete cascade,
  generation_id uuid references public.generations(id) on delete cascade,
  book_id       uuid,
  chapter_num   int,
  role          text not null check (role in ('student','coach')),
  content       text not null,
  tutor_move    text,  -- ask|hint|confirm|mastery_check|redirect|answer|sketch
  created_at    timestamptz not null default now()
);
create index if not exists tutor_messages_student on public.tutor_messages (student_id, created_at);
alter table public.tutor_messages enable row level security;
drop policy if exists tutor_msg_student_rw on public.tutor_messages;
create policy tutor_msg_student_rw on public.tutor_messages
  for all using (student_id = auth.uid()) with check (student_id = auth.uid());
drop policy if exists tutor_msg_owner_read on public.tutor_messages;
create policy tutor_msg_owner_read on public.tutor_messages
  for select using (
    generation_id in (select id from public.generations where owner_id = auth.uid())
  );
-- (Parent read of a linked child's transcript can be added later via parent_links,
--  mirroring the parent-portal pattern; the aggregate mastery recap covers the
--  common case without exposing raw chat.)

-- ── 4) cache helpers (service-role RPCs; PostgREST can't do similarity()/++ ) ─
-- Best fuzzy match for a question within a chapter. The route decides whether to
-- auto-serve (conservative: high similarity AND/OR is_verified for exam-type Qs).
create or replace function public.tutor_qa_match(
  p_book_id uuid, p_chapter_num int, p_q_norm text, p_threshold real default 0.6
) returns setof public.tutor_qa
  language sql stable security definer set search_path = public as $$
  select * from public.tutor_qa
  where book_id = p_book_id and chapter_num = p_chapter_num
    and similarity(question_norm, p_q_norm) >= p_threshold
  order by similarity(question_norm, p_q_norm) desc, usage_count desc
  limit 1
$$;
revoke all on function public.tutor_qa_match(uuid, int, text, real) from anon, authenticated;

-- Atomic usage bump on a cache hit; flips is_verified once the answer has been
-- served enough times to be trusted for silent reuse.
create or replace function public.tutor_qa_bump(p_id uuid, p_verify_at int default 10)
  returns void language sql volatile security definer set search_path = public as $$
  update public.tutor_qa
     set usage_count = usage_count + 1,
         last_used_at = now(),
         is_verified = is_verified or (usage_count + 1 >= p_verify_at)
   where id = p_id
$$;
revoke all on function public.tutor_qa_bump(uuid, int) from anon, authenticated;
