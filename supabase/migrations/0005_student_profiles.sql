-- SketchCast AI — student identity + teacher roster visibility (Phase A)
-- ----------------------------------------------------------------------------
-- Invited students are provisioned server-side (service role): login is a
-- name-derived ID (stored as profiles.username, backed by a synthetic auth
-- email), the parent's email is kept for communication only, and the first
-- login is flagged for a forced password reset (enforced in a later phase).
-- Adds a policy so a teacher can read the profiles of students enrolled in
-- their own classes (for the roster). Safe to run on the existing database.
-- ----------------------------------------------------------------------------

alter table profiles add column if not exists username text unique;
alter table profiles add column if not exists parent_email text;
alter table profiles add column if not exists must_reset_password boolean not null default false;

-- Teacher reads the profiles of students enrolled in any class they teach.
drop policy if exists profiles_teacher_read on profiles;
create policy profiles_teacher_read on profiles for select
  using (id in (
    select e.student_id from enrollments e
    join classes c on c.id = e.class_id
    where c.teacher_id = auth.uid()
  ));
