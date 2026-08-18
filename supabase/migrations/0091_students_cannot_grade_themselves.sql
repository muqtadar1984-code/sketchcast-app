-- 0091 — A student session can no longer author its own grade, erase its own
-- attempt history, or write the teacher's feedback.
--
-- ═══ POSITION IN SEQUENCE: 2 of 2, APPLY LAST, AFTER THE APP DEPLOY ═══
--
--   0090  →  deploy the quiz-integrity app build  →  0091 (this file)
--
-- IF APPLIED BEFORE THE APP DEPLOY: the student dashboard that is live today
-- upserts INTERACTIVE submissions (mode='interactive', with a client-computed
-- auto_score) straight from the browser, and files a mode='file' row that does
-- not null `feedback` or pin `attempt_count`. Every one of those writes is
-- refused here with 42501, so quizzes and file submissions break for every
-- student until the new build is live. Deploy first, then apply this.
--
-- IF APPLIED WITHOUT 0090: the policies below reference attempt_count and the
-- CREATE fails with 42703. That is deliberate — it fails loudly instead of
-- creating a policy that silently omits the pin. (Confirmed against prod on
-- 2026-08-19: submissions still has no attempt_count column, so 0090 is
-- genuinely unapplied and this ordering is not hypothetical.)
--
-- RESIDUAL EXPOSURE BETWEEN THE APP DEPLOY AND THIS FILE LANDING. The window is
-- deliberate — it is the price of a safe deploy order — but it is not empty,
-- and it must be measured in minutes, not days. Until this file is applied,
-- sub_student_rw is STILL LIVE on prod exactly as read off it below: PERMISSIVE
-- FOR ALL, qual and with_check both `student_id = auth.uid()`, over
-- table-level grants that give `authenticated` INSERT and UPDATE on every
-- column. So for the length of the window ANY signed-in student can still, in
-- one PostgREST call, write teacher_score/feedback/grade_status/graded_by on
-- their own row, overwrite their own interactive submission with a clean file
-- row (erasing the score, the answers and attempt_count), re-parent a row to
-- another generation, or DELETE the row outright. The new build simply stops
-- DOING those things; it cannot stop them being done, because RLS is the only
-- thing that could and it is the thing not yet applied. Two consequences worth
-- stating: MAX_INTERACTIVE_ATTEMPTS is unenforceable until this lands (the
-- counter it reads is student-writable), and the anon role holds the same
-- column grants, so the window is not gated on being a student. Apply this
-- immediately after the deploy is confirmed live, not at the end of the day.
--
-- Idempotent: every policy is dropped-if-exists before it is created, the
-- trigger function is CREATE OR REPLACE, and the trigger itself is
-- dropped-if-exists before it is created.
--
--
-- WHAT WAS TRUE UNTIL NOW (read off prod, 2026-08-19):
--
--   policy  sub_student_rw  on public.submissions
--           FOR ALL  qual/with_check  (student_id = auth.uid())
--
--   grants  authenticated holds INSERT and UPDATE on EVERY column of
--           submissions — teacher_score, feedback, grade_status, graded_by,
--           graded_at, and (once 0090 lands) attempt_count included. Grants on
--           this table are TABLE-LEVEL, not column-level, so there is no
--           privilege layer under RLS to fall back on: whatever the policies
--           do not constrain, a student session may write. No trigger
--           re-derives a score from the answer key.
--
-- Put together: any signed-in student could write a finished grade for
-- themselves in one PostgREST call. Nothing in the app did that — the browser
-- computed `auto` in quiz-player.tsx and upserted it — but the browser was the
-- only thing deciding, and the browser belongs to the student. Marks were
-- self-asserted, and the answer key was being handed out alongside (see the
-- app-side half of this fix: /api/quiz/[generationId]).
--
-- WHAT CHANGES. Interactive rows are now written ONLY by the service role,
-- from POST /api/quiz/submit, which grades server-side against questions.json.
-- The student session keeps exactly the one write it still legitimately needs:
-- filing its OWN file submission after uploading to storage. RLS cannot
-- restrict columns, but a WITH CHECK can insist the RESULTING ROW carries no
-- marks — the same protection without touching grants, and it fails closed for
-- any column combination:
--
--   * mode must be 'file' and file_path must be present  → no interactive rows,
--     no empty placeholder rows;
--   * grade_status must be 'pending'                     → a student cannot
--     declare their own work graded;
--   * auto_score, max_score, teacher_score, graded_by, graded_at and answers
--     must all be NULL                                   → no mark of any kind,
--     from any source, may originate in a browser session;
--   * feedback must be NULL                              → the teacher-feedback
--     column is written by grade-list.tsx and by nothing else. It was left open
--     in the first draft of this migration: a student could put arbitrary text
--     into the field a parent reads as their teacher's words;
--   * attempt_count must be 0                            → a student cannot
--     reset, inflate, or launder the in-app attempt counter that the submit
--     route's cap is enforced against.
--
-- THE UPDATE POLICY'S `using` NOW READS mode='file' TOO, AND THAT IS THE LOAD-
-- BEARING CLAUSE. The unique key is (generation_id, student_id) — ONE row per
-- student per generation — so with ownership-only `using`, a student could
-- UPSERT a clean file row OVER their own interactive submission and wipe the
-- score, the answers and attempt_count in a single call. "attempt_count is
-- evidence a teacher can see" is worth nothing if the student can erase the
-- evidence. Requiring the EXISTING row to be mode='file' means a student write
-- can never touch an interactive submission at all:
--
--   * quiz in-app, then upload a file for the same item → REFUSED (42501). The
--     dashboard catches this and says so in the student's own language; a
--     teacher who genuinely wants a file instead can clear the row.
--   * file, then quiz in-app → allowed. That path runs through the service
--     role, which bypasses RLS.
--
-- The mark-bearing columns are nulled EXPLICITLY by student-item.tsx on every
-- file submit — `feedback` included as of this migration. That matters for a
-- resubmit after grading: an upsert that merely OMITTED teacher_score would
-- leave the old mark in place and be refused here. Nulling is also the honest
-- reading of a resubmit — new work, not yet marked, and the old feedback was
-- written about answers that no longer exist.
--
-- WHAT IS DELIBERATELY REMOVED. sub_student_rw was FOR ALL, so it also granted
-- DELETE. Splitting it into SELECT/INSERT/UPDATE drops that, on purpose: no app
-- code deletes a submission from a student session (account deletion runs
-- through the admin client in /api/delete-student), and "delete the row and
-- resubmit" was the last remaining way to make an inconvenient mark disappear.
-- Retakes do not need it — a retake is an UPDATE of the same
-- (generation_id, student_id) row by the service role.
--
-- RE-PARENTING: WHY A TRIGGER AND NOT A POLICY. The first draft of this
-- migration wrote off `id` and `generation_id` as harmless because "neither
-- carries a mark". That reasoning was wrong, and it was wrong in the one way
-- that matters: the unique key is (generation_id, student_id), so generation_id
-- is not a mere attribute, it is half the row's IDENTITY. A student whose file
-- submission has been GRADED can UPDATE that row's generation_id to another
-- generation they are assigned. The row passes `using` (still their own,
-- still mode='file') and passes `with check` (still unmarked once the mark
-- columns are nulled, which the same statement does) — and the graded slot at
-- the original (generation_id, student_id) is now EMPTY. The teacher's view of
-- that assignment shows no submission at all, rather than a resubmission, and
-- the mark is detached from the work it was given for. Same shape as the
-- interactive-overwrite hole the `using` clause above closes, reached through
-- the key instead of through `mode`.
--
-- The repo's usual lever does not reach this. Column-scoped GRANTs are per
-- ROLE, and teachers and students are both `authenticated` — there is no role
-- boundary to hang a column privilege on, which is also why every protection in
-- this file is a WITH CHECK rather than a REVOKE. And a policy cannot express
-- it either: RLS compares the OLD row (`using`) and the NEW row (`with check`)
-- against the CALLER, never against EACH OTHER, so "generation_id must not
-- change" is simply not sayable in a policy. A BEFORE UPDATE trigger is the
-- only construct that sees both rows.
--
-- It is also the right SCOPE. Re-parenting a submission is not a thing anyone
-- legitimately does — not a student, not a teacher, and not the service role.
-- /api/quiz/submit re-writes generation_id and student_id on every retake, but
-- always to the values it filtered on, so IS DISTINCT FROM is false and the
-- trigger never fires on it; student-item.tsx upserts on the same conflict key,
-- so those two columns are unchanged there by construction; grade-list.tsx
-- targets `.eq("id", id)` and touches neither. A trigger therefore costs the
-- app nothing and, unlike a policy, is not bypassed by the service role. `id`
-- is pinned in the same breath for the same reason: it is the row's identity,
-- nothing writes it after insert, and a re-key is a cheap way to make a
-- teacher's pending-grade list point at nothing.
--
-- THE OR-ESCAPE: WHY sub_teacher_grade NOW EXCLUDES THE CALLER'S OWN ROW.
-- Permissive policies are OR-ed, and — this is the part that is easy to get
-- wrong — Postgres evaluates the `with check` side INDEPENDENTLY of which
-- policy satisfied `using`. Nothing requires ONE policy to justify both halves.
-- So a student could satisfy `using` through sub_student_file_update (their own
-- file row) and satisfy `with check` through sub_teacher_grade, which asks only
-- that the RESULTING row belong to a generation they own — and gen_write lets
-- anyone own a generation (`owner_id = auth.uid()`, with book_id nullable, read
-- off prod 2026-08-19). Create a generation, file a clean file row against it,
-- then UPDATE it to teacher_score = full marks / grade_status = 'graded' /
-- feedback = anything: every pinned column above is skipped, because the
-- teacher policy's `with check` was the one that passed. The row is real, and
-- the parent portal and the diary both read it as a teacher's mark.
--
-- THE TWO FIXES INTERLOCK, AND NEITHER IS SUFFICIENT ALONE. The policy change
-- below turns on the caller's row being their OWN — so the obvious next move is
-- to make the RESULTING row somebody else's: keep `using` satisfied through
-- sub_student_file_update (the OLD row is the attacker's own file row) while
-- the NEW row names a VICTIM as student_id and a generation the attacker owns
-- as generation_id. sub_teacher_grade's `with check` would then be perfectly
-- happy, and the attacker would have planted a fabricated graded submission
-- into a row the victim's own diary reads back (sub_student_read). The identity
-- trigger is what makes that unsayable: student_id cannot move at all. Equally,
-- the trigger alone would not close the OR-escape, because grading a row you
-- created under a generation you own requires changing no identity column. One
-- covers what the other cannot express.
--
-- The fix is to make the two UPDATE policies MUTUALLY EXCLUSIVE instead of
-- merely different, so there is no row for which both can speak:
-- sub_student_file_update covers `student_id = auth.uid()`, and
-- sub_teacher_grade now carries `student_id <> auth.uid()` on BOTH sides. A
-- teacher marking someone else's work is untouched, which is the entirety of
-- what that policy is for; grading YOUR OWN submission is refused, which is the
-- name of this migration. (`<>` against a NULL auth.uid() yields NULL, so an
-- anonymous caller fails the policy — it fails closed, which matters because
-- `anon` holds the same column grants as `authenticated`.) The original
-- generation-ownership clause is preserved character for character; the only
-- change is the conjunct added in front of it.
--
-- WHAT REMAINS OPEN, KNOWINGLY. `submitted_at` is still writable by a student
-- on their own file rows, exactly as it was under sub_student_rw: a
-- self-reported timestamp on a file the teacher opens anyway. `file_path` is
-- writable too, but only to another path the student can already read, and the
-- storage policies are what bound that.
--
-- WHAT IS PRESERVED VERBATIM: sub_teacher_read, sub_parent_read, sub_coord_read,
-- sub_admin_read and the RESTRICTIVE submissions_not_suspended are all
-- untouched. sub_teacher_grade is re-created rather than left alone — see the
-- OR-escape section; its generation-ownership predicate is unchanged and only a
-- `student_id <> auth.uid()` conjunct is added. The service role bypasses RLS,
-- so the submit route is unaffected by the policies — but NOT by the trigger,
-- which is deliberate and which the submit route already satisfies.
--
-- WHAT ELSE WAS AUDITED FOR THE SAME OR-ESCAPE (prod, 2026-08-19). On
-- submissions after this file: INSERT has exactly one permissive policy
-- (sub_student_file_insert), so there is no second `with check` to borrow;
-- UPDATE has the two above, now disjoint on student_id; DELETE has no
-- permissive policy at all once sub_student_rw is gone, so every delete is
-- refused; the four remaining read policies are FOR SELECT and carry no
-- `with check`, and a SELECT policy can only narrow which rows an UPDATE sees,
-- never widen what it may write to. On student_progress: sp_student_rw is the
-- ONLY permissive policy with a `with check` (sp_teacher_read, sp_parent_read,
-- sp_coord_read and sp_admin_read are all FOR SELECT), so there is nothing to
-- OR it with and no escape exists. Worth recording, though it is not this
-- migration's business: sp_student_rw is FOR ALL and pins nothing beyond
-- ownership, so a student may freely write and DELETE their own progress rows.
-- That is the current design of self-reported progress, not a regression, and
-- it is left alone here rather than changed inside a security fix.

drop policy if exists sub_student_rw on public.submissions;

-- Reads are unchanged: a student may always see their own submissions (the
-- diary and the dashboard both depend on it).
drop policy if exists sub_student_read on public.submissions;
create policy sub_student_read on public.submissions
  for select
  using (student_id = auth.uid());

drop policy if exists sub_student_file_insert on public.submissions;
create policy sub_student_file_insert on public.submissions
  for insert
  with check (
    student_id = auth.uid()
    and mode = 'file'
    and file_path is not null
    and grade_status = 'pending'
    and answers is null
    and auto_score is null
    and max_score is null
    and teacher_score is null
    and feedback is null
    and graded_by is null
    and graded_at is null
    and attempt_count = 0
  );

-- Note the asymmetry with the UPDATE policy below: INSERT has no OLD row, so
-- `mode = 'file'` here is the only place that shape can be asserted.
-- `using` requires the EXISTING row to be a file submission, so an interactive
-- row is out of a student session's reach entirely — it can neither be graded
-- by its owner nor overwritten to destroy the score and the attempt count.
-- `with check` requires the RESULTING row to be an unmarked file submission,
-- so the row cannot be turned into an interactive one either.
drop policy if exists sub_student_file_update on public.submissions;
create policy sub_student_file_update on public.submissions
  for update
  using (
    student_id = auth.uid()
    and mode = 'file'
  )
  with check (
    student_id = auth.uid()
    and mode = 'file'
    and file_path is not null
    and grade_status = 'pending'
    and answers is null
    and auto_score is null
    and max_score is null
    and teacher_score is null
    and feedback is null
    and graded_by is null
    and graded_at is null
    and attempt_count = 0
  );

-- ── a submission's identity is immutable ───────────────────────────────────
--
-- The half no policy can express: OLD compared against NEW. See the
-- re-parenting section in the header for why this is a trigger, why it binds
-- the service role too, and why no live write path is affected by it.
--
-- SQLSTATE 42501 (insufficient_privilege) is chosen so the refusal is
-- indistinguishable from an RLS denial on the wire. student-item.tsx already
-- maps 42501 to a sentence a child can read instead of surfacing a raw SQLSTATE
-- — and since no legitimate flow re-parents a submission, the only caller that
-- can ever see that message is one trying to.
create or replace function public.submissions_identity_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
     or new.generation_id is distinct from old.generation_id
     or new.student_id is distinct from old.student_id then
    raise exception
      'A submission cannot be moved to a different id, generation or student.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

comment on function public.submissions_identity_immutable() is
  'BEFORE UPDATE on submissions: refuses any change to id, generation_id or student_id. The unique key is (generation_id, student_id), so re-parenting a GRADED row frees its slot and detaches the mark from the work it was given for. RLS cannot see OLD and NEW together, and column grants cannot separate teachers from students (both are `authenticated`), so this is a trigger — and it binds the service role as well, which is correct: nothing legitimately re-parents a submission.';

drop trigger if exists submissions_identity_immutable on public.submissions;
create trigger submissions_identity_immutable
  before update on public.submissions
  for each row execute function public.submissions_identity_immutable();

-- ── the teacher's grading policy no longer covers the caller's own row ──────
--
-- Re-created, not left verbatim: permissive WITH CHECKs are OR-ed and are
-- evaluated independently of which policy satisfied USING, so without the
-- `student_id <> auth.uid()` conjunct a student borrows this policy's WITH
-- CHECK to escape every column pin above. See the OR-escape section in the
-- header. The generation-ownership predicate below is the live prod definition
-- character for character; the conjunct in front of it is the only change.
drop policy if exists sub_teacher_grade on public.submissions;
create policy sub_teacher_grade on public.submissions
  for update
  using (
    student_id <> auth.uid()
    and generation_id in (
      select generations.id from generations where generations.owner_id = auth.uid()
    )
  )
  with check (
    student_id <> auth.uid()
    and generation_id in (
      select generations.id from generations where generations.owner_id = auth.uid()
    )
  );
