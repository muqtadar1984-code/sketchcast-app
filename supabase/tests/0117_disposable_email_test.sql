-- SketchCast AI — disposable-address gate verification for 0117
-- ============================================================================
-- Run in the Supabase SQL editor AFTER applying 0117_disposable_email_domains.sql.
-- Drives the REAL trigger with direct INSERTs into auth.users (what GoTrue
-- does on signUp / admin.createUser) and proves, in order:
--   1. the rule: exact domain, any parent domain, case, a trailing dot; and
--      that gmail, the synthetic student domain, null and a bare TLD pass;
--   2. a seeded burner (trashmail.ws) cannot become a row in auth.users;
--   3. a subdomain of a listed domain cannot either;
--   4. an ordinary address can, and gets its profiles row as before;
--   5. re-pointing an existing account at a burner is refused, while an
--      UPDATE that leaves the address as it is passes;
--   6. a domain added by hand is refused from that moment.
-- Every check RAISEs on failure; a clean run prints PASS lines and
-- "ALL 0117 CHECKS PASSED", then ROLLS BACK (nothing persists).
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

-- Does the statement raise the 0117 refusal? (errcode check_violation, message
-- naming the domain.) Any OTHER error propagates so a broken fixture is loud.
create or replace function _refused(stmt text) returns boolean
  language plpgsql as $$
begin
  execute stmt;
  return false;
exception when check_violation then
  if sqlerrm not like 'disposable email domain refused:%' then raise; end if;
  return true;
end $$;

do $$
declare
  u1 uuid := '11111111-0117-0000-0000-000000000001';
  u2 uuid := '11111111-0117-0000-0000-000000000002';
begin
  -- 1. the rule
  perform _expect_eq(public.email_domain_is_disposable('someone@trashmail.ws'),      true,  'exact listed domain');
  perform _expect_eq(public.email_domain_is_disposable('someone@TRASHMAIL.WS'),      true,  'case-insensitive');
  perform _expect_eq(public.email_domain_is_disposable('someone@trashmail.ws.'),     true,  'trailing dot ignored');
  perform _expect_eq(public.email_domain_is_disposable('someone@mx.trashmail.ws'),   true,  'subdomain of a listed domain');
  perform _expect_eq(public.email_domain_is_disposable('someone@gmail.com'),         false, 'gmail passes');
  perform _expect_eq(public.email_domain_is_disposable('jane.doe@students.sketchcast.app'), false, 'synthetic student domain passes');
  perform _expect_eq(public.email_domain_is_disposable(null),                        false, 'null passes (the trigger, not this, decides on nulls)');
  perform _expect_eq(public.email_domain_is_disposable('no-at-sign'),                false, 'no domain passes');
  perform _expect_eq(public.email_domain_is_disposable('someone@ws'),                false, 'a bare TLD is never matched');
  perform _expect_eq((select count(*) > 8000 from public.disposable_email_domains),  true,  'seed list is present');

  -- 2 + 3. a burner cannot become an account
  perform _expect_eq(_refused(format('insert into auth.users (id, email) values (%L, %L)', u1, 'burner@trashmail.ws')),
                     true, 'INSERT with a listed domain is refused');
  perform _expect_eq(_refused(format('insert into auth.users (id, email) values (%L, %L)', u1, 'burner@mx.trashmail.ws')),
                     true, 'INSERT with a subdomain of a listed domain is refused');
  perform _expect_eq((select count(*) from auth.users where id = u1), 0::bigint, 'no row was created');

  -- 4. an ordinary address can
  perform _expect_eq(_refused(format('insert into auth.users (id, email, raw_user_meta_data) values (%L, %L, %L)',
                                     u2, 'teacher@example.org', '{"full_name":"T"}')),
                     false, 'INSERT with an ordinary address passes');
  perform _expect_eq((select count(*) from public.profiles where id = u2), 1::bigint, 'handle_new_user still made the profile');

  -- 5. re-pointing at a burner
  perform _expect_eq(_refused(format('update auth.users set email = %L where id = %L', 'teacher@trashmail.ws', u2)),
                     true, 'UPDATE to a listed domain is refused');
  perform _expect_eq(_refused(format('update auth.users set email = email where id = %L', u2)),
                     false, 'UPDATE that keeps the address passes');
  perform _expect_eq((select email from auth.users where id = u2), 'teacher@example.org', 'address unchanged');

  -- 6. a hand-added domain takes effect immediately
  insert into public.disposable_email_domains (domain, source) values ('example.org', 'test');
  perform _expect_eq(public.email_domain_is_disposable('x@example.org'), true, 'hand-added domain is matched');
  perform _expect_eq(_refused(format('update auth.users set email = email where id = %L', u2)),
                     false, 'an existing account on a newly listed domain is untouched by a same-address UPDATE');

  raise notice 'ALL 0117 CHECKS PASSED';
end $$;

rollback;
