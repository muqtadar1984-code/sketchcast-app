-- SketchCast AI — verification for 0129 (adopting a kit is a copy, not a generation)
-- ============================================================================
-- Run AFTER applying 0129. Drives the REAL triggers on the REAL schema:
--   1. normal metering still applies: a school-trial teacher whose trial
--      budget is spent is REFUSED a new generation;
--   2. that same teacher can adopt a colleague's finished presentation AND
--      worksheet: each copy is 'done', owns the same artifact paths, and gets
--      NO job and NO ledger row; the flag is cleared afterwards;
--   3. adopting again is idempotent (same id, no new rows);
--   4. outside a copy, nothing changed: a normal insert still gets a job and a
--      ledger row, and a 'done' insert WITHOUT the flag still gets a job;
--      the flag alone does not exempt a queued insert;
--   5. a suspended school and an expired school still cannot adopt;
--   6. clients cannot call the flag function.
-- Every check RAISEs on failure; a clean run prints PASS lines and
-- "ALL 0129 CHECKS PASSED", then ROLLS BACK (nothing persists).
-- ============================================================================
begin;

create or replace function _expect_eq(actual anyelement, expected anyelement, msg text) returns void
  language plpgsql as $$
begin
  if actual is distinct from expected then
    raise exception 'FAIL (got %, wanted %): %', actual, expected, msg;
  end if;
  raise notice 'PASS (= %): %', expected, msg;
end $$;

-- Does the statement raise an error whose message contains `needle`?
create or replace function _refused(stmt text, needle text) returns boolean
  language plpgsql as $$
begin
  execute stmt;
  return false;
exception when others then
  if position(needle in sqlerrm) = 0 then
    raise exception 'unexpected error (wanted "%"): %', needle, sqlerrm;
  end if;
  return true;
end $$;

create or replace function _as(u uuid) returns void
  language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', coalesce(u::text, ''), true);
end $$;

do $$
declare
  A   uuid := '55555555-0129-0000-0000-000000000001';  -- made the kit
  B   uuid := '55555555-0129-0000-0000-000000000002';  -- adopts it; trial budget spent
  sch uuid := '66666666-0129-0000-0000-000000000001';
  src_p uuid; src_w uuid; src_c uuid; src_x uuid;
  cp uuid; cw uuid; again uuid;
  q uuid;
  n_gen bigint;
begin
  insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at)
  select '00000000-0000-0000-0000-000000000000', u, 'authenticated', 'authenticated',
         u::text || '@adopt0129.example.com', now(), now()
  from unnest(array[A, B]) u on conflict (id) do nothing;
  insert into schools (id, name, slug, status, trial_started_at, trial_ends_at)
  values (sch, 'ZZ 0129', 'zz-0129', 'active', now() - interval '2 days', now() + interval '10 days');
  insert into profiles (id, role, school_id) values (A, 'teacher', sch), (B, 'teacher', sch)
  on conflict (id) do update set role = excluded.role, school_id = excluded.school_id,
    max_books = null, max_chapters = null, suspended_at = null, lesson_tools = true;
  perform _expect_eq(plan_tier(B), 'school_trial', 'fixture: B is on a school trial');

  -- A's finished kit (service-side inserts, as the worker leaves them).
  insert into generations (kind, owner_id, school_id, status, title, params)
  values ('presentation', A, sch, 'done', 'ZZ lesson', '{"v":1}') returning id into src_p;
  insert into generations (kind, owner_id, school_id, status, title, params)
  values ('worksheet', A, sch, 'done', 'ZZ worksheet', '{"v":1}') returning id into src_w;
  insert into generations (kind, owner_id, school_id, status, title, params)
  values ('case_study', A, sch, 'done', 'ZZ case', '{"v":1}') returning id into src_c;
  insert into generations (kind, owner_id, school_id, status, title, params)
  values ('activity', A, sch, 'done', 'ZZ activity', '{"v":1}') returning id into src_x;
  insert into artifacts (generation_id, kind, storage_path) values
    (src_p, 'video_mp4', A::text || '/' || src_p::text || '/lesson.mp4'),
    (src_p, 'script_json', A::text || '/' || src_p::text || '/script.json'),
    (src_w, 'docx', A::text || '/' || src_w::text || '/worksheet.docx'),
    (src_w, 'questions_json', A::text || '/' || src_w::text || '/worksheet_questions.json');

  -- ── 4a. outside a copy nothing changed: a 'done' insert w/o the flag gets a job
  perform _expect_eq((select count(*) from jobs where generation_id = src_p), 1::bigint,
                     'a done-status insert WITHOUT the copy flag still enqueues a job (unchanged)');
  perform _expect_eq((select count(*) from credit_ledger where generation_id = src_p and not voided), 1::bigint,
                     'and is still metered (unchanged)');

  -- ── 1. spend B's school-trial budget; a normal generation is refused
  insert into credit_ledger (owner_id, kind, units, part, source, created_at)
  values (B, 'presentation', 14, 0, 'plan', now() - interval '1 hour');
  perform _as(B);
  perform _expect_eq(_refused(format(
      'insert into generations (kind, owner_id, school_id, chapter_ref, params) values (''presentation'', %L, %L, ''9'', ''{}'')',
      B, sch), 'free trial includes'),
    true, 'normal metering: a spent school trial refuses a NEW generation');

  -- ── 2. but adopting costs nothing and runs nothing
  select count(*) into n_gen from generations;
  cp := adopt_school_kit(src_p);
  cw := adopt_school_kit(src_w);
  perform _expect_eq((select owner_id from generations where id = cp), B, 'copy is owned by the adopter');
  perform _expect_eq((select status::text from generations where id = cp), 'done', 'copy is done');
  perform _expect_eq((select count(*) from artifacts where generation_id = cp), 2::bigint, 'copy has the lesson''s 2 artifacts');
  perform _expect_eq((select count(*) from artifacts a join artifacts s on s.storage_path = a.storage_path
                       where a.generation_id = cp and s.generation_id = src_p), 2::bigint, 'same storage paths, no file copy');
  perform _expect_eq((select count(*) from jobs where generation_id in (cp, cw)), 0::bigint,
                     'NO job for either copy: the worker never runs');
  perform _expect_eq((select count(*) from credit_ledger where generation_id in (cp, cw)), 0::bigint,
                     'NO ledger row for either copy: the trial budget is untouched');
  perform _expect_eq((select count(*) from generations), n_gen + 2, 'exactly two rows created');
  perform _expect_eq(generation_copy_in_progress(), false, 'the copy flag is cleared after adopt returns');

  -- ── 3. idempotent
  again := adopt_school_kit(src_p);
  perform _expect_eq(again, cp, 'adopting again returns the same copy');
  perform _expect_eq((select count(*) from generations), n_gen + 2, 'and creates nothing');

  -- ── 4b. the flag alone does not exempt a queued insert
  perform set_config('sketchcast.generation_copy', 'on', true);
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  insert into generations (kind, owner_id, school_id, status, params)
  values ('lesson_plan', A, sch, 'queued', '{"v":2}') returning id into q;
  perform set_config('sketchcast.generation_copy', '', true);
  perform _expect_eq((select count(*) from jobs where generation_id = q), 1::bigint,
                     'flag set but status queued: the job is still created (both conditions required)');

  -- ── 5. a suspended or expired school still cannot adopt
  update schools set status = 'suspended' where id = sch;
  perform _as(B);
  perform _expect_eq(_refused(format('select adopt_school_kit(%L)', src_c), 'suspended'),
                     true, 'suspended school: adoption refused (guard sits after the refusal)');
  update schools set status = 'active', trial_ends_at = now() - interval '1 minute' where id = sch;
  perform _expect_eq(plan_tier(B), 'school_expired', 'school trial expired');
  perform _expect_eq(_refused(format('select adopt_school_kit(%L)', src_x), 'trial has ended'),
                     true, 'expired school: adoption refused');

  -- ── 6. privileges
  perform _expect_eq(has_function_privilege('authenticated', 'public.generation_copy_in_progress()', 'execute'), false,
                     'clients cannot call the flag function');
  perform _expect_eq(has_function_privilege('anon', 'public.generation_copy_in_progress()', 'execute'), false,
                     'anon cannot call the flag function');
end $$;

do $$ begin raise notice 'ALL 0129 CHECKS PASSED'; end $$;
rollback;
