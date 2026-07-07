-- 0026 — AI Tutor mastery signals (M3): an append-only log of evidence that a
-- student is (or isn't) getting a chapter, plus a summary helper.
--
-- Honest by design. The AUTHORITATIVE mastery signal is quiz evidence, which we
-- already re-grade live from submissions (see buildStudentModel). This table
-- adds the SECONDARY signal the tutor itself produces — that a student actually
-- engaged with a chapter's coach — so the parent/teacher recap can say "practised
-- 6 times, still shaky on condensation" rather than guessing. Append-only: we log
-- events, never mutate a rolling score, so the history stays auditable.
--
-- Additive + idempotent. Safe to run as ONE execution.

-- ── mastery_events — one row per signal ──────────────────────────────────────
-- source: where the signal came from ('tutor' now; 'quiz' reserved so graded
--   evidence can be logged here too later without a schema change).
-- signal: 'engaged' (participated in a coach exchange — weight 0, it's practice
--   not proof), 'correct'/'incorrect' (reserved for demonstrated understanding).
-- Removed with the account via ON DELETE CASCADE from the student's profile.
create table if not exists public.mastery_events (
  id          uuid primary key default gen_random_uuid(),
  student_id  uuid not null references public.profiles(id) on delete cascade,
  book_id     uuid not null,
  chapter_num int  not null,
  source      text not null check (source in ('tutor','quiz')),
  signal      text not null check (signal in ('engaged','correct','incorrect')),
  weight      real not null default 1,
  detail      text,   -- e.g. the question that prompted the signal
  created_at  timestamptz not null default now()
);
create index if not exists mastery_events_lookup
  on public.mastery_events (student_id, book_id, chapter_num);

alter table public.mastery_events enable row level security;
-- A student may READ their own signals (self-reflection / their recap). Writes
-- are service-role only (the tutor route inserts them); no client writes.
drop policy if exists mastery_events_student_read on public.mastery_events;
create policy mastery_events_student_read on public.mastery_events
  for select using (student_id = auth.uid());
revoke insert, update, delete on public.mastery_events from anon, authenticated;

-- ── summary helper (service-role) ────────────────────────────────────────────
-- Collapse a student's events for one chapter into the counts the mastery score
-- needs (see scoreMastery in models.ts). One round-trip; SECURITY DEFINER so the
-- recap can call it with the service role regardless of RLS.
create or replace function public.tutor_mastery_summary(
  p_student uuid, p_book uuid, p_chapter int
) returns table (engaged int, correct int, incorrect int, last_at timestamptz)
  language sql stable security definer set search_path = public as $$
  select
    count(*) filter (where signal = 'engaged')::int,
    count(*) filter (where signal = 'correct')::int,
    count(*) filter (where signal = 'incorrect')::int,
    max(created_at)
  from public.mastery_events
  where student_id = p_student and book_id = p_book and chapter_num = p_chapter
$$;
revoke all on function public.tutor_mastery_summary(uuid, uuid, int) from anon, authenticated;
