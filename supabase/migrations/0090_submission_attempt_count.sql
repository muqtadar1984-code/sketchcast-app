-- 0090 — submissions.attempt_count. ADDITIVE ONLY.
--
-- ═══ POSITION IN SEQUENCE: 1 of 2, APPLY FIRST, BEFORE THE APP DEPLOY ═══
--
--   0090 (this file)  →  deploy the quiz-integrity app build  →  0091
--
-- This is the expand half of an expand/contract pair. It was originally one
-- file with the policy tightening now in 0091, and that file had NO SAFE
-- DEPLOY ORDER:
--
--   * app before migration — /api/quiz/submit selects and writes
--     attempt_count, so every quiz submission would 500 (42703 on the select,
--     PGRST204 on the write) until the migration landed;
--   * migration before app — the CURRENTLY deployed student-item.tsx upserts
--     interactive rows straight from the browser, and the tightened policies
--     refuse exactly that, so quizzes would break for every student for the
--     length of the deploy.
--
-- Split, each half is safe on its own side of the deploy:
--
--   THIS FILE IS SAFE WITH THE OLD CLIENT LIVE. It only adds a nullable-by-
--   default column with a server default. Nothing reads it yet; the old client
--   never names it, so its upserts are unaffected; PostgREST just starts
--   returning one more field.
--
--   IF APPLIED OUT OF ORDER (i.e. after 0091): 0091's student policies pin
--   attempt_count, so they cannot even be created against a table that has no
--   such column — 0091 fails loudly with 42703 rather than half-applying.
--
-- Idempotent: re-running is a no-op.

-- Interactive (in-app quiz) attempts recorded for this (generation, student).
--
-- ZERO, not one, is the base: a mode='file' row has taken no in-app attempt,
-- and every pre-existing row predates server-side grading, so "0 attempts of
-- the graded kind" is the honest reading of the backfill. The counter is
-- therefore STRICTLY INCREASING on every interactive write from any starting
-- state, which is what lets /api/quiz/submit use it as an optimistic-lock
-- version column (see submitQuizWith) instead of a read-then-write it cannot
-- make atomic.
--
-- It is also the enforcement input for the per-student attempt cap
-- (MAX_INTERACTIVE_ATTEMPTS in src/app/api/quiz/logic.ts). That cap is only
-- real once 0091 lands: until then a student session can still overwrite its
-- own interactive row and reset this counter to the default.
alter table public.submissions
  add column if not exists attempt_count integer not null default 0;

comment on column public.submissions.attempt_count is
  'In-app quiz attempts recorded for this (generation, student). 0 for file submissions and for every row predating server-side grading. Written only by /api/quiz/submit under the service role; 0091 pins it to 0 in the student write policies. Also the optimistic-lock version column for the submit route.';
