-- SketchCast AI — verification for 0178 (worksheet practice on the student Board)
-- ============================================================================
-- Run in the SQL editor (or on a branch via the Supabase MCP) AFTER
-- 0178_sk_learn_practice.sql. Seeds a throwaway school: two teachers with a
-- class each, a student in each class, a parent linked to student 1, and a
-- worksheet generation per teacher; then proves:
--   1. the three tables exist with RLS on; sk_practice_help has no policies;
--   2. the attempt CHECKs hold (correct = outcome 'correct'; a help row has no
--      answer; an answer row is never 'help'; rung / question_type / time_ms
--      are constrained) and UNIQUE (session, generation, question,
--      attempt_no) refuses a second row for the same attempt;
--   3. the help cache's primary key refuses a second row for the same
--      question × hash × rung;
--   4. under RLS: student 1 reads only her own sessions and attempts, and no
--      help rows; her class teacher and her parent read her attempts; the
--      other class's teacher and student 2 do not; nobody authenticated can
--      write.
-- Every check RAISEs on failure; a clean run prints PASS lines and
-- "ALL 0178 CHECKS PASSED", then ROLLS BACK (nothing persists).
-- NOT YET RUN (written with the migration, 2026-10-31; run it on a branch
-- before 0178 is applied).
-- ============================================================================
begin;

create or replace function _expect(cond boolean, msg text) returns void
  language plpgsql as $$
begin
  if cond then raise notice 'PASS: %', msg;
  else raise exception 'FAIL: %', msg; end if;
end $$;

create or replace function _err(stmt text) returns text language plpgsql as $$
begin execute stmt; return 'ok'; exception when others then return sqlstate || ' ' || sqlerrm; end $$;

create or replace function _act_as(uid uuid) returns void
  language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid::text, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

do $$
declare
  S    uuid := '55555555-0178-0000-0000-00000000000a';   -- school
  t1   uuid := '55555555-0178-0000-0000-000000000011';   -- teacher of C1
  t2   uuid := '55555555-0178-0000-0000-000000000012';   -- teacher of C2
  st1  uuid := '55555555-0178-0000-0000-000000000021';   -- student in C1
  st2  uuid := '55555555-0178-0000-0000-000000000022';   -- student in C2
  pa1  uuid := '55555555-0178-0000-0000-000000000031';   -- parent of st1
  C1   uuid := '55555555-0178-0000-0000-0000000000c1';
  C2   uuid := '55555555-0178-0000-0000-0000000000c2';
  g1   uuid := '55555555-0178-0000-0000-0000000000a1';   -- t1's worksheet
  g2   uuid := '55555555-0178-0000-0000-0000000000a2';   -- t2's worksheet
  s1   uuid := '01999999-0178-7000-8000-000000000001';   -- st1's practice session
  s2   uuid := '01999999-0178-7000-8000-000000000002';   -- st2's practice session
  h    text := repeat('a', 64);
  t text; n bigint; r text;
begin
  -- ── 1. tables + RLS ──────────────────────────────────────────────────────
  foreach t in array array['sk_practice_sessions','sk_practice_attempts','sk_practice_help'] loop
    perform 1 from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = 'public' and c.relname = t and c.relrowsecurity;
    if not found then raise exception 'FAIL: % missing or RLS off', t; end if;
  end loop;
  raise notice 'PASS: three tables with RLS on';
  select count(*) into n from pg_policies where schemaname = 'public' and tablename = 'sk_practice_help';
  perform _expect(n = 0, 'sk_practice_help has no policies (service role only)');

  -- ── seed (gone at rollback) ───────────────────────────────────────────────
  insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at)
  select '00000000-0000-0000-0000-000000000000', u, 'authenticated', 'authenticated', u::text || '@t0178.invalid', now(), now()
    from unnest(array[t1, t2, st1, st2, pa1]) as u
  on conflict (id) do nothing;
  insert into schools (id, name) values (S, 'T0178 School') on conflict (id) do nothing;
  insert into profiles (id, role, school_id, full_name) values
    (t1, 'teacher', S, 'T0178 teacher one'), (t2, 'teacher', S, 'T0178 teacher two'),
    (st1, 'student', S, 'T0178 student one'), (st2, 'student', S, 'T0178 student two'),
    (pa1, 'parent', null, 'T0178 parent')
  on conflict (id) do update set role = excluded.role, school_id = excluded.school_id;
  insert into classes (id, name, grade, teacher_id, school_id) values (C1, '6A', '6', t1, S), (C2, '7A', '7', t2, S) on conflict (id) do nothing;
  insert into enrollments (class_id, student_id) values (C1, st1), (C2, st2) on conflict do nothing;
  insert into parent_links (parent_id, child_id, source) values (pa1, st1, 'school') on conflict do nothing;
  insert into generations (id, kind, owner_id, school_id, status) values
    (g1, 'worksheet', t1, S, 'done'), (g2, 'worksheet', t2, S, 'done') on conflict (id) do nothing;

  insert into public.sk_practice_sessions (id, student_id, kit_id) values (s1, st1, g1), (s2, st2, g2);

  -- ── 2. attempt constraints ────────────────────────────────────────────────
  insert into public.sk_practice_attempts (session_id, student_id, generation_id, question_id, question_type, kind, answer, outcome, correct, attempt_no, rung, hints_used, time_ms)
    values (s1, st1, g1, 'q1', 'fill_blank', 'answer', '"mitochondria"', 'incorrect', false, 1, 'hint', 0, 4200);
  insert into public.sk_practice_attempts (session_id, student_id, generation_id, question_id, question_type, kind, answer, outcome, correct, attempt_no, rung, hints_used)
    values (s1, st1, g1, 'q1', 'fill_blank', 'help', null, 'help', false, 2, 'step', 1);
  insert into public.sk_practice_attempts (session_id, student_id, generation_id, question_id, question_type, concept, kind, answer, outcome, correct, attempt_no, rung, hints_used)
    values (s1, st1, g1, 'q1', 'fill_blank', 'cell organelles', 'answer', '"chloroplast"', 'correct', true, 3, 'none', 2);
  insert into public.sk_practice_attempts (session_id, student_id, generation_id, question_id, question_type, kind, answer, outcome, correct, attempt_no)
    values (s2, st2, g2, 'q1', 'mcq', 'answer', '"B"', 'correct', true, 1);
  raise notice 'PASS: valid answer / help / correct rows insert';

  r := _err(format('insert into public.sk_practice_attempts (session_id, student_id, generation_id, question_id, question_type, kind, answer, outcome, correct, attempt_no) values (%L, %L, %L, ''q1'', ''fill_blank'', ''answer'', ''"x"'', ''incorrect'', false, 3)', s1, st1, g1));
  perform _expect(r like '23505%', 'a second row for the same session/question/attempt_no is refused (' || r || ')');
  r := _err(format('insert into public.sk_practice_attempts (session_id, student_id, generation_id, question_id, question_type, kind, answer, outcome, correct, attempt_no) values (%L, %L, %L, ''q2'', ''fill_blank'', ''answer'', ''"x"'', ''incorrect'', true, 1)', s1, st1, g1));
  perform _expect(r like '23514%', 'correct must equal outcome = correct (' || r || ')');
  r := _err(format('insert into public.sk_practice_attempts (session_id, student_id, generation_id, question_id, question_type, kind, answer, outcome, correct, attempt_no) values (%L, %L, %L, ''q2'', ''fill_blank'', ''help'', ''"x"'', ''help'', false, 1)', s1, st1, g1));
  perform _expect(r like '23514%', 'a help row carries no answer (' || r || ')');
  r := _err(format('insert into public.sk_practice_attempts (session_id, student_id, generation_id, question_id, question_type, kind, answer, outcome, correct, attempt_no) values (%L, %L, %L, ''q2'', ''fill_blank'', ''answer'', ''"x"'', ''help'', false, 1)', s1, st1, g1));
  perform _expect(r like '23514%', 'an answer row is never outcome help (' || r || ')');
  r := _err(format('insert into public.sk_practice_attempts (session_id, student_id, generation_id, question_id, question_type, kind, answer, outcome, correct, attempt_no, rung) values (%L, %L, %L, ''q2'', ''fill_blank'', ''answer'', ''"x"'', ''incorrect'', false, 1, ''solution'')', s1, st1, g1));
  perform _expect(r like '23514%', 'rung is constrained (' || r || ')');
  r := _err(format('insert into public.sk_practice_attempts (session_id, student_id, generation_id, question_id, question_type, kind, answer, outcome, correct, attempt_no) values (%L, %L, %L, ''q2'', ''essay'', ''answer'', ''"x"'', ''incorrect'', false, 1)', s1, st1, g1));
  perform _expect(r like '23514%', 'question_type is constrained (' || r || ')');
  r := _err(format('insert into public.sk_practice_attempts (session_id, student_id, generation_id, question_id, question_type, kind, answer, outcome, correct, attempt_no, time_ms) values (%L, %L, %L, ''q2'', ''short'', ''answer'', ''"x"'', ''incorrect'', false, 1, 99999999)', s1, st1, g1));
  perform _expect(r like '23514%', 'time_ms is clamped to an hour (' || r || ')');

  -- ── 3. the help cache key ─────────────────────────────────────────────────
  insert into public.sk_practice_help (generation_id, question_id, question_hash, rung, body, model, cost_usd)
    values (g1, 'q1', h, 'hint', 'Think about where photosynthesis happens.', 'claude-haiku-5-5', 0.000120);
  r := _err(format('insert into public.sk_practice_help (generation_id, question_id, question_hash, rung, body, model) values (%L, ''q1'', %L, ''hint'', ''again'', ''m'')', g1, h));
  perform _expect(r like '23505%', 'one cached help row per question/hash/rung (' || r || ')');
  r := _err(format('insert into public.sk_practice_help (generation_id, question_id, question_hash, rung, body, model) values (%L, ''q1'', ''short'', ''hint'', ''x'', ''m'')', g1));
  perform _expect(r like '23514%', 'question_hash must be a sha-256 hex (' || r || ')');

  -- ── 4. RLS ────────────────────────────────────────────────────────────────
  perform _act_as(st1);
  select count(*) into n from public.sk_practice_sessions;                    perform _expect(n = 1, 'student 1 sees only her own session');
  select count(*) into n from public.sk_practice_attempts where student_id = st1; perform _expect(n = 3, 'student 1 reads her own attempts');
  select count(*) into n from public.sk_practice_attempts where student_id = st2; perform _expect(n = 0, 'student 1 CANNOT read student 2''s attempts');
  r := _err('select count(*) from public.sk_practice_help');
  perform _expect(r like '42501%', 'student 1 cannot read the help cache (' || r || ')');
  r := _err(format('insert into public.sk_practice_attempts (session_id, student_id, generation_id, question_id, question_type, kind, answer, outcome, correct, attempt_no) values (%L, %L, %L, ''q9'', ''mcq'', ''answer'', ''"A"'', ''correct'', true, 1)', s1, st1, g1));
  perform _expect(r like '42501%', 'student 1 cannot write an attempt (' || r || ')');
  r := _err(format('update public.sk_practice_attempts set correct = true, outcome = ''correct'' where student_id = %L', st1));
  perform _expect(r like '42501%', 'student 1 cannot mark her own attempt right (' || r || ')');

  perform _act_as(t1);
  select count(*) into n from public.sk_practice_attempts where student_id = st1; perform _expect(n = 3, 'her class teacher reads her attempts');
  select count(*) into n from public.sk_practice_attempts where student_id = st2; perform _expect(n = 0, 'teacher 1 CANNOT read student 2 (another class)');
  select count(*) into n from public.sk_practice_sessions where student_id = st1; perform _expect(n = 1, 'her class teacher reads her session');

  perform _act_as(t2);
  select count(*) into n from public.sk_practice_attempts where student_id = st1; perform _expect(n = 0, 'teacher 2 CANNOT read student 1');
  select count(*) into n from public.sk_practice_attempts where student_id = st2; perform _expect(n = 1, 'teacher 2 reads her own student');

  perform _act_as(pa1);
  select count(*) into n from public.sk_practice_attempts where student_id = st1; perform _expect(n = 3, 'the linked parent reads her child''s attempts');
  select count(*) into n from public.sk_practice_attempts where student_id = st2; perform _expect(n = 0, 'the parent CANNOT read another child');

  perform _act_as(st2);
  select count(*) into n from public.sk_practice_attempts where student_id = st1; perform _expect(n = 0, 'student 2 CANNOT read student 1');

  raise notice '================ ALL 0178 CHECKS PASSED ================';
end $$;

rollback;
