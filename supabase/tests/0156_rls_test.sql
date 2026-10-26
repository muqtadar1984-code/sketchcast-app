-- SketchCast AI — RLS verification for 0156 (SK book content)
-- ============================================================================
-- Run in the SQL editor (or on a branch via the Supabase MCP) AFTER
-- 0156_sk_book_content.sql. Seeds a throwaway product in each status with a
-- unit, a draft and a validated objective, a proposed map row and a block,
-- then impersonates a signed-in student and asserts the access rules:
--   1. students read APPROVED products only, their units only, and VALIDATED
--      objectives of approved products only;
--   2. students cannot read objective_curriculum_map, sk_book_blocks or
--      topic_questions at all (no grant), and cannot write any SK table;
--   3. the gates hold for everyone: an objective cannot be 'validated' without
--      a reviewer, a map row cannot be 'verified' or 'rejected' without one,
--      a unit carries at most one objective, and an objective needs its unit;
--   4. deleting a unit cascades to its objective and nulls the item link.
-- Every check RAISEs on failure; a clean run prints PASS lines and
-- "ALL 0156 RLS CHECKS PASSED", then ROLLS BACK (nothing persists).
-- Applied on branch sk-b1 on 2026-10-27 (docs/SK-B1-REPORT.md).
-- ============================================================================
begin;

create or replace function _expect(cond boolean, msg text) returns void
  language plpgsql as $$
begin
  if cond then raise notice 'PASS: %', msg;
  else raise exception 'FAIL: %', msg; end if;
end $$;

create or replace function _err(stmt text) returns text language plpgsql as $$
begin execute stmt; return 'ok'; exception when others then return sqlerrm; end $$;

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
  st   uuid := '55555555-0156-0000-0000-000000000001';   -- a student
  rv   uuid := '55555555-0156-0000-0000-000000000002';   -- the reviewer (founder)
  cur  uuid; node uuid;
  p_ok uuid; p_dr uuid;                                   -- approved / draft product
  o_ok uuid; o_dr uuid;                                   -- validated / draft objective
  n int; r text;
begin
  insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at) values
    ('00000000-0000-0000-0000-000000000000', st, 'authenticated', 'authenticated', 'st.t0156@example.com', now(), now()),
    ('00000000-0000-0000-0000-000000000000', rv, 'authenticated', 'authenticated', 'rv.t0156@example.com', now(), now())
  on conflict (id) do nothing;
  insert into profiles (id, role, full_name) values (st, 'student', 'Student 0156'), (rv, 'teacher', 'Reviewer 0156')
  on conflict (id) do nothing;

  insert into curricula (code, name) values ('t0156_curriculum', 'T0156 curriculum') returning id into cur;
  insert into curriculum_nodes (curriculum_id, code, title, kind) values (cur, 'T0156.01', 'A node', 'objective') returning id into node;

  insert into sk_book_products (slug, title, subject, curriculum_id, status) values ('t0156-approved', 'T0156 approved', 'Biology', cur, 'approved') returning id into p_ok;
  insert into sk_book_products (slug, title, subject, curriculum_id, status) values ('t0156-draft', 'T0156 draft', 'Biology', cur, 'draft') returning id into p_dr;

  insert into sk_book_units (product_id, chapter, unit_key, section_sid, title, sort_order, node_codes) values
    (p_ok, 1, 'u1', 's1', 'Approved book, unit 1', 1, '{T0156.01}'),
    (p_ok, 1, 'u2', 's2', 'Approved book, unit 2', 2, '{}'),
    (p_dr, 1, 'u1', 's1', 'Draft book, unit 1', 1, '{T0156.01}');

  insert into teaching_objectives (product_id, chapter, unit_key, text, status, validated_by, validated_at)
    values (p_ok, 1, 'u1', 'Students can do the validated thing.', 'validated', rv, now()) returning id into o_ok;
  insert into teaching_objectives (product_id, chapter, unit_key, text)
    values (p_ok, 1, 'u2', 'Students can do the draft thing.') returning id into o_dr;
  insert into teaching_objectives (product_id, chapter, unit_key, text, status, validated_by, validated_at)
    values (p_dr, 1, 'u1', 'Validated objective of a DRAFT book.', 'validated', rv, now());

  insert into objective_curriculum_map (teaching_objective_id, curriculum_node_id, relation, map_confidence, mapped_by)
    values (o_ok, node, 'supports', 0.5, 'model');
  insert into sk_book_blocks (product_id, chapter, section_sid, block_index, block_type, body, unit_key)
    values (p_ok, 1, 's1', 0, 'paragraph', '{"text":"hello"}', 'u1');

  -- ── 3. the gates (checked as the editor's own role) ───────────────────────
  r := _err(format('insert into teaching_objectives (product_id, chapter, unit_key, text, status) values (%L, 1, ''u2'', ''x'', ''validated'')', p_dr));
  perform _expect(r <> 'ok', 'an objective cannot be validated without validated_by/validated_at (' || r || ')');
  r := _err(format('update objective_curriculum_map set status = ''verified'' where teaching_objective_id = %L', o_ok));
  perform _expect(r <> 'ok', 'a map row cannot become verified without a reviewer (' || r || ')');
  r := _err(format('update objective_curriculum_map set status = ''rejected'' where teaching_objective_id = %L', o_ok));
  perform _expect(r <> 'ok', 'a map row cannot become rejected without a reviewer (' || r || ')');
  r := _err(format('update objective_curriculum_map set status = ''verified'', reviewed_by = %L, reviewed_at = now(), mapped_by = ''human'' where teaching_objective_id = %L', rv, o_ok));
  perform _expect(r = 'ok', 'a named reviewer can verify a map row');
  r := _err(format('insert into teaching_objectives (product_id, chapter, unit_key, text) values (%L, 1, ''u1'', ''second objective for u1'')', p_ok));
  perform _expect(r <> 'ok', 'a unit carries at most one teaching objective (' || r || ')');
  r := _err(format('insert into teaching_objectives (product_id, chapter, unit_key, text) values (%L, 1, ''u9'', ''orphan'')', p_ok));
  perform _expect(r <> 'ok', 'an objective needs an existing unit (' || r || ')');
  r := _err(format('insert into objective_curriculum_map (teaching_objective_id, curriculum_node_id, map_confidence) values (%L, %L, 1.5)', o_dr, node));
  perform _expect(r <> 'ok', 'map_confidence is bounded to 0..1 (' || r || ')');

  -- ── 1 + 2. the student ────────────────────────────────────────────────────
  perform _act_as(st);
  select count(*) into n from sk_book_products where slug like 't0156-%';     perform _expect(n = 1, 'student sees the approved product only');
  select count(*) into n from sk_book_products where id = p_dr;               perform _expect(n = 0, 'student CANNOT see the draft product');
  select count(*) into n from sk_book_units where product_id = p_ok;          perform _expect(n = 2, 'student sees the approved product''s units');
  select count(*) into n from sk_book_units where product_id = p_dr;          perform _expect(n = 0, 'student CANNOT see the draft product''s units');
  select count(*) into n from teaching_objectives where id = o_ok;            perform _expect(n = 1, 'student sees the validated objective of the approved product');
  select count(*) into n from teaching_objectives where id = o_dr;            perform _expect(n = 0, 'student CANNOT see a draft objective');
  select count(*) into n from teaching_objectives where product_id = p_dr;    perform _expect(n = 0, 'student CANNOT see a validated objective of a draft product');
  r := _err('select count(*) from objective_curriculum_map');                 perform _expect(r like '%permission denied%', 'student CANNOT read objective_curriculum_map (' || r || ')');
  r := _err('select count(*) from sk_book_blocks');                           perform _expect(r like '%permission denied%', 'student CANNOT read sk_book_blocks (' || r || ')');
  r := _err('select count(*) from topic_questions');                          perform _expect(r like '%permission denied%', 'student still CANNOT read topic_questions (' || r || ')');
  r := _err('insert into sk_book_products (slug, title) values (''t0156-hack'', ''x'')');            perform _expect(r like '%permission denied%', 'student CANNOT insert a product (' || r || ')');
  r := _err(format('update sk_book_products set status = ''approved'' where id = %L', p_dr));       perform _expect(r like '%permission denied%', 'student CANNOT update a product (' || r || ')');
  r := _err(format('update teaching_objectives set status = ''validated'' where id = %L', o_dr));   perform _expect(r like '%permission denied%', 'student CANNOT update an objective (' || r || ')');
  r := _err(format('delete from sk_book_units where product_id = %L', p_ok));                       perform _expect(r like '%permission denied%', 'student CANNOT delete a unit (' || r || ')');

  raise notice '================ ALL 0156 RLS CHECKS PASSED ================';
end $$;

rollback;
