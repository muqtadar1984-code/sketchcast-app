-- SketchCast AI — 0157: SK sessions, events, item attempts and mastery state
-- (SK plan B5 "Assessor": durable storage for the B4 teacher loop)
-- ============================================================================
-- Plan: "SketchCast SK AI Tutor - Architecture and Implementation Plan
-- 2026-10-26.md" §10 (data model: sessions, item_attempts, mastery_state),
-- §14 (only validated item→objective maps count; LLM grades are practice-only;
-- replay = event ids + unique keys) and §15 row B5. Contracts:
-- docs/SK-CONTRACTS.md §5 (event ids, the two unique keys, grading once per
-- (item, attempt_no), mastery recomputed from item_attempts by rule_version).
-- Tested on the Supabase BRANCH database `sk-b1` first (docs/SK-B5-REPORT.md);
-- NOT applied to production — that is a separate founder approval.
--
-- The four tables:
--
--   sk_sessions     one row per SK session: the student, the teaching graph
--                   (product id + chapter + graph version), the state machine
--                   (state, phase, cursor, bookmarks, rate — and the whole
--                   machine as jsonb so a resume is exact), the per-unit
--                   mastery map the loop renders, and the recent teacher
--                   turns. ONE OPEN session per student × product × chapter
--                   (partial unique index); opening another closes the old one.
--   sk_events       append-only, PRIMARY KEY (session_id, event_id) — the key
--                   IS the replay guard (contracts §5.3): a repeated event id
--                   returns the stored result and runs nothing. A row is
--                   inserted as `inflight` when the work is CLAIMED and filled
--                   in when it completes, so a concurrent duplicate finds the
--                   claim and waits instead of running the model twice; a
--                   failed run deletes its claim so the client's retry can run.
--   item_attempts   one row per graded attempt, UNIQUE (session_id, item_id,
--                   attempt_no) — grading runs once (contracts §5.6). Carries
--                   the item's teaching objective (resolved from
--                   topic_questions at insert; null = unmapped = NO mastery
--                   evidence, plan §14), the check it belongs to (check_key =
--                   the event that opened the check, check_size, purpose,
--                   unit_key), the grade (outcome, score/max, grader,
--                   rule_version), and the two integrity flags: `independent`
--                   (attempt 1, no hint, auto-marked — enforced by a CHECK) and
--                   `transcript_confirmed` (a spoken answer is graded only
--                   after the student confirmed the transcript — CHECK).
--   mastery_state   DERIVED, one row per student × teaching objective,
--                   recomputed from item_attempts by the mastery rule
--                   (src/sk/mastery.ts, rule_version 'sk-b5.1') after every
--                   attempt — never edited directly. `independent` can only be
--                   true on a `mastered` row (CHECK). `evidence` lists the
--                   attempt ids the status rests on, so every mastery value
--                   traces to its items (POC scorecard "mastery traceability").
--
-- Access: RLS on everywhere; the service role (the /api/sk routes through the
-- admin client) writes. Signed-in students may READ their own sessions,
-- attempts and mastery; nothing is writable from `authenticated`; sk_events
-- (which carry model output and transcripts) are not readable at all.
--
-- Retention: sk_events and item_attempts.response hold transcripts; the
-- 30-day sweep (plan §14) joins sk_retention_sweep() once 0158 is on main —
-- deferred, see docs/SK-B5-REPORT.md.
--
-- Additive only (expand-then-contract); rollback = 0157_sk_sessions_assessment_rollback.sql.
-- ============================================================================

begin;

-- ── 1. sessions ──────────────────────────────────────────────────────────────
create table if not exists public.sk_sessions (
  id             uuid        primary key,                 -- UUIDv7 minted by the app (contracts §5)
  student_id     uuid        not null references public.profiles(id) on delete cascade,
  product_id     text        not null,                    -- the teaching graph's product id (the book slug)
  chapter        int         not null check (chapter >= 1),
  graph_version  int         not null default 1 check (graph_version >= 1),
  status         text        not null default 'open' check (status in ('open', 'closed')),
  state          text        not null,                    -- the machine state name (plan §4), e.g. PAUSED
  phase          text        not null check (phase in ('GUIDE', 'TEACH', 'ASSESS')),
  cursor         jsonb       not null default '{}'::jsonb,   -- { graphVersion, unitKey, assetId, segmentId, t }
  bookmarks      jsonb       not null default '[]'::jsonb,   -- the bookmark stack (contracts §5.5)
  rate           numeric(4,2) not null default 1 check (rate > 0),
  machine        jsonb       not null,                    -- the whole MachineState (incl. the open check) — authoritative for resume
  mastery        jsonb       not null default '{}'::jsonb,   -- the loop's per-unit MasteryMap (what SK renders this session)
  history        jsonb       not null default '[]'::jsonb,   -- recent teacher turns for the Sonnet call's context
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  closed_at      timestamptz
);
create unique index if not exists sk_sessions_one_open
  on public.sk_sessions (student_id, product_id, chapter) where status = 'open';
create index if not exists sk_sessions_student_idx
  on public.sk_sessions (student_id, product_id, chapter, updated_at desc);
drop trigger if exists sk_sessions_touch on public.sk_sessions;
create trigger sk_sessions_touch before update on public.sk_sessions
  for each row execute function touch_updated_at();

-- ── 2. events (append-only; the primary key is the replay guard) ────────────
create table if not exists public.sk_events (
  session_id   uuid        not null references public.sk_sessions(id) on delete cascade,
  event_id     uuid        not null,                      -- client-generated UUIDv7
  status       text        not null default 'inflight' check (status in ('inflight', 'stored')),
  kind         text,                                      -- session | turn | command | answer … (null while inflight)
  result       jsonb       not null default 'null'::jsonb,   -- the stored result a duplicate replays
  claimed_at   timestamptz not null default now(),
  at           timestamptz,                               -- when the result was stored
  primary key (session_id, event_id),
  check (status = 'inflight' or (kind is not null and at is not null))
);
create index if not exists sk_events_session_at_idx on public.sk_events (session_id, at);

-- ── 3. item attempts (graded once per item × attempt) ───────────────────────
create table if not exists public.item_attempts (
  id                    uuid        primary key default gen_random_uuid(),
  event_id              uuid        not null,             -- the answer submission's event id
  session_id            uuid        not null references public.sk_sessions(id) on delete cascade,
  student_id            uuid        not null references public.profiles(id) on delete cascade,
  item_id               uuid        not null references public.topic_questions(id) on delete restrict,
  teaching_objective_id uuid        references public.teaching_objectives(id) on delete set null,
  attempt_no            int         not null check (attempt_no >= 1),
  response              jsonb,                            -- what the student answered (transcript text for spoken)
  outcome               text        not null check (outcome in ('correct', 'partial', 'incorrect', 'needs_review')),
  score                 numeric(6,2) not null default 0 check (score >= 0),
  max_score             numeric(6,2) not null default 1 check (max_score >= 0),
  independent           boolean     not null default false,
  hint_used             boolean     not null default false,
  hints_used            int         not null default 0 check (hints_used >= 0),
  modality              text        not null check (modality in ('typed', 'spoken')),
  transcript_confirmed  boolean     not null default false,
  grader                text        not null default 'deterministic' check (grader in ('deterministic', 'llm', 'teacher')),
  purpose               text        check (purpose in ('skip', 'prereq', 'unit', 'practise')),
  unit_key              text,
  check_key             uuid,                             -- the event that opened this check; null = outside any check
  check_size            int         check (check_size >= 1),
  rule_version          text        not null,             -- the grading rule (src/sk/grade.ts)
  at                    timestamptz not null default now(),
  unique (session_id, item_id, attempt_no),
  unique (session_id, event_id),
  -- independent evidence = attempt 1, no hint, auto-marked correct (plan §3, §10)
  check (independent = false or (attempt_no = 1 and hint_used = false and hints_used = 0 and outcome = 'correct' and grader = 'deterministic')),
  check (hint_used = (hints_used > 0)),
  -- a spoken answer is graded only after the student confirmed the transcript (plan §4 CONFIRM_TRANSCRIPT)
  check (modality = 'typed' or transcript_confirmed)
);
create index if not exists item_attempts_student_objective_idx
  on public.item_attempts (student_id, teaching_objective_id, at);
create index if not exists item_attempts_session_idx on public.item_attempts (session_id, at);

-- ── 4. mastery state (derived) ──────────────────────────────────────────────
create table if not exists public.mastery_state (
  student_id             uuid        not null references public.profiles(id) on delete cascade,
  teaching_objective_id  uuid        not null references public.teaching_objectives(id) on delete cascade,
  status                 text        not null check (status in ('unknown', 'in_progress', 'mastered', 'needs_work')),
  independent            boolean     not null default false,
  evidence               jsonb       not null default '{}'::jsonb,   -- { correct, total, attempt_ids[], runs[] }
  rule_version           text        not null,
  updated_at             timestamptz not null default now(),
  primary key (student_id, teaching_objective_id),
  check (independent = false or status = 'mastered')
);
create index if not exists mastery_state_objective_idx on public.mastery_state (teaching_objective_id, status);

-- ── 5. access ───────────────────────────────────────────────────────────────
alter table public.sk_sessions    enable row level security;
alter table public.sk_events      enable row level security;
alter table public.item_attempts  enable row level security;
alter table public.mastery_state  enable row level security;

revoke all on public.sk_sessions   from anon, authenticated;
revoke all on public.sk_events     from anon, authenticated;
revoke all on public.item_attempts from anon, authenticated;
revoke all on public.mastery_state from anon, authenticated;

-- students: their own sessions, attempts and mastery — read only
grant select on public.sk_sessions   to authenticated;
grant select on public.item_attempts to authenticated;
grant select on public.mastery_state to authenticated;

drop policy if exists sk_sessions_read_own on public.sk_sessions;
create policy sk_sessions_read_own on public.sk_sessions
  for select to authenticated using (student_id = auth.uid());

drop policy if exists item_attempts_read_own on public.item_attempts;
create policy item_attempts_read_own on public.item_attempts
  for select to authenticated using (student_id = auth.uid());

drop policy if exists mastery_state_read_own on public.mastery_state;
create policy mastery_state_read_own on public.mastery_state
  for select to authenticated using (student_id = auth.uid());

-- sk_events: no policies — service role only (model output and transcripts).

comment on table public.sk_sessions is 'SK: one teacher-loop session (plan §10). One OPEN row per student × product × chapter; the service role writes; students read their own.';
comment on table public.sk_events is 'SK: append-only events, PRIMARY KEY (session_id, event_id) = the replay guard (contracts §5). inflight = claimed, stored = done. Service role only.';
comment on table public.item_attempts is 'SK: one graded attempt, UNIQUE (session_id, item_id, attempt_no). teaching_objective_id null = unmapped = no mastery evidence (plan §14).';
comment on table public.mastery_state is 'SK: DERIVED from item_attempts by rule_version (src/sk/mastery.ts); never edited directly. independent only on mastered.';

commit;
