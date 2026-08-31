-- 0099 — Present mode, Phase 3: the lesson AFTER the lesson.
--
-- 0097 made a lesson a ROW. This makes it a THING SOMEBODY ELSE CAN READ: a
-- one-or-two sentence note the teacher publishes, and the roll she wrote on,
-- exported once and parked in storage.
--
-- 0097 already declared the four columns this phase fills — pdf_path,
-- recap_draft, recap_body, recap_published_at — and every one of them has had
-- zero writers until now. So this migration adds almost no shape. What it adds
-- is the three things that shape cannot express on its own.
--
-- ── 1. THE RATE LIMIT, BECAUSE THE DRAFT COSTS MONEY AND NOT A CREDIT ────────
--
-- The plan is explicit that a recap consumes NO credit: a credit is one
-- generation (0075), and a two-sentence note about a lesson she has already
-- taught is not a generation. But "free" and "unmetered" are different words. A
-- panel with a stuck retry, or a teacher tapping Draft while she thinks, is an
-- unbounded spend on somebody else's API bill. Hence a monthly reservation,
-- cast in exactly the mould of tutor_sketch_reserve (0028) and tutor_tts_reserve
-- (0027): reserve BEFORE the call, atomically, so two concurrent taps cannot
-- both see room for the last one.
--
-- ── 2. YOU CANNOT PUBLISH NOTHING ───────────────────────────────────────────
--
-- recap_published_at without recap_body would be a published lesson note with
-- no note in it — a student opens the link and finds a blank page over a real
-- lesson. The constraint says so in the schema rather than in three routes.
-- Deliberately keyed on recap_BODY and not recap_draft: what the model wrote is
-- not what she published, and the whole draft/edit/publish shape exists so that
-- distinction survives.
--
-- ── 3. WHAT IS NOT HERE, AND WHY: NO STUDENT GRANT ──────────────────────────
--
-- 0097 said student visibility arrives "through a later migration, once there
-- is a published thing to reach them with". This is that migration, and it
-- still does not grant a student SELECT on present_sessions. That is the
-- decision, not an omission:
--
--   present_sessions holds recap_DRAFT in the same row as recap_BODY. A SELECT
--   policy is a row filter, not a column filter, so any grant that lets a
--   student read the published note also lets them read the unedited thing the
--   model wrote — including the sentence she deleted because it was wrong. RLS
--   cannot express "these two columns and not that one", and a view with its
--   own policies would be a second copy of the audience rule to keep in step
--   (0068 already has three copies of the notice audience rule and says so).
--
-- So the reader is served the way every other present_* row already is: through
-- the service role, in a route that re-checks the conditions in code — the same
-- doctrine as ownedSession() in src/utils/present/server.ts, which exists
-- because the service role bypasses RLS and something has to not. The three
-- conditions, ANDed, are in src/utils/present/audience.ts and unit-tested:
--
--   (a) the SESSION'S TEACHER is on the Present allowlist — feature visibility
--       is decided by the author, never by the reader. A student is never on
--       that list and must never need to be.
--   (b) recap_published_at is not null — and recap_body is served, never
--       recap_draft, never the live ink.
--   (c) the reader is enrolled in the session's class, is a verified parent of
--       someone who is, is the teacher herself, or is school leadership.
--
-- `revoke all ... from anon, authenticated` on all five present_* tables (0097)
-- therefore STAYS. Nothing about Phase 3 reaches PostgREST.
--
-- Additive + idempotent. Safe to re-run.

set local lock_timeout = '5s';

-- ── the draft's monthly ceiling ──────────────────────────────────────────────
-- Mould: tutor_sketch_usage (0028). Per account, per calendar month.
create table if not exists public.present_recap_usage (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  period     text not null,               -- 'YYYY-MM', computed by the caller
  count      int  not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, period)
);
alter table public.present_recap_usage enable row level security; -- service-role only
revoke all on public.present_recap_usage from anon, authenticated;

-- Atomic reservation: bump the counter ONLY if it stays within the cap, and
-- report whether it succeeded. Reserved BEFORE the model call, never after — a
-- reservation taken after the spend is a counter, not a limit, and two taps
-- landing together would both find room.
--
-- A refused draft costs her nothing she cannot recover: the note is optional,
-- the roll is already saved, and she can write the sentence herself. That is
-- why this fails closed without an escape hatch.
create or replace function public.present_recap_reserve(
  p_user uuid, p_period text, p_cap int
) returns boolean
  language plpgsql volatile security definer set search_path = public as $$
declare
  ok boolean;
begin
  insert into public.present_recap_usage (user_id, period, count)
    values (p_user, p_period, 0)
    on conflict (user_id, period) do nothing;

  update public.present_recap_usage
     set count = count + 1, updated_at = now()
   where user_id = p_user and period = p_period and count + 1 <= p_cap
   returning true into ok;

  return coalesce(ok, false);
end
$$;
-- No session role gets EXECUTE: only the service role calls this, from
-- /api/present/recap. Same treatment as calendar_events_for (0068).
revoke all on function public.present_recap_reserve(uuid, text, int) from public, anon, authenticated;

-- ── a published lesson note must have a note in it ───────────────────────────
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.present_sessions'::regclass
      and conname  = 'present_sessions_publish_needs_body'
  ) then
    alter table public.present_sessions
      add constraint present_sessions_publish_needs_body
      check (recap_published_at is null or recap_body is not null);
  end if;
end $$;

-- ── finding what a class may read ────────────────────────────────────────────
-- The student query is "published recaps for the classes I am enrolled in,
-- newest first". Partial, because the overwhelming majority of sessions are
-- unpublished and a student index has no business carrying them.
create index if not exists present_sessions_published_class_idx
  on public.present_sessions (class_id, recap_published_at desc)
  where recap_published_at is not null;

-- A teacher's own "lessons I have taught" list wants the same shape without the
-- class filter — she has sessions with no class at all.
create index if not exists present_sessions_published_teacher_idx
  on public.present_sessions (teacher_id, recap_published_at desc)
  where recap_published_at is not null;

comment on table public.present_recap_usage is
  'Present mode: monthly per-account ceiling on after-lesson recap drafts. A recap consumes NO credit — a credit is one generation and a note about a lesson already taught is not one — but free is not the same as unmetered. Reserved atomically BEFORE the model call, the mould of tutor_sketch_reserve (0028).';

comment on column public.present_sessions.recap_draft is
  'What the model wrote. NEVER served to a student: the draft/edit/publish shape exists so that the sentence she deleted stays deleted. Only recap_body is published.';

comment on column public.present_sessions.recap_body is
  'What she published, after editing. The only recap text any reader other than the author ever sees, and only once recap_published_at is set.';

comment on column public.present_sessions.pdf_path is
  'artifacts bucket, {teacher_id}/present/{session_id}/board.pdf. Derived server-side from the session row and NEVER taken from the client — the path is the authorization, since the artifacts storage policy keys on the first path segment being the owner uid.';
