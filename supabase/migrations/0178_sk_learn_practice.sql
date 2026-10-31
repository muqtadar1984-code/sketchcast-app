-- SketchCast AI — 0178: worksheet practice on the student Board
-- (SK student Board plan 2026-10-31, phase 2 "Worksheet practice")
-- ============================================================================
-- A student practises her assigned worksheet on the Board, one question per
-- page: she types an answer, the server checks it against the answer key
-- (POST /api/present/learn/answer), and a wrong answer climbs a help ladder —
-- a HINT, then a WORKED STEP, then the ANSWER with a short explanation. Every
-- attempt is kept.
--
-- WHY NEW TABLES, NOT 0157's. 0157 (SK B5, applied 2026-10-27) holds the
-- teacher loop's sk_sessions / item_attempts / mastery_state. item_attempts
-- keys an attempt to a topic_questions row (item_id uuid FK) inside an
-- sk_sessions row (product, chapter, state machine). A worksheet question is
-- neither: it is an entry of a generation's questions.json ("q3"), and a
-- practice session is one Board opening of an assigned kit. The shapes here
-- follow 0157's conventions (service-role writes, an attempt number unique per
-- session, hints_used, created_at) so phase 4's mastery rule can fold these
-- rows in beside item_attempts without a rewrite.
--
-- The three tables:
--
--   sk_practice_sessions   one row per kit opening on the student Board. The
--                          id is the Board's learner session id (a uuid the
--                          client mints when the kit opens); the route
--                          creates the row on her first answer and refuses
--                          an id that belongs to another student.
--   sk_practice_attempts   one row per answer (or help request): which
--                          worksheet and question, the concept it tests (from
--                          the paper when it names one, else null), what she
--                          answered, whether it was right, the help rung the
--                          reply served, how many rungs she had seen before,
--                          and the time on the question. UNIQUE (session,
--                          generation, question, attempt_no) is the
--                          double-submit guard: a second request racing for
--                          the same attempt is refused (23505 → 429).
--   sk_practice_help       the CACHE of model-written help (Haiku 5.5): one
--                          row per question × rung × question_hash, so the
--                          second student to need a hint does not pay for it
--                          again. question_hash covers the question AND its
--                          key, so a re-generated paper never reuses a stale
--                          hint. Help the paper itself carries is read off the
--                          paper and never stored here.
--
-- ACCESS. RLS on everywhere; nothing is writable from `authenticated` (the
-- route writes through the service role, with the student id from the
-- verified session, never from the body). Reads follow the analytics pattern
-- of student_progress / submissions (0006, 0009, 0018):
--   * the student reads her own sessions and attempts;
--   * a teacher of any of her classes (teaches_student) and the owner of the
--     worksheet (the teacher who shared it) read them;
--   * her linked parent (is_parent_of) reads them;
--   * the school admin (admin_school_gen) and a coordinator whose slice holds
--     both the worksheet and the student read the attempts.
-- sk_practice_help has NO policies: the 'answer' rung carries the answer key
-- and a hint is only ever served by the route, at its rung.
--
-- Additive only; rollback = 0178_sk_learn_practice_rollback.sql.
-- Verification: supabase/tests/0178_sk_learn_practice_test.sql.
-- NOT APPLIED — a founder approval, like every migration.
-- ============================================================================

begin;

-- ── 1. practice sessions (one per kit opening) ───────────────────────────────
create table if not exists public.sk_practice_sessions (
  id          uuid        primary key,                       -- the Board's learner session id (client-minted)
  student_id  uuid        not null references public.profiles(id) on delete cascade,
  kit_id      uuid        not null references public.generations(id) on delete cascade,  -- the learner kit's id (its lesson video, else its first piece)
  started_at  timestamptz not null default now(),
  last_at     timestamptz not null default now()
);
create index if not exists sk_practice_sessions_student_idx
  on public.sk_practice_sessions (student_id, started_at desc);

-- ── 2. attempts (one row per answer or help request) ─────────────────────────
create table if not exists public.sk_practice_attempts (
  id             uuid        primary key default gen_random_uuid(),
  session_id     uuid        not null references public.sk_practice_sessions(id) on delete cascade,
  student_id     uuid        not null references public.profiles(id) on delete cascade,
  generation_id  uuid        not null references public.generations(id) on delete cascade,  -- the worksheet
  question_id    text        not null check (char_length(question_id) between 1 and 80),     -- questions.json id ("q3")
  question_type  text        not null check (question_type in ('fill_blank', 'short', 'true_false', 'match', 'mcq', 'subjective')),
  concept        text        check (concept is null or char_length(concept) between 1 and 200),  -- the concept / skill tag, when the paper names one
  kind           text        not null check (kind in ('answer', 'help')),                  -- help = she asked for help without answering
  answer         jsonb,                                                                    -- what she gave (null for a help request)
  outcome        text        not null check (outcome in ('correct', 'incorrect', 'review', 'help')),  -- review = a written answer her teacher marks
  correct        boolean     not null default false,
  attempt_no     int         not null check (attempt_no >= 1),                             -- per session × question, the server's count
  rung           text        not null default 'none' check (rung in ('none', 'hint', 'step', 'answer')),  -- the help this reply served
  hints_used     int         not null default 0 check (hints_used >= 0),                   -- help rungs she had seen on this question BEFORE this attempt
  time_ms        int         check (time_ms is null or time_ms between 0 and 3600000),     -- time on the question (client-measured, clamped)
  created_at     timestamptz not null default now(),
  unique (session_id, generation_id, question_id, attempt_no),
  check (correct = (outcome = 'correct')),
  check (kind = 'answer' or (answer is null and outcome = 'help')),
  check (kind = 'help' or outcome <> 'help')
);
create index if not exists sk_practice_attempts_student_idx
  on public.sk_practice_attempts (student_id, created_at desc);
create index if not exists sk_practice_attempts_generation_idx
  on public.sk_practice_attempts (generation_id, question_id);
create index if not exists sk_practice_attempts_session_idx
  on public.sk_practice_attempts (session_id, generation_id, question_id, attempt_no);

-- ── 3. the help cache (model-written hints / steps / explanations) ───────────
create table if not exists public.sk_practice_help (
  generation_id  uuid        not null references public.generations(id) on delete cascade,
  question_id    text        not null check (char_length(question_id) between 1 and 80),
  question_hash  text        not null check (char_length(question_hash) = 64),             -- sha-256 hex of the question + its key
  rung           text        not null check (rung in ('hint', 'step', 'answer')),
  body           text        not null check (char_length(body) between 1 and 2000),
  model          text        not null,
  cost_usd       numeric(10,6) not null default 0 check (cost_usd >= 0),
  created_at     timestamptz not null default now(),
  primary key (generation_id, question_id, question_hash, rung)
);

-- ── 4. access ────────────────────────────────────────────────────────────────
alter table public.sk_practice_sessions enable row level security;
alter table public.sk_practice_attempts enable row level security;
alter table public.sk_practice_help     enable row level security;

revoke all on public.sk_practice_sessions from anon, authenticated;
revoke all on public.sk_practice_attempts from anon, authenticated;
revoke all on public.sk_practice_help     from anon, authenticated;

grant select on public.sk_practice_sessions to authenticated;
grant select on public.sk_practice_attempts to authenticated;

-- sessions
drop policy if exists sk_practice_sessions_read_own on public.sk_practice_sessions;
create policy sk_practice_sessions_read_own on public.sk_practice_sessions
  for select to authenticated using (student_id = auth.uid());
drop policy if exists sk_practice_sessions_teacher_read on public.sk_practice_sessions;
create policy sk_practice_sessions_teacher_read on public.sk_practice_sessions
  for select to authenticated using (teaches_student(student_id));
drop policy if exists sk_practice_sessions_parent_read on public.sk_practice_sessions;
create policy sk_practice_sessions_parent_read on public.sk_practice_sessions
  for select to authenticated using (is_parent_of(student_id));

-- attempts
drop policy if exists sk_practice_attempts_read_own on public.sk_practice_attempts;
create policy sk_practice_attempts_read_own on public.sk_practice_attempts
  for select to authenticated using (student_id = auth.uid());
drop policy if exists sk_practice_attempts_teacher_read on public.sk_practice_attempts;
create policy sk_practice_attempts_teacher_read on public.sk_practice_attempts
  for select to authenticated
  using (teaches_student(student_id)
      or generation_id in (select id from public.generations where owner_id = auth.uid()));
drop policy if exists sk_practice_attempts_parent_read on public.sk_practice_attempts;
create policy sk_practice_attempts_parent_read on public.sk_practice_attempts
  for select to authenticated using (is_parent_of(student_id));
drop policy if exists sk_practice_attempts_admin_read on public.sk_practice_attempts;
create policy sk_practice_attempts_admin_read on public.sk_practice_attempts
  for select to authenticated using (admin_school_gen(generation_id));
drop policy if exists sk_practice_attempts_coord_read on public.sk_practice_attempts;
create policy sk_practice_attempts_coord_read on public.sk_practice_attempts
  for select to authenticated using (coordinates_generation(generation_id) and coordinates_student(student_id));

-- sk_practice_help: no policies — service role only (the 'answer' rung is the key).

comment on table public.sk_practice_sessions is 'SK student Board phase 2: one worksheet-practice session per kit opening (id = the Board learner session id). Service role writes; the student, her teachers and her parent read.';
comment on table public.sk_practice_attempts is 'SK student Board phase 2: one answer or help request on a worksheet question, checked on the server. UNIQUE (session, generation, question, attempt_no) is the double-submit guard. Service role writes.';
comment on table public.sk_practice_help is 'SK student Board phase 2: cache of model-written help per question × rung × question_hash (Haiku 5.5). Service role only — the answer rung carries the key.';

commit;
