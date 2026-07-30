-- 0067 — Enrollments become READ-ONLY to user sessions.
--
-- THE HOLE (pre-existing since 0001/0008, closed here):
--   1. classes_owner_all (0001) is FOR ALL with check (teacher_id = auth.uid())
--      — ANY authenticated user can create a class naming themselves teacher.
--   2. enroll_teacher_all (0001, re-expressed in 0008) is FOR ALL with check
--      owns_class(class_id) — the owner of that class can then insert an
--      enrollment row carrying ANY student_id.
-- So teaches_student(S) is SELF-GRANTABLE for an arbitrary student uuid: make a
-- class, enroll the victim into it, and every "their teacher may read it"
-- policy opens. Today that leaks student profiles (profiles_teacher_read,
-- 0008); with the 0066 diary it would expose parents_only rows — health notes
-- and safeguarding concerns — through diary_teacher_of.
--
-- THE FIX: sever link 2. Nothing writes enrollments through a user session.
-- The ONLY enrollment write in the app is src/app/api/students/route.ts
-- (createAdminClient → service role, bypasses RLS); /api/children,
-- /api/delete-student and /api/reset-password are service-role too, and
-- scripts/seed-school.ts runs on SUPABASE_SERVICE_ROLE_KEY. classes.join_code
-- is display-only — there is no self-join flow anywhere. So client-side
-- enrollment writes have ZERO legitimate callers and this is behaviour-neutral:
-- teachers keep reading their rosters, the service role keeps writing them.
--
-- Link 1 is deliberately LEFT ALONE: class creation genuinely IS client-side
-- (src/app/dashboard/classes-card.tsx inserts into classes under the caller's
-- session), so restricting classes INSERT would break the product. Severing
-- link 2 is enough — a self-made class with no enrollable victims grants
-- nothing, since owns_class() only ever answers for classes you made and
-- teaches_student() needs a row this migration makes unwritable.
--
-- Every other enrollments policy stays as-is: enroll_student_read (0001),
-- enroll_admin_read + enroll_coord_read (0009), enroll_parent_read (0018).
-- Run as ONE execution. Idempotent, additive.

-- The 0008 policy, minus its write half. Same USING expression, same helper.
drop policy if exists enroll_teacher_all on public.enrollments;
drop policy if exists enroll_teacher_read on public.enrollments;
create policy enroll_teacher_read on public.enrollments for select
  using (owns_class(class_id));

-- Belt and braces (the 0010 column-grant doctrine, table-wide): with no
-- INSERT/UPDATE/DELETE policy left, RLS already denies those by default —
-- dropping the grants means a future permissive policy can't reopen the hole by
-- accident. service_role and the table owner are unaffected; re-granting is one
-- line if a genuine self-enroll flow (a join_code redemption, say) ever ships,
-- and it should arrive with its own scoped policy.
revoke insert, update, delete on public.enrollments from anon, authenticated;
