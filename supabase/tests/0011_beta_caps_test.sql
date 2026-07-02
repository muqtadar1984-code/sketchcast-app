-- SketchCast AI — server-side cap verification for 0011 (teacher beta)
-- ============================================================================
-- Run in the Supabase SQL editor AFTER applying 0011_teacher_beta.sql. Seeds a
-- throwaway beta teacher + a normal teacher, then attempts to exceed every cap
-- with DIRECT table inserts as the editor's superuser role — the strongest
-- possible bypass attempt (stronger than any API call, which goes through the
-- same triggers). Every check RAISEs on failure; a clean run prints PASS lines
-- and "ALL BETA CAP CHECKS PASSED", then ROLLS BACK (nothing persists).
-- ============================================================================
begin;

create or replace function _expect_block(stmt text, needle text, msg text) returns void
  language plpgsql as $$
declare blocked boolean := false; errm text := '';
begin
  begin
    execute stmt;
  exception when others then
    blocked := true; errm := sqlerrm;
  end;
  if not blocked then
    raise exception 'FAIL (was NOT blocked): %', msg;
  end if;
  if position(needle in errm) = 0 then
    raise exception 'FAIL (wrong error "%"): %', errm, msg;
  end if;
  raise notice 'PASS (blocked): %', msg;
end $$;

create or replace function _expect_ok(stmt text, msg text) returns void
  language plpgsql as $$
begin
  execute stmt;
  raise notice 'PASS (allowed): %', msg;
end $$;

do $$
declare
  S   uuid := '11111111-0000-0000-0000-00000000b001';
  bt  uuid := '22222222-0000-0000-0000-00000000b001'; -- beta teacher
  nt  uuid := '22222222-0000-0000-0000-00000000b002'; -- normal teacher
  st1 uuid := '55555555-0000-0000-0000-00000000b001';
  st2 uuid := '55555555-0000-0000-0000-00000000b002';
  st3 uuid := '55555555-0000-0000-0000-00000000b003';
  bk1 uuid := '66666666-0000-0000-0000-00000000b001';
  cls uuid := '77777777-0000-0000-0000-00000000b001';
  cls2 uuid := '77777777-0000-0000-0000-00000000b002';
begin
  insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at)
  select '00000000-0000-0000-0000-000000000000', u, 'authenticated', 'authenticated',
         u::text || '@captest.example.com', now(), now()
  from unnest(array[bt, nt, st1, st2, st3]) as u
  on conflict (id) do nothing;

  insert into schools (id, name) values (S, 'Cap Test School') on conflict (id) do nothing;
  insert into profiles (id, role, school_id, beta_tester) values
    (bt, 'teacher', S, true),
    (nt, 'teacher', S, false),
    (st1, 'student', S, false), (st2, 'student', S, false), (st3, 'student', S, false)
  on conflict (id) do update set role = excluded.role, school_id = excluded.school_id,
    beta_tester = excluded.beta_tester;
  insert into classes (id, name, teacher_id, school_id) values
    (cls, 'Beta 5A', bt, S), (cls2, 'Beta 5B', bt, S) on conflict (id) do nothing;

  -- ── Cap 1: one book ────────────────────────────────────────────────────
  perform _expect_ok(
    format('insert into books (id, title, owner_id, school_id) values (%L, ''Book One'', %L, %L)', bk1, bt, S),
    'beta teacher uploads book 1');
  perform _expect_block(
    format('insert into books (title, owner_id, school_id) values (''Book Two'', %L, %L)', bt, S),
    'Beta is limited to 1 book', 'beta teacher blocked at book 2');

  -- ── Cap 2: one chapter, all kinds allowed for it ───────────────────────
  perform _expect_ok(
    format('insert into generations (kind, book_id, chapter_ref, owner_id, school_id) values (''presentation'', %L, ''0'', %L, %L)', bk1, bt, S),
    'beta: presentation for chapter 0');
  perform _expect_ok(
    format('insert into generations (kind, book_id, chapter_ref, owner_id, school_id) values (''worksheet'', %L, ''0'', %L, %L)', bk1, bt, S),
    'beta: another kind for the SAME chapter');
  perform _expect_block(
    format('insert into generations (kind, book_id, chapter_ref, owner_id, school_id) values (''presentation'', %L, ''1'', %L, %L)', bk1, bt, S),
    'Beta is limited to 1 chapter', 'beta blocked at a second chapter');

  -- ── Cap 3: two students ────────────────────────────────────────────────
  perform _expect_ok(
    format('insert into enrollments (class_id, student_id) values (%L, %L)', cls, st1),
    'beta: student 1 enrolled');
  perform _expect_ok(
    format('insert into enrollments (class_id, student_id) values (%L, %L)', cls, st2),
    'beta: student 2 enrolled');
  perform _expect_block(
    format('insert into enrollments (class_id, student_id) values (%L, %L)', cls, st3),
    'Beta is limited to 2 students', 'beta blocked at student 3');
  perform _expect_ok(
    format('insert into enrollments (class_id, student_id) values (%L, %L)', cls2, st1),
    'beta: existing student may join a second class');

  -- ── Non-beta teacher: completely unaffected ────────────────────────────
  perform _expect_ok(
    format('insert into books (title, owner_id, school_id) values (''N1'', %L, %L)', nt, S),
    'normal teacher book 1');
  perform _expect_ok(
    format('insert into books (title, owner_id, school_id) values (''N2'', %L, %L)', nt, S),
    'normal teacher book 2 (no cap)');

  -- ── Feedback: single submission enforced by UNIQUE ─────────────────────
  perform _expect_ok(
    format('insert into beta_feedback (teacher_id, overall, lesson_quality, deck_quality, ease_of_use) values (%L, 5, 4, 4, 5)', bt),
    'feedback submitted once');
  perform _expect_block(
    format('insert into beta_feedback (teacher_id, overall, lesson_quality, deck_quality, ease_of_use) values (%L, 3, 3, 3, 3)', bt),
    'duplicate key', 'second feedback submission blocked by unique constraint');

  raise notice '================ ALL BETA CAP CHECKS PASSED ================';
end $$;

rollback;
