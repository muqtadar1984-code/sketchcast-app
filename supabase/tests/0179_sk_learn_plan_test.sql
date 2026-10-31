-- SketchCast AI — verification for 0179 (concept tags, recommended plans, SK focus)
-- ============================================================================
-- Run in the SQL editor (or on a branch via the Supabase MCP) AFTER 0178 and
-- 0179. Seeds a throwaway school: teacher t1 with class C1 (student st1, whose
-- parent pa1 is linked), teacher t2 with class C2 (student st2), a home
-- student hs with her parent hp (no class), and kits; then proves:
--   1. the three tables exist with RLS on; the one-open-plan index holds;
--   2. tags: readable by whoever reads an attempt on the question, not others;
--   3. plans RLS: st1 reads only her APPROVED plans; t1 and pa1 read hers;
--      t2 and st2 do not; nobody authenticated writes a plan or a focus row;
--   4. sk_learn_plan_decide approver rules: t2, pa1 (school child: read-only),
--      st1 and a second teacher are refused; t1 may decide st1's plan; hp
--      decides hs's plan and may not "whole class" it;
--   5. edit: rewording passes; an item SK did not propose is refused;
--   6. approve: a practice item already assigned is "already", a next item
--      owned by the approver becomes a DIRECT share to st1, a re-teach item
--      becomes an sk_learn_focus row; the plan is approved with decided_*;
--      a second decision is refused (not_pending);
--   7. whole class: the next kit is shared to C1 and every C1 student gets the
--      focus row;
--   8. decline keeps the note and writes nothing else.
-- Every check RAISEs on failure; a clean run prints PASS lines and
-- "ALL 0179 CHECKS PASSED", then ROLLS BACK (nothing persists).
-- Dry-run against production 2026-10-31 inside BEGIN … ROLLBACK (founder-approved).
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

create or replace function _as_service() returns void
  language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{}', true);
  perform set_config('role', 'postgres', true);
end $$;

do $$
declare
  S    uuid := '55555555-0179-0000-0000-00000000000a';
  t1   uuid := '55555555-0179-0000-0000-000000000011';
  t2   uuid := '55555555-0179-0000-0000-000000000012';
  st1  uuid := '55555555-0179-0000-0000-000000000021';
  st2  uuid := '55555555-0179-0000-0000-000000000022';
  st3  uuid := '55555555-0179-0000-0000-000000000023';   -- st1's classmate in C1
  pa1  uuid := '55555555-0179-0000-0000-000000000031';
  hs   uuid := '55555555-0179-0000-0000-000000000041';   -- home student
  hp   uuid := '55555555-0179-0000-0000-000000000042';   -- her parent
  C1   uuid := '55555555-0179-0000-0000-0000000000c1';
  C2   uuid := '55555555-0179-0000-0000-0000000000c2';
  kit  uuid := '55555555-0179-0000-0000-0000000000a1';   -- t1's lesson (presentation)
  ws   uuid := '55555555-0179-0000-0000-0000000000a2';   -- t1's worksheet (assigned to C1)
  nxt  uuid := '55555555-0179-0000-0000-0000000000a3';   -- t1's next chapter (not assigned)
  hkit uuid := '55555555-0179-0000-0000-0000000000b1';   -- hp's kit
  hnx  uuid := '55555555-0179-0000-0000-0000000000b2';   -- hp's next kit
  s1   uuid := '01999999-0179-7000-8000-000000000001';
  pl1  uuid; pl2 uuid; pl3 uuid; pl4 uuid;
  h    text := repeat('b', 64);
  t text; n bigint; r text; j jsonb;
  its jsonb;
begin
  -- ── 1. tables ─────────────────────────────────────────────────────────────
  foreach t in array array['sk_practice_concepts','sk_learn_plans','sk_learn_focus'] loop
    perform 1 from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = 'public' and c.relname = t and c.relrowsecurity;
    if not found then raise exception 'FAIL: % missing or RLS off', t; end if;
  end loop;
  raise notice 'PASS: three tables with RLS on';

  -- ── seed ──────────────────────────────────────────────────────────────────
  insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at)
  select '00000000-0000-0000-0000-000000000000', u, 'authenticated', 'authenticated', u::text || '@t0179.invalid', now(), now()
    from unnest(array[t1, t2, st1, st2, st3, pa1, hs, hp]) as u
  on conflict (id) do nothing;
  insert into schools (id, name) values (S, 'T0179 School') on conflict (id) do nothing;
  insert into profiles (id, role, school_id, full_name) values
    (t1, 'teacher', S, 'T0179 t1'), (t2, 'teacher', S, 'T0179 t2'),
    (st1, 'student', S, 'T0179 st1'), (st2, 'student', S, 'T0179 st2'), (st3, 'student', S, 'T0179 st3'),
    (pa1, 'parent', null, 'T0179 pa1'), (hs, 'student', null, 'T0179 home'), (hp, 'parent', null, 'T0179 hp')
  on conflict (id) do update set role = excluded.role, school_id = excluded.school_id;
  insert into classes (id, name, grade, teacher_id, school_id) values (C1, '6A', '6', t1, S), (C2, '7A', '7', t2, S) on conflict (id) do nothing;
  insert into enrollments (class_id, student_id) values (C1, st1), (C1, st3), (C2, st2) on conflict do nothing;
  insert into parent_links (parent_id, child_id, source) values (pa1, st1, 'school'), (hp, hs, 'self') on conflict do nothing;
  -- Distinct `part`s: two presentations by one owner within 10 s are otherwise
  -- refused by reject_double_submit (0112) as a double click.
  insert into generations (id, kind, owner_id, school_id, status, params) values
    (kit, 'presentation', t1, S, 'done', '{"part":"1"}'), (ws, 'worksheet', t1, S, 'done', '{}'), (nxt, 'presentation', t1, S, 'done', '{"part":"2"}'),
    (hkit, 'presentation', hp, null, 'done', '{"part":"1"}'), (hnx, 'presentation', hp, null, 'done', '{"part":"2"}')
  on conflict (id) do nothing;
  insert into generation_shares (generation_id, class_id, shared_by) values (kit, C1, t1), (ws, C1, t1);
  insert into generation_shares (generation_id, student_id, shared_by) values (hkit, hs, hp);

  insert into public.sk_practice_sessions (id, student_id, kit_id) values (s1, st1, kit);
  insert into public.sk_practice_attempts (session_id, student_id, generation_id, question_id, question_type, kind, answer, outcome, correct, attempt_no)
    values (s1, st1, ws, 'q1', 'mcq', 'answer', '"B"', 'incorrect', false, 1);
  insert into public.sk_practice_concepts (generation_id, question_id, question_hash, concept_key, concept_name, method)
    values (ws, 'q1', h, 'c1', 'Cell organelles', 'manifest');
  r := _err(format('insert into public.sk_practice_concepts (generation_id, question_id, question_hash, concept_key, concept_name, method) values (%L, ''q1'', %L, ''c2'', ''x'', ''guess'')', ws, repeat('c', 64)));
  perform _expect(r like '23514%', 'tag method is constrained (' || r || ')');

  its := jsonb_build_array(
    jsonb_build_object('kind', 'reteach', 'title', 'Cell organelles', 'reason', 'Scored 35 over 4 questions', 'concept_key', 'c1', 'concept_name', 'Cell organelles', 'kit_id', kit),
    jsonb_build_object('kind', 'practice', 'title', 'Practise the worksheet again', 'reason', 'Two questions needed the answer', 'generation_id', ws),
    jsonb_build_object('kind', 'next', 'title', 'Tissues', 'reason', 'Next chapter', 'generation_id', nxt));
  insert into public.sk_learn_plans (student_id, kit_id, trigger, approver_role, class_id, approver_id, status, items, summary)
    values (st1, kit, 'kit_done', 'teacher', C1, t1, 'pending_approval', its, 'Re-teach organelles') returning id into pl1;
  r := _err(format('insert into public.sk_learn_plans (student_id, kit_id, trigger, approver_role, class_id, status) values (%L, %L, ''kit_done'', ''teacher'', %L, ''draft'')', st1, kit, C1));
  perform _expect(r like '23505%', 'one OPEN plan per student per kit (' || r || ')');
  r := _err(format('insert into public.sk_learn_plans (student_id, kit_id, trigger, approver_role, class_id, status) values (%L, %L, ''kit_done'', ''teacher'', %L, ''approved'')', st1, kit, C1));
  perform _expect(r like '23514%', 'an approved plan must carry decided_at (' || r || ')');
  insert into public.sk_learn_plans (student_id, kit_id, trigger, approver_role, approver_id, status, items)
    values (hs, hkit, 'kit_done', 'parent', hp, 'pending_approval',
            jsonb_build_array(jsonb_build_object('kind', 'next', 'title', 'Next', 'reason', 'r', 'generation_id', hnx),
                              jsonb_build_object('kind', 'reteach', 'title', 'Idea', 'reason', 'r', 'concept_key', 'k1', 'concept_name', 'Idea', 'kit_id', hkit)))
    returning id into pl2;

  -- ── 2. tags RLS ───────────────────────────────────────────────────────────
  perform _act_as(st1);
  select count(*) into n from public.sk_practice_concepts where generation_id = ws; perform _expect(n = 1, 'st1 reads the tag of a question she attempted');
  perform _act_as(t1);
  select count(*) into n from public.sk_practice_concepts where generation_id = ws; perform _expect(n = 1, 'her teacher reads the tag');
  perform _act_as(st2);
  select count(*) into n from public.sk_practice_concepts where generation_id = ws; perform _expect(n = 0, 'st2 (no attempt visible) does not read the tag');

  -- ── 3. plans RLS ──────────────────────────────────────────────────────────
  perform _act_as(st1);
  select count(*) into n from public.sk_learn_plans; perform _expect(n = 0, 'st1 does not read a plan still pending');
  r := _err(format('insert into public.sk_learn_plans (student_id, trigger, approver_role, status) values (%L, ''weekly'', ''parent'', ''pending_approval'')', st1));
  perform _expect(r like '42501%', 'st1 cannot write a plan (' || r || ')');
  perform _act_as(t1);
  select count(*) into n from public.sk_learn_plans where student_id = st1; perform _expect(n = 1, 't1 reads st1''s plan');
  r := _err(format('update public.sk_learn_plans set status = ''approved'', decided_at = now() where id = %L', pl1));
  perform _expect(r like '42501%', 't1 cannot approve by a direct update (' || r || ')');
  r := _err(format('insert into public.sk_learn_focus (student_id, kit_id, concept_key, concept_name, until) values (%L, %L, ''c1'', ''x'', now())', st1, kit));
  perform _expect(r like '42501%', 't1 cannot write a focus row directly (' || r || ')');
  perform _act_as(pa1);
  select count(*) into n from public.sk_learn_plans where student_id = st1; perform _expect(n = 1, 'pa1 reads st1''s plan (read-only copy)');
  perform _act_as(t2);
  select count(*) into n from public.sk_learn_plans where student_id = st1; perform _expect(n = 0, 't2 does not read st1''s plan');
  perform _act_as(st2);
  select count(*) into n from public.sk_learn_plans; perform _expect(n = 0, 'st2 reads no plans');

  -- ── 4. approver rules ─────────────────────────────────────────────────────
  perform _act_as(t2);
  j := public.sk_learn_plan_decide(pl1, 'approve');
  perform _expect(j->>'reason' = 'not_approver', 'another class''s teacher is refused (' || j::text || ')');
  perform _act_as(pa1);
  j := public.sk_learn_plan_decide(pl1, 'approve');
  perform _expect(j->>'reason' = 'not_approver', 'a school student''s parent is refused (read-only) (' || j::text || ')');
  perform _act_as(st1);
  j := public.sk_learn_plan_decide(pl1, 'approve');
  perform _expect(j->>'reason' = 'not_approver', 'the student is refused (' || j::text || ')');
  perform _act_as(t1);
  j := public.sk_learn_plan_decide(pl1, 'publish');
  perform _expect(j->>'reason' = 'bad_decision', 'an unknown decision is refused (' || j::text || ')');
  perform _act_as(hp);
  j := public.sk_learn_plan_decide(pl2, 'approve', null, true);
  perform _expect(j->>'reason' = 'whole_class_teacher_only', 'a parent cannot apply to a whole class (' || j::text || ')');

  -- ── 5. edit ───────────────────────────────────────────────────────────────
  perform _act_as(t1);
  j := public.sk_learn_plan_decide(pl1, 'edit', jsonb_build_array(jsonb_build_object('kind', 'next', 'title', 'Something else', 'reason', 'x', 'generation_id', kit)));
  perform _expect(j->>'reason' = 'item_not_proposed', 'an edit cannot add a kit SK did not propose (' || j::text || ')');
  j := public.sk_learn_plan_decide(pl1, 'edit', jsonb_build_array(
        its->0 || jsonb_build_object('title', 'Organelles again'),
        its->1, its->2));
  perform _expect(j->>'outcome' = 'done' and j->>'status' = 'pending_approval', 'an edit rewords and stays pending');
  perform _as_service();
  select ((p.items->0->>'title') = 'Organelles again' and p.edited)::text into strict r from public.sk_learn_plans p where p.id = pl1;
  perform _expect(r = 'true', 'the edit is stored and marked edited');

  -- ── 6. approve (one student) ──────────────────────────────────────────────
  perform _act_as(t1);
  j := public.sk_learn_plan_decide(pl1, 'approve');
  perform _expect(j->>'outcome' = 'done' and j->>'status' = 'approved', 'the class teacher approves (' || j::text || ')');
  perform _expect((j->'applied'->'already') @> to_jsonb(array[ws]), 'the practice worksheet she already has is not re-shared');
  perform _expect(jsonb_array_length(j->'applied'->'shares') = 1, 'the next kit becomes ONE new share');
  perform _as_service();
  select count(*) into n from generation_shares where generation_id = nxt and student_id = st1 and shared_by = t1;
  perform _expect(n = 1, 'the next kit is shared DIRECTLY to st1 (her My lessons / student Board)');
  select count(*) into n from public.sk_learn_focus where student_id = st1 and kit_id = kit and concept_key = 'c1' and plan_id = pl1;
  perform _expect(n = 1, 'the re-teach concept is SK''s focus for st1');
  select count(*) into n from public.sk_learn_plans where id = pl1 and status = 'approved' and decided_by = t1 and decided_role = 'teacher' and decided_at is not null;
  perform _expect(n = 1, 'the plan records who approved it');
  perform _act_as(st1);
  select count(*) into n from public.sk_learn_plans; perform _expect(n = 1, 'st1 now reads her APPROVED plan');
  select count(*) into n from public.sk_learn_focus; perform _expect(n = 1, 'st1 reads her focus row');
  perform _act_as(t1);
  j := public.sk_learn_plan_decide(pl1, 'decline');
  perform _expect(j->>'reason' = 'not_pending', 'a decided plan cannot be decided again (' || j::text || ')');

  -- ── 7. whole class ────────────────────────────────────────────────────────
  perform _as_service();
  insert into public.sk_learn_plans (student_id, kit_id, trigger, approver_role, class_id, approver_id, status, items)
    values (st1, null, 'weekly', 'teacher', C1, t1, 'pending_approval',
            jsonb_build_array(jsonb_build_object('kind', 'next', 'title', 'Tissues', 'reason', 'r', 'generation_id', nxt),
                              jsonb_build_object('kind', 'reteach', 'title', 'Membranes', 'reason', 'r', 'concept_key', 'c2', 'concept_name', 'Membranes', 'kit_id', kit)))
    returning id into pl3;
  perform _act_as(t1);
  j := public.sk_learn_plan_decide(pl3, 'approve', null, true);
  perform _expect(j->>'outcome' = 'done', 'whole-class approve (' || j::text || ')');
  perform _as_service();
  select count(*) into n from generation_shares where generation_id = nxt and class_id = C1;
  perform _expect(n = 1, 'the next kit is shared to the CLASS');
  select count(*) into n from public.sk_learn_focus where kit_id = kit and concept_key = 'c2' and student_id in (st1, st3);
  perform _expect(n = 2, 'every C1 student gets the focus concept');

  -- ── 8. decline (home student, parent approver) ────────────────────────────
  perform _act_as(hp);
  j := public.sk_learn_plan_decide(pl2, 'decline', null, false, 'We are on holiday this week.');
  perform _expect(j->>'outcome' = 'done' and j->>'status' = 'declined', 'the parent declines a home student''s plan');
  perform _as_service();
  select count(*) into n from generation_shares where generation_id = hnx;
  perform _expect(n = 0, 'a declined plan assigns nothing');
  select count(*) into n from public.sk_learn_plans where id = pl2 and decline_note = 'We are on holiday this week.' and decided_by = hp and decided_role = 'parent';
  perform _expect(n = 1, 'the decline note and the decider are kept');
  select count(*) into n from public.sk_learn_focus where student_id = hs;
  perform _expect(n = 0, 'a declined plan sets no focus');

  raise notice '================ ALL 0179 CHECKS PASSED ================';
end $$;

rollback;
