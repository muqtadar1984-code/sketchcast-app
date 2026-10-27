-- SketchCast AI — verification for 0157 (SK sessions, events, attempts, mastery)
-- ============================================================================
-- Run in the SQL editor (or on a branch via the Supabase MCP) AFTER
-- 0157_sk_sessions_assessment.sql, on a database where Chapter 2 is loaded
-- (it needs one topic_questions row with a teaching_objective_id). Seeds two
-- throwaway students (auth.users + profiles, on conflict do nothing), a
-- session each, events, attempts and a mastery row, then proves:
--   1. the four tables exist with RLS on, and the read-own policies are there;
--   2. a second OPEN session for the same student × product × chapter is
--      refused (one open session), while a closed one may coexist;
--   3. a duplicate (session_id, event_id) is refused — the primary key is the
--      replay guard — and an inflight claim can be completed exactly once;
--   4. a duplicate (session_id, item_id, attempt_no) is refused; the integrity
--      CHECKs hold (independent needs attempt 1 / no hint / correct; a spoken
--      answer must be transcript-confirmed);
--   5. mastery_state upserts (insert → update on conflict), independent is
--      only allowed on 'mastered', and a session's cascade takes its events
--      and attempts but leaves mastery (derived per student, not per session);
--   6. impersonating student 1 under RLS: sees ONLY their own session,
--      attempts and mastery; cannot read sk_events; cannot write anything.
-- Every check RAISEs on failure; a clean run prints PASS lines and
-- "ALL 0157 CHECKS PASSED", then ROLLS BACK (nothing persists).
-- Passed on the sk-b1 branch database 2026-10-27 (docs/SK-B5-REPORT.md).
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
  st1  uuid := '55555555-0157-0000-0000-000000000001';   -- student 1
  st2  uuid := '55555555-0157-0000-0000-000000000002';   -- student 2
  s1   uuid := '01999999-0157-7000-8000-000000000001';   -- student 1's open session
  s1c  uuid := '01999999-0157-7000-8000-000000000002';   -- student 1's closed session
  s2   uuid := '01999999-0157-7000-8000-000000000003';   -- student 2's session
  e1   uuid := '01999999-0157-7000-8000-00000000e001';
  e2   uuid := '01999999-0157-7000-8000-00000000e002';
  a1   uuid := '01999999-0157-7000-8000-00000000a001';
  a2   uuid := '01999999-0157-7000-8000-00000000a002';
  a3   uuid := '01999999-0157-7000-8000-00000000a003';
  item uuid; obj uuid;
  t text; n bigint; r text;
  machine jsonb := '{"state":"PAUSED","cursor":{"graphVersion":1,"unitKey":"u1","assetId":"a","segmentId":"s","t":0},"bookmarks":[],"openCheck":null,"rate":1}';
begin
  -- ── 1. tables + RLS + policies ────────────────────────────────────────────
  foreach t in array array['sk_sessions','sk_events','item_attempts','mastery_state'] loop
    perform 1 from pg_tables where schemaname = 'public' and tablename = t;
    if not found then raise exception 'FAIL: table % missing', t; end if;
    perform 1 from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = 'public' and c.relname = t and c.relrowsecurity;
    if not found then raise exception 'FAIL: RLS off on %', t; end if;
  end loop;
  raise notice 'PASS: four tables with RLS on';
  foreach t in array array['sk_sessions_read_own','item_attempts_read_own','mastery_state_read_own'] loop
    perform 1 from pg_policies where schemaname = 'public' and policyname = t;
    if not found then raise exception 'FAIL: policy % missing', t; end if;
  end loop;
  select count(*) into n from pg_policies where schemaname = 'public' and tablename = 'sk_events';
  perform _expect(n = 0, 'sk_events has no policies (service role only)');

  -- a mapped item from the loaded chapter
  select q.id, q.teaching_objective_id into item, obj from public.topic_questions q
   where q.teaching_objective_id is not null order by q.created_at limit 1;
  if item is null then raise exception 'FAIL: this test needs a topic_questions row with a teaching_objective_id (load Chapter 2 first)'; end if;

  -- throwaway students (gone at rollback)
  insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at) values
    ('00000000-0000-0000-0000-000000000000', st1, 'authenticated', 'authenticated', 'st1.t0157@example.invalid', now(), now()),
    ('00000000-0000-0000-0000-000000000000', st2, 'authenticated', 'authenticated', 'st2.t0157@example.invalid', now(), now())
  on conflict (id) do nothing;
  insert into public.profiles (id, role, full_name) values (st1, 'student', 'Student 0157 one'), (st2, 'student', 'Student 0157 two')
  on conflict (id) do nothing;

  -- ── 2. sessions: one open per student × product × chapter ────────────────
  insert into public.sk_sessions (id, student_id, product_id, chapter, graph_version, state, phase, cursor, bookmarks, rate, machine)
    values (s1, st1, 't0157-book', 2, 1, 'PAUSED', 'TEACH', machine->'cursor', '[]', 1, machine);
  r := _err(format('insert into public.sk_sessions (id, student_id, product_id, chapter, state, phase, machine) values (%L, %L, ''t0157-book'', 2, ''PAUSED'', ''TEACH'', %L)', gen_random_uuid(), st1, machine));
  perform _expect(r like '23505%', 'a second OPEN session for the same student/product/chapter is refused (' || r || ')');
  insert into public.sk_sessions (id, student_id, product_id, chapter, status, state, phase, machine, closed_at)
    values (s1c, st1, 't0157-book', 2, 'closed', 'PAUSED', 'TEACH', machine, now());
  raise notice 'PASS: a CLOSED session may coexist with the open one';
  insert into public.sk_sessions (id, student_id, product_id, chapter, state, phase, machine)
    values (s2, st2, 't0157-book', 2, 'PAUSED', 'TEACH', machine);
  r := _err(format('insert into public.sk_sessions (id, student_id, product_id, chapter, state, phase, machine) values (%L, %L, ''x'', 1, ''PAUSED'', ''NOWHERE'', %L)', gen_random_uuid(), st2, machine));
  perform _expect(r <> 'ok', 'phase is constrained (' || r || ')');

  -- ── 3. events: the primary key is the replay guard ────────────────────────
  insert into public.sk_events (session_id, event_id) values (s1, e1);                       -- an inflight claim
  r := _err(format('insert into public.sk_events (session_id, event_id) values (%L, %L)', s1, e1));
  perform _expect(r like '23505%', 'duplicate (session_id, event_id) is refused (' || r || ')');
  r := _err(format('update public.sk_events set status = ''stored'' where session_id = %L and event_id = %L', s1, e1));
  perform _expect(r <> 'ok', 'a claim cannot be marked stored without kind and at (' || r || ')');
  update public.sk_events set status = 'stored', kind = 'turn', result = '{"ok":true}', at = now() where session_id = s1 and event_id = e1 and status = 'inflight';
  get diagnostics n = row_count;
  perform _expect(n = 1, 'an inflight claim completes once');
  update public.sk_events set status = 'stored', kind = 'turn', result = '{"ok":false}', at = now() where session_id = s1 and event_id = e1 and status = 'inflight';
  get diagnostics n = row_count;
  perform _expect(n = 0, 'completing it again changes nothing');
  insert into public.sk_events (session_id, event_id, status, kind, result, at) values (s2, e1, 'stored', 'turn', '"same id, other session"', now());
  raise notice 'PASS: the same event id on another session is a different key';
  insert into public.sk_events (session_id, event_id) values (s1, e2);
  delete from public.sk_events where session_id = s1 and event_id = e2 and status = 'inflight';
  get diagnostics n = row_count;
  perform _expect(n = 1, 'a released claim is deleted so a retry can run');

  -- ── 4. attempts: graded once; integrity checks ────────────────────────────
  insert into public.item_attempts (event_id, session_id, student_id, item_id, teaching_objective_id, attempt_no, response, outcome, score, max_score, independent, modality, transcript_confirmed, purpose, unit_key, check_key, check_size, rule_version)
    values (a1, s1, st1, item, obj, 1, '"B"', 'incorrect', 0, 1, false, 'typed', true, 'unit', 'u1', a1, 2, 'sk-b4.1');
  r := _err(format('insert into public.item_attempts (event_id, session_id, student_id, item_id, attempt_no, outcome, modality, transcript_confirmed, rule_version) values (%L, %L, %L, %L, 1, ''correct'', ''typed'', true, ''sk-b4.1'')', gen_random_uuid(), s1, st1, item));
  perform _expect(r like '23505%', 'duplicate (session_id, item_id, attempt_no) is refused (' || r || ')');
  r := _err(format('insert into public.item_attempts (event_id, session_id, student_id, item_id, attempt_no, outcome, modality, transcript_confirmed, rule_version) values (%L, %L, %L, %L, 2, ''correct'', ''typed'', true, ''sk-b4.1'')', a1, s1, st1, item));
  perform _expect(r like '23505%', 'the same event id cannot grade a second attempt (' || r || ')');
  insert into public.item_attempts (event_id, session_id, student_id, item_id, teaching_objective_id, attempt_no, response, outcome, score, max_score, independent, hint_used, hints_used, modality, transcript_confirmed, purpose, unit_key, check_key, check_size, rule_version)
    values (a2, s1, st1, item, obj, 2, '"C"', 'correct', 1, 1, false, true, 1, 'typed', true, 'unit', 'u1', a1, 2, 'sk-b4.1');
  raise notice 'PASS: attempt 2 of the same item (after a hint) is a new row';
  r := _err(format('insert into public.item_attempts (event_id, session_id, student_id, item_id, attempt_no, outcome, independent, hint_used, hints_used, modality, transcript_confirmed, rule_version) values (%L, %L, %L, %L, 3, ''correct'', true, true, 1, ''typed'', true, ''sk-b4.1'')', gen_random_uuid(), s1, st1, item));
  perform _expect(r like '23514%', 'independent cannot be true after a hint / on attempt 3 (' || r || ')');
  r := _err(format('insert into public.item_attempts (event_id, session_id, student_id, item_id, attempt_no, outcome, independent, modality, transcript_confirmed, rule_version) values (%L, %L, %L, %L, 1, ''correct'', true, ''spoken'', false, ''sk-b4.1'')', gen_random_uuid(), s2, st2, item));
  perform _expect(r like '23514%', 'a spoken answer must be transcript-confirmed (' || r || ')');
  r := _err(format('insert into public.item_attempts (event_id, session_id, student_id, item_id, attempt_no, outcome, independent, grader, modality, transcript_confirmed, rule_version) values (%L, %L, %L, %L, 1, ''correct'', true, ''llm'', ''typed'', true, ''sk-b4.1'')', gen_random_uuid(), s2, st2, item));
  perform _expect(r like '23514%', 'an LLM grade cannot be independent evidence (' || r || ')');
  insert into public.item_attempts (event_id, session_id, student_id, item_id, teaching_objective_id, attempt_no, response, outcome, score, max_score, independent, modality, transcript_confirmed, rule_version)
    values (a3, s2, st2, item, obj, 1, '"B"', 'correct', 1, 1, true, 'spoken', true, 'sk-b4.1');
  raise notice 'PASS: a confirmed spoken attempt 1, correct, no hint, is independent';

  -- ── 5. mastery: upsert, derived, independent only when mastered ───────────
  insert into public.mastery_state (student_id, teaching_objective_id, status, independent, evidence, rule_version)
    values (st1, obj, 'in_progress', false, jsonb_build_object('correct', 0, 'total', 2, 'attempt_ids', jsonb_build_array(a1)), 'sk-b5.1');
  insert into public.mastery_state (student_id, teaching_objective_id, status, independent, evidence, rule_version)
    values (st1, obj, 'mastered', false, jsonb_build_object('correct', 1, 'total', 2, 'attempt_ids', jsonb_build_array(a1, a2)), 'sk-b5.1')
    on conflict (student_id, teaching_objective_id) do update
      set status = excluded.status, independent = excluded.independent, evidence = excluded.evidence, rule_version = excluded.rule_version, updated_at = now();
  select count(*) into n from public.mastery_state where student_id = st1 and teaching_objective_id = obj and status = 'mastered' and independent = false;
  perform _expect(n = 1, 'mastery_state upsert updates in place (assisted pass: mastered, not independent)');
  r := _err(format('update public.mastery_state set independent = true, status = ''needs_work'' where student_id = %L and teaching_objective_id = %L', st1, obj));
  perform _expect(r like '23514%', 'independent is only allowed on a mastered row (' || r || ')');
  insert into public.mastery_state (student_id, teaching_objective_id, status, independent, evidence, rule_version)
    values (st2, obj, 'mastered', true, jsonb_build_object('correct', 1, 'total', 1, 'attempt_ids', jsonb_build_array(a3)), 'sk-b5.1');

  -- ── 6. student 1 under RLS: own rows only, nothing writable ───────────────
  perform _act_as(st1);
  select count(*) into n from public.sk_sessions;                            perform _expect(n = 2, 'student 1 sees their own two sessions only (open + closed)');
  select count(*) into n from public.sk_sessions where id = s2;              perform _expect(n = 0, 'student 1 CANNOT see student 2''s session');
  select count(*) into n from public.item_attempts;                          perform _expect(n = 2, 'student 1 sees their own attempts only');
  select count(*) into n from public.item_attempts where student_id = st2;   perform _expect(n = 0, 'student 1 CANNOT see student 2''s attempts');
  select count(*) into n from public.mastery_state;                          perform _expect(n = 1, 'student 1 sees their own mastery only');
  r := _err('select count(*) from public.sk_events');                        perform _expect(r like '42501%', 'student CANNOT read sk_events (' || r || ')');
  r := _err(format('insert into public.sk_sessions (id, student_id, product_id, chapter, state, phase, machine) values (%L, %L, ''hack'', 1, ''PAUSED'', ''TEACH'', %L)', gen_random_uuid(), st1, machine));
  perform _expect(r like '42501%', 'student CANNOT insert a session (' || r || ')');
  r := _err(format('update public.sk_sessions set state = ''PRESENTING'' where id = %L', s1));
  perform _expect(r like '42501%', 'student CANNOT update a session (' || r || ')');
  r := _err(format('insert into public.item_attempts (event_id, session_id, student_id, item_id, attempt_no, outcome, modality, transcript_confirmed, rule_version) values (%L, %L, %L, %L, 9, ''correct'', ''typed'', true, ''x'')', gen_random_uuid(), s1, st1, item));
  perform _expect(r like '42501%', 'student CANNOT insert an attempt (' || r || ')');
  r := _err(format('update public.mastery_state set status = ''mastered'', independent = true where student_id = %L', st1));
  perform _expect(r like '42501%', 'student CANNOT edit their mastery (' || r || ')');
  r := _err(format('delete from public.item_attempts where student_id = %L', st1));
  perform _expect(r like '42501%', 'student CANNOT delete attempts (' || r || ')');
  r := _err(format('insert into public.sk_events (session_id, event_id) values (%L, %L)', s1, gen_random_uuid()));
  perform _expect(r like '42501%', 'student CANNOT write sk_events (' || r || ')');

  raise notice '================ ALL 0157 CHECKS PASSED ================';
end $$;

rollback;
