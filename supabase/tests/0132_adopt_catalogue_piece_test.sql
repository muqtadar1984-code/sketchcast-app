-- SketchCast AI — verification for 0132 (a teacher's own copy of a catalogue document)
-- ============================================================================
-- Run AFTER applying 0132. Uses a REAL current catalogue kit as the source and
-- proves:
--   1. a student is refused; a teacher without an unlock is refused;
--   2. after unlocking, a FREE (trial) teacher gets a copy: owned by them,
--      status done, no book, the same storage paths, lineage in
--      params.catalogue_ref — and NO job, NO ledger row, NO trial pin;
--   3. adopting again returns the same copy; the presentation copies too;
--   4. a Pro teacher likewise; the copy flag is cleared afterwards;
--   5. a client cannot forge params.catalogue_ref (RLS).
-- Every check RAISEs on failure; a clean run prints PASS lines and
-- "ALL 0132 CHECKS PASSED", then ROLLS BACK (nothing persists).
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
create or replace function _as(u uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', coalesce(u::text, ''), true);
end $$;
create or replace function _err(stmt text) returns text language plpgsql as $$
begin execute stmt; return 'ok'; exception when others then return sqlerrm; end $$;

do $$
declare
  T   uuid := '88888888-0132-0000-0000-000000000001';  -- free (trial) teacher
  STU uuid := '88888888-0132-0000-0000-000000000002';  -- student
  P   uuid := '88888888-0132-0000-0000-000000000003';  -- Teacher Pro
  topic uuid; src uuid; pres uuid; cp uuid; cp2 uuid; cpp uuid;
  n_src int; n_cp int; same int; gen0 bigint; job0 bigint; led0 bigint; pin0 bigint;
begin
  insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at)
  select '00000000-0000-0000-0000-000000000000', u, 'authenticated', 'authenticated', u::text || '@adopt0132.example.com', now(), now()
  from unnest(array[T, STU, P]) u on conflict (id) do nothing;
  insert into profiles (id, role) values (T, 'teacher'), (STU, 'student'), (P, 'teacher')
  on conflict (id) do update set role = excluded.role, school_id = null, suspended_at = null;
  insert into entitlements (user_id, active, plan_key, status) values (P, true, 'teacher_pro_monthly', 'active');
  -- The kits are gated to a preview list (0130); this test is about the released behaviour.
  update platform_settings set value = jsonb_set(value, '{public}', 'true') where key = 'catalogue_release';

  select c.topic_id, nullif(k.doc_generation_ids->>'worksheet','')::uuid, k.presentation_generation_id into topic, src, pres
  from catalogue_current_kits() c join topic_kits k on k.id = c.topic_kit_id
  where nullif(k.doc_generation_ids->>'worksheet','') is not null and k.presentation_generation_id is not null
  limit 1;
  if src is null then raise exception 'no current kit with a worksheet to test against'; end if;

  select count(*) into gen0 from generations; select count(*) into job0 from jobs;
  select count(*) into led0 from credit_ledger; select count(*) into pin0 from trial_pin;

  -- 1. refusals
  perform _as(STU);
  perform _expect_eq(_err(format('select adopt_catalogue_piece(%L)', src)) like 'catalogue: forbidden_role%', true, 'student refused');
  perform _as(T);
  perform _expect_eq(_err(format('select adopt_catalogue_piece(%L)', src)), 'unlock this topic first', 'no unlock: refused');
  perform _expect_eq(_err(format('select adopt_catalogue_piece(%L)', gen_random_uuid())), 'that document is not part of an approved catalogue kit', 'unknown source: refused');

  -- 2. the free teacher's copy
  perform _expect_eq(unlock_catalogue_kit(topic) ->> 'status', 'unlocked', 'trial teacher unlocks the topic');
  cp := adopt_catalogue_piece(src);
  select count(*) into n_src from artifacts where generation_id = src;
  select count(*) into n_cp from artifacts where generation_id = cp;
  select count(*) into same from artifacts a join artifacts s on s.storage_path = a.storage_path and s.generation_id = src where a.generation_id = cp;
  perform _expect_eq((select owner_id from generations where id = cp), T, 'copy owned by the teacher');
  perform _expect_eq((select status::text from generations where id = cp), 'done', 'copy is done');
  perform _expect_eq((select book_id is null from generations where id = cp), true, 'copy has no book');
  perform _expect_eq(n_cp, n_src, 'copy has every artifact of the source');
  perform _expect_eq(same, n_src, 'same storage paths (no file copied)');
  perform _expect_eq((select (params->'catalogue_ref'->>'source_generation_id')::uuid from generations where id = cp), src, 'lineage: source recorded');
  perform _expect_eq((select (params->'catalogue_ref'->>'topic_id')::uuid from generations where id = cp), topic, 'lineage: topic recorded');
  perform _expect_eq((select params ? 'catalogue' from generations where id = cp), false, 'copy does not carry the system catalogue flag');

  -- 3. idempotent; the presentation too
  cp2 := adopt_catalogue_piece(src);
  perform _expect_eq(cp2, cp, 'adopting again returns the same copy');
  cpp := adopt_catalogue_piece(pres);
  perform _expect_eq((select count(*) from artifacts where generation_id = cpp) = (select count(*) from artifacts where generation_id = pres), true, 'presentation copy carries its artifacts');

  -- 4. a Pro teacher; side effects
  perform _as(P);
  perform _expect_eq(unlock_catalogue_kit(topic) ->> 'status', 'unlocked', 'pro teacher unlocks the topic');
  perform adopt_catalogue_piece(src);
  perform _expect_eq((select count(*) from generations) - gen0, 3::bigint, 'exactly three copies created');
  perform _expect_eq((select count(*) from jobs) - job0, 0::bigint, 'NO job queued for any copy');
  perform _expect_eq((select count(*) from credit_ledger) - led0, 0::bigint, 'NO credit charged for any copy');
  perform _expect_eq((select count(*) from trial_pin) - pin0, 0::bigint, 'NO trial pin created for the free teacher');
  perform _expect_eq((select count(*) from catalogue_events where event = 'adopt' and user_id in (T, P)), 3::bigint, 'adopt events recorded');
  perform _expect_eq(generation_copy_in_progress(), false, 'copy flag cleared');
end $$;

-- 5. a client cannot forge the lineage key.
-- Postgres evaluates WITH CHECK after the BEFORE ROW triggers, so the probe
-- must be an insert every earlier guard lets through: the PRO teacher (no
-- trial pin), a LESSON (documents need their lesson first — enforce_lesson_tools)
-- on a book of their own. The control insert without the key proves the probe
-- reaches RLS at all.
insert into books (id, title, owner_id) values ('88888888-0132-0000-0000-00000000b00c', 'forge probe', '88888888-0132-0000-0000-000000000003');
select _as('88888888-0132-0000-0000-000000000003');
set local role authenticated;
do $$
begin
  perform _expect_eq(_err($q$insert into generations (kind, book_id, chapter_ref, owner_id, status, params)
                           values ('presentation', '88888888-0132-0000-0000-00000000b00c', '1', '88888888-0132-0000-0000-000000000003', 'queued', '{"catalogue_ref":{"x":1}}')$q$) like '%row-level security%', true,
                     'RLS refuses a client insert carrying params.catalogue_ref');
  perform _expect_eq(_err($q$insert into generations (kind, book_id, chapter_ref, owner_id, status, params)
                           values ('presentation', '88888888-0132-0000-0000-00000000b00c', '1', '88888888-0132-0000-0000-000000000003', 'queued', '{}')$q$),
                     'ok', 'control: the same insert without the key is accepted (the probe reaches RLS)');
end $$;
reset role;

do $$ begin raise notice 'ALL 0132 CHECKS PASSED'; end $$;
rollback;
