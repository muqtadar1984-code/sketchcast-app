-- SketchCast AI — School analytics: coordinator role + leadership read scope
-- ============================================================================
-- ⚠️  FLAGGED FOR REVIEW BEFORE PRODUCTION APPLY (touches roles + RLS on minors'
--     data). The web feature is gated behind FEATURE_SCHOOL_ANALYTICS (default
--     OFF); applying this migration alone changes NO behaviour until that flag
--     is on AND a user is given the coordinator role / a scope row.
--
-- What this adds (READ-ONLY analytics layer — no writes to generation, grading,
-- or student data):
--   1. A new `coordinator` role (enum value) — leadership that owns a SLICE.
--   2. `coordinator_scope` — maps a coordinator → (grade, optional subject)
--      slices within their school. This mapping IS the permission model.
--   3. `analytics_access_log` — DPDP audit trail of leadership viewing
--      student-level data.
--   4. Additive RLS so leadership can READ (never write) the existing progress
--      data, scoped by role:
--        * school_admin (= Principal/Admin) → whole school
--        * coordinator                      → their grade/subject slice only
--      Today school_admin has NO read on enrollments / generation_shares /
--      student_progress / submissions, so leadership can't compute completion;
--      these policies are what "roll the teacher view upward".
--
-- Scoping decision (pragmatic v1): classes carry `grade` but not `subject`, so
-- roster/student visibility scopes by GRADE; `subject` (when set) additionally
-- narrows content/teacher views (via books.subject). A pure cross-grade subject
-- coordinator is a follow-up (would need subject on classes).
--
-- NOTE: the policies/helpers below intentionally key off coordinator_scope
-- MEMBERSHIP, never the 'coordinator' enum literal, so this whole script runs in
-- one shot (Postgres forbids USING a freshly-added enum value in the same
-- transaction). The enum value still exists for app routing / role assignment.
-- Safe to run on the existing database (idempotent).
-- ============================================================================

-- 1. New role -----------------------------------------------------------------
alter type user_role add value if not exists 'coordinator';

-- 2. Coordinator scope mapping ------------------------------------------------
create table if not exists coordinator_scope (
  id             uuid primary key default gen_random_uuid(),
  coordinator_id uuid not null references profiles(id) on delete cascade,
  school_id      uuid not null references schools(id) on delete cascade,
  grade          text not null,                 -- one row per grade owned
  subject        text,                          -- null = all subjects in the grade
  created_at     timestamptz not null default now(),
  unique (coordinator_id, grade, subject)
);
create index if not exists coordinator_scope_coordinator_idx on coordinator_scope (coordinator_id);
create index if not exists coordinator_scope_school_idx on coordinator_scope (school_id);

-- 3. Access audit log (DPDP trail) --------------------------------------------
create table if not exists analytics_access_log (
  id          uuid primary key default gen_random_uuid(),
  actor_id    uuid not null references profiles(id) on delete cascade,
  actor_role  user_role,
  school_id   uuid references schools(id) on delete set null,
  scope       text not null,                    -- 'school_health' | 'at_risk' | 'teacher_detail' | 'student_detail'
  target_kind text,                             -- 'school' | 'grade' | 'class' | 'teacher' | 'student'
  target_id   uuid,                             -- viewed entity (null for pure aggregates)
  detail      jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists analytics_access_log_school_idx on analytics_access_log (school_id, created_at desc);
create index if not exists analytics_access_log_actor_idx on analytics_access_log (actor_id, created_at desc);

-- 4. SECURITY DEFINER scope helpers (bypass RLS internally → no recursion) -----
--    Coordinator helpers grant access purely by coordinator_scope membership.
create or replace function coordinates_class(cls uuid) returns boolean
  language sql stable security definer set search_path = public as
$$
  select exists (
    select 1 from classes c
    join coordinator_scope cs
      on  cs.coordinator_id = auth.uid()
      and cs.school_id = c.school_id
      and cs.grade = c.grade
    where c.id = cls
  )
$$;

create or replace function coordinates_student(stu uuid) returns boolean
  language sql stable security definer set search_path = public as
$$
  select exists (
    select 1 from enrollments e
    join classes c on c.id = e.class_id
    join coordinator_scope cs
      on  cs.coordinator_id = auth.uid()
      and cs.school_id = c.school_id
      and cs.grade = c.grade
    where e.student_id = stu
  )
$$;

-- A generation is in scope if it's assigned to a class the coordinator owns AND
-- (no subject filter, or the source book's subject matches the slice).
create or replace function coordinates_generation(gen uuid) returns boolean
  language sql stable security definer set search_path = public as
$$
  select exists (
    select 1
    from generation_shares gs
    join classes c on c.id = gs.class_id
    join coordinator_scope cs
      on  cs.coordinator_id = auth.uid()
      and cs.school_id = c.school_id
      and cs.grade = c.grade
    left join generations g on g.id = gs.generation_id
    left join books b on b.id = g.book_id
    where gs.generation_id = gen
      and (cs.subject is null or cs.subject = b.subject)
  )
$$;

create or replace function coordinates_profile(pid uuid) returns boolean
  language sql stable security definer set search_path = public as
$$
  select coordinates_student(pid)
      or exists (
        select 1 from classes c
        join coordinator_scope cs
          on  cs.coordinator_id = auth.uid()
          and cs.school_id = c.school_id
          and cs.grade = c.grade
        where c.teacher_id = pid
      )
$$;

-- Admin (Principal) school-scoped helpers for tables without a school_id column.
create or replace function admin_school_class(cls uuid) returns boolean
  language sql stable security definer set search_path = public as
$$
  select current_role_val() = 'school_admin'
     and exists (select 1 from classes c where c.id = cls and c.school_id = current_school_id())
$$;

create or replace function admin_school_gen(gen uuid) returns boolean
  language sql stable security definer set search_path = public as
$$
  select current_role_val() = 'school_admin'
     and exists (select 1 from generations g where g.id = gen and g.school_id = current_school_id())
$$;

-- 5. RLS on the new tables ----------------------------------------------------
alter table coordinator_scope     enable row level security;
alter table analytics_access_log  enable row level security;

-- coordinator_scope: the school admin manages it; a coordinator reads only own rows.
drop policy if exists cs_admin_all on coordinator_scope;
create policy cs_admin_all on coordinator_scope for all
  using (current_role_val() = 'school_admin' and school_id = current_school_id())
  with check (current_role_val() = 'school_admin' and school_id = current_school_id());
drop policy if exists cs_self_read on coordinator_scope;
create policy cs_self_read on coordinator_scope for select
  using (coordinator_id = auth.uid());

-- analytics_access_log: leadership appends its own access; admin reads the
-- school's trail; an actor reads their own entries. No updates/deletes.
drop policy if exists aal_insert_self on analytics_access_log;
create policy aal_insert_self on analytics_access_log for insert
  with check (actor_id = auth.uid());
drop policy if exists aal_admin_read on analytics_access_log;
create policy aal_admin_read on analytics_access_log for select
  using (current_role_val() = 'school_admin' and school_id = current_school_id());
drop policy if exists aal_self_read on analytics_access_log;
create policy aal_self_read on analytics_access_log for select
  using (actor_id = auth.uid());

-- 6. Additive leadership READ policies on existing data (never write) ----------
-- profiles: coordinator reads the students + teachers in their slice.
drop policy if exists profiles_coord_read on profiles;
create policy profiles_coord_read on profiles for select
  using (coordinates_profile(id));

-- classes: coordinator reads classes in their grade slice (admin already reads
-- the school via classes_school_read).
drop policy if exists classes_coord_read on classes;
create policy classes_coord_read on classes for select
  using (coordinates_class(id));

-- enrollments: admin reads the school's rows; coordinator reads their slice.
drop policy if exists enroll_admin_read on enrollments;
create policy enroll_admin_read on enrollments for select
  using (admin_school_class(class_id));
drop policy if exists enroll_coord_read on enrollments;
create policy enroll_coord_read on enrollments for select
  using (coordinates_class(class_id));

-- generation_shares: admin reads shares to the school's classes; coordinator theirs.
drop policy if exists shares_admin_read on generation_shares;
create policy shares_admin_read on generation_shares for select
  using (admin_school_class(class_id));
drop policy if exists shares_coord_read on generation_shares;
create policy shares_coord_read on generation_shares for select
  using (coordinates_class(class_id));

-- generations: coordinator reads content in their slice (admin already reads the
-- school via gen_read's school_admin clause).
drop policy if exists gen_coord_read on generations;
create policy gen_coord_read on generations for select
  using (coordinates_generation(id));

-- student_progress: admin reads the school's; coordinator their slice's students.
drop policy if exists sp_admin_read on student_progress;
create policy sp_admin_read on student_progress for select
  using (admin_school_gen(generation_id));
drop policy if exists sp_coord_read on student_progress;
create policy sp_coord_read on student_progress for select
  using (coordinates_generation(generation_id) and coordinates_student(student_id));

-- submissions: admin reads the school's; coordinator their slice's students.
drop policy if exists sub_admin_read on submissions;
create policy sub_admin_read on submissions for select
  using (admin_school_gen(generation_id));
drop policy if exists sub_coord_read on submissions;
create policy sub_coord_read on submissions for select
  using (coordinates_generation(generation_id) and coordinates_student(student_id));
