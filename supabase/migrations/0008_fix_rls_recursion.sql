-- SketchCast AI — fix RLS infinite recursion (classes ↔ enrollments ↔ profiles)
-- ----------------------------------------------------------------------------
-- The 0001 policies classes_student_read and enroll_teacher_all reference each
-- other (classes → enrollments → classes → …). It never fired until the app
-- began reading `enrollments` (rosters / student dashboard) and 0005's
-- profiles_teacher_read subqueried them — then Postgres raises
-- "infinite recursion detected in policy", and authenticated reads of profiles
-- and classes silently return nothing. Re-express each cross-table check as a
-- SECURITY DEFINER helper (bypasses RLS internally → no policy re-entry → no
-- recursion). Safe to run on the existing database.
-- ----------------------------------------------------------------------------

create or replace function owns_class(cls uuid) returns boolean
  language sql stable security definer set search_path = public as
$$ select exists (select 1 from classes where id = cls and teacher_id = auth.uid()) $$;

create or replace function enrolled_in_class(cls uuid) returns boolean
  language sql stable security definer set search_path = public as
$$ select exists (select 1 from enrollments where class_id = cls and student_id = auth.uid()) $$;

create or replace function teaches_student(stu uuid) returns boolean
  language sql stable security definer set search_path = public as
$$ select exists (
     select 1 from enrollments e join classes c on c.id = e.class_id
     where e.student_id = stu and c.teacher_id = auth.uid()
   ) $$;

-- classes: students read classes they're enrolled in (helper, no recursion)
drop policy if exists classes_student_read on classes;
create policy classes_student_read on classes for select
  using (enrolled_in_class(id));

-- enrollments: the class's teacher manages its rows (helper, no recursion)
drop policy if exists enroll_teacher_all on enrollments;
create policy enroll_teacher_all on enrollments for all
  using (owns_class(class_id)) with check (owns_class(class_id));

-- profiles: a teacher reads the profiles of students they teach (helper)
drop policy if exists profiles_teacher_read on profiles;
create policy profiles_teacher_read on profiles for select
  using (teaches_student(id));
