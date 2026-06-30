-- SketchCast AI — RLS verification for 0009 (school analytics)
-- ============================================================================
-- Run in the Supabase SQL editor as its OWN execution, AFTER 0009_school_analytics.sql
-- has been applied in a SEPARATE earlier run (Postgres won't let you add the
-- `coordinator` enum value and use it in the same transaction). It seeds a
-- throwaway two-grade scenario, impersonates each role, and asserts the §7
-- visibility matrix — every check RAISEs on failure. A clean run prints
-- "ALL RLS CHECKS PASSED" and rolls back (nothing is persisted).
--
-- Scenario: school S, grades 6 and 7. Teacher t6 owns class C6 (grade 6) with
-- student st6; teacher t7 owns C7 (grade 7) with st7. Coordinator "co" is scoped
-- to grade 6 ONLY. Generation g6 is shared to C6, g7 to C7.
-- ============================================================================
begin;

create or replace function _expect(cond boolean, msg text) returns void
  language plpgsql as $$
begin
  if cond then raise notice 'PASS: %', msg;
  else raise exception 'FAIL: %', msg; end if;
end $$;

-- Impersonate a user under RLS: set the JWT sub, then switch to the authenticated
-- role so row-level security actually applies (the editor's own role bypasses it).
create or replace function _act_as(uid uuid) returns void
  language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid::text, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

do $$
declare
  S   uuid := '11111111-0000-0000-0000-000000000001';
  t6  uuid := '22222222-0000-0000-0000-000000000006';
  t7  uuid := '22222222-0000-0000-0000-000000000007';
  co  uuid := '33333333-0000-0000-0000-000000000006';
  ad  uuid := '44444444-0000-0000-0000-000000000001';
  st6 uuid := '55555555-0000-0000-0000-000000000006';
  st7 uuid := '55555555-0000-0000-0000-000000000007';
  C6  uuid := '66666666-0000-0000-0000-000000000006';
  C7  uuid := '66666666-0000-0000-0000-000000000007';
  g6  uuid := '77777777-0000-0000-0000-000000000006';
  g7  uuid := '77777777-0000-0000-0000-000000000007';
  n int;
begin
  -- Seed auth.users (the handle_new_user trigger makes a default profile each).
  insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at) values
    ('00000000-0000-0000-0000-000000000000', t6,  'authenticated','authenticated','t6.rlstest@example.com',  now(), now()),
    ('00000000-0000-0000-0000-000000000000', t7,  'authenticated','authenticated','t7.rlstest@example.com',  now(), now()),
    ('00000000-0000-0000-0000-000000000000', co,  'authenticated','authenticated','co.rlstest@example.com',  now(), now()),
    ('00000000-0000-0000-0000-000000000000', ad,  'authenticated','authenticated','ad.rlstest@example.com',  now(), now()),
    ('00000000-0000-0000-0000-000000000000', st6, 'authenticated','authenticated','st6.rlstest@example.com', now(), now()),
    ('00000000-0000-0000-0000-000000000000', st7, 'authenticated','authenticated','st7.rlstest@example.com', now(), now())
  on conflict (id) do nothing;

  insert into schools (id, name) values (S, 'RLS Test School') on conflict (id) do nothing;

  insert into profiles (id, role, school_id, full_name, username) values
    (t6,'teacher',S,'Teacher Six',null),
    (t7,'teacher',S,'Teacher Seven',null),
    (co,'coordinator',S,'Coordinator Six',null),
    (ad,'school_admin',S,'Principal',null),
    (st6,'student',S,'Student Six','st6rlstest'),
    (st7,'student',S,'Student Seven','st7rlstest')
  on conflict (id) do update set role = excluded.role, school_id = excluded.school_id, full_name = excluded.full_name, username = excluded.username;

  insert into classes (id, name, grade, teacher_id, school_id) values
    (C6,'6A','6',t6,S), (C7,'7A','7',t7,S) on conflict (id) do nothing;
  insert into enrollments (class_id, student_id) values (C6,st6),(C7,st7) on conflict do nothing;
  insert into generations (id, kind, owner_id, school_id, status) values
    (g6,'presentation',t6,S,'done'), (g7,'presentation',t7,S,'done') on conflict (id) do nothing;
  insert into generation_shares (generation_id, class_id, shared_by) values
    (g6,C6,t6), (g7,C7,t7) on conflict do nothing;
  insert into student_progress (generation_id, student_id, class_id, status) values
    (g6,st6,C6,'in_progress'), (g7,st7,C7,'completed') on conflict do nothing;
  insert into coordinator_scope (coordinator_id, school_id, grade) values (co,S,'6') on conflict do nothing;

  -- ── Coordinator (grade 6): sees grade-6 only, nothing in grade 7 ──────────
  perform _act_as(co);
  select count(*) into n from profiles           where id = st6;          perform _expect(n=1,'coord sees st6 profile');
  select count(*) into n from profiles           where id = st7;          perform _expect(n=0,'coord CANNOT see st7 profile (other grade)');
  select count(*) into n from classes            where id = C6;           perform _expect(n=1,'coord sees class C6');
  select count(*) into n from classes            where id = C7;           perform _expect(n=0,'coord CANNOT see class C7');
  select count(*) into n from enrollments        where student_id = st7;  perform _expect(n=0,'coord CANNOT see st7 enrollment');
  select count(*) into n from student_progress   where student_id = st6;  perform _expect(n=1,'coord sees st6 progress');
  select count(*) into n from student_progress   where student_id = st7;  perform _expect(n=0,'coord CANNOT see st7 progress');
  select count(*) into n from generations        where id = g7;           perform _expect(n=0,'coord CANNOT see g7 (grade 7 content)');
  select count(*) into n from profiles           where id = t6;           perform _expect(n=1,'coord sees teacher t6 (teaches grade 6)');
  select count(*) into n from profiles           where id = t7;           perform _expect(n=0,'coord CANNOT see teacher t7 (grade 7)');

  -- ── Principal (school_admin): whole-school read ───────────────────────────
  perform _act_as(ad);
  select count(*) into n from enrollments      where student_id in (st6,st7); perform _expect(n=2,'admin sees both enrollments (school-wide)');
  select count(*) into n from student_progress where student_id in (st6,st7); perform _expect(n=2,'admin sees both progress rows');

  -- ── Teacher t6: UNCHANGED — own class only ────────────────────────────────
  perform _act_as(t6);
  select count(*) into n from student_progress where student_id = st6; perform _expect(n=1,'teacher t6 sees own student progress');
  select count(*) into n from student_progress where student_id = st7; perform _expect(n=0,'teacher t6 CANNOT see st7 (other teacher)');
  select count(*) into n from profiles         where id = st7;         perform _expect(n=0,'teacher t6 CANNOT see st7 profile');

  -- ── Student st6: cannot see any other student ─────────────────────────────
  perform _act_as(st6);
  select count(*) into n from profiles         where id = st7;         perform _expect(n=0,'student st6 CANNOT see st7 profile');
  select count(*) into n from student_progress where student_id = st7; perform _expect(n=0,'student st6 CANNOT see st7 progress');
  select count(*) into n from student_progress where student_id = st6; perform _expect(n=1,'student st6 sees own progress');

  raise notice '================ ALL RLS CHECKS PASSED ================';
end $$;

rollback;
