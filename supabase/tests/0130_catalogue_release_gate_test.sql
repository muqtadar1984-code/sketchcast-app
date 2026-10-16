-- SketchCast AI — verification for 0130 (kits gated to the preview list)
-- ============================================================================
-- Run AFTER applying 0130. Proves:
--   1. the seeded switch is closed and lists the founder's address;
--   2. before release, a teacher NOT on the list is told 'coming_soon' by
--      unlock, has no access, and their allowance says released=false;
--   3. a teacher ON the list (matched case-insensitively) unlocks normally;
--   4. the public projection is unaffected (anon still reads it);
--   5. releasing (public=true) opens it to everyone at once;
--   6. a missing setting fails CLOSED.
-- Every check RAISEs on failure; a clean run prints PASS lines and
-- "ALL 0130 CHECKS PASSED", then ROLLS BACK (nothing persists).
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

create or replace function _as(u uuid) returns void
  language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', coalesce(u::text, ''), true);
end $$;

do $$
declare
  IN_  uuid := '77777777-0130-0000-0000-000000000001';   -- on the preview list
  OUT_ uuid := '77777777-0130-0000-0000-000000000002';   -- not on it
  t uuid; a uuid; k uuid;
  n_public bigint;
begin
  -- 1. the seeded switch
  perform _expect_eq((select (value->>'public')::boolean from platform_settings where key = 'catalogue_release'), false,
                     'seeded closed');
  perform _expect_eq((select value->'preview_emails' ? 'muqtadar1984@gmail.com' from platform_settings where key = 'catalogue_release'), true,
                     'founder address on the preview list');

  -- fixtures: two free teachers and one visible topic
  insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at) values
    ('00000000-0000-0000-0000-000000000000', IN_,  'authenticated', 'authenticated', 'preview0130@example.com', now(), now()),
    ('00000000-0000-0000-0000-000000000000', OUT_, 'authenticated', 'authenticated', 'other0130@example.com',   now(), now())
  on conflict (id) do nothing;
  insert into profiles (id, role) values (IN_, 'teacher'), (OUT_, 'teacher')
  on conflict (id) do update set role = 'teacher', school_id = null, suspended_at = null;
  update platform_settings
     set value = jsonb_set(value, '{preview_emails}', (value->'preview_emails') || '"Preview0130@Example.COM"')
   where key = 'catalogue_release';

  insert into topics (canonical_key, title, subject, status, bank_maturity)
  values ('zz-0130-t', 'ZZ 0130 t', 'Science', 'video_approved', 'good') returning id into t;
  insert into topic_articles (topic_id, title, status) values (t, 'a', 'approved') returning id into a;
  insert into topic_kits (topic_id, article_id, language, status, reviewed_at) values (t, a, 'en', 'approved', now()) returning id into k;
  insert into topic_publications (topic_kit_id, part, channel_language, youtube_video_id, privacy) values (k, 1, 'en', 'yt_0130', 'public');

  -- 2. not on the list
  perform _as(OUT_);
  perform _expect_eq(catalogue_released_for(OUT_), false, 'other teacher: not released');
  perform _expect_eq(unlock_catalogue_kit(t) ->> 'status', 'coming_soon', 'other teacher: unlock says coming_soon');
  perform _expect_eq((select count(*) from catalogue_unlocks where user_id = OUT_), 0::bigint, 'other teacher: no unlock row');
  perform _expect_eq(catalogue_has_access(t), false, 'other teacher: no access');
  perform _expect_eq(my_catalogue_allowance() ->> 'reason', 'coming_soon', 'other teacher: allowance reason coming_soon');
  perform _expect_eq((my_catalogue_allowance() ->> 'released')::boolean, false, 'other teacher: released=false');

  -- 3. on the list (case-insensitive)
  perform _as(IN_);
  perform _expect_eq(catalogue_released_for(IN_), true, 'preview teacher: released (case-insensitive match)');
  perform _expect_eq(unlock_catalogue_kit(t) ->> 'status', 'unlocked', 'preview teacher: unlocks');
  perform _expect_eq(catalogue_has_access(t), true, 'preview teacher: has access');
  perform _expect_eq((my_catalogue_allowance() ->> 'released')::boolean, true, 'preview teacher: released=true');

  -- 4. the public pages are unaffected
  select count(*) into n_public from public_catalogue();
  perform _expect_eq(n_public > 0, true, 'public_catalogue still returns rows before release');
  perform _expect_eq(has_function_privilege('anon', 'public.public_catalogue()', 'execute'), true, 'anon still reads public_catalogue');
  perform _expect_eq(has_function_privilege('authenticated', 'public.catalogue_released_for(uuid)', 'execute'), false, 'clients cannot probe the gate for others');

  -- 5. release to everyone
  update platform_settings set value = jsonb_set(value, '{public}', 'true') where key = 'catalogue_release';
  perform _as(OUT_);
  perform _expect_eq(unlock_catalogue_kit(t) ->> 'status', 'unlocked', 'after release: other teacher unlocks');

  -- 6. fail closed
  delete from platform_settings where key = 'catalogue_release';
  perform _expect_eq(catalogue_released_for(IN_), false, 'setting missing: nobody is released (fail closed)');
  perform _as(IN_);
  perform _expect_eq(catalogue_has_access(t), false, 'setting missing: access closed even for an earlier unlocker');
end $$;

do $$ begin raise notice 'ALL 0130 CHECKS PASSED'; end $$;
rollback;
