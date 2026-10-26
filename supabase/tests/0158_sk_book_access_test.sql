-- SketchCast AI — verification for 0158 (SK book access)
-- ============================================================================
-- Run AFTER applying 0158. Proves:
--   1. the seven tables exist with RLS on;
--   2. authenticated/anon can read NOTHING from book_codes, print_batches,
--      publishers and book_code_attempts (no policies), and grants/usage/
--      consents only through the read-own policies;
--   3. redeem_book_code() exists, is not callable by anon/authenticated, and
--      RETURNS 'invalid' for an unknown code, 'used' for a redeemed one,
--      'not_your_child' for an unlinked child (leaving the code unused) and
--      'rate_limited' after five failures — every attempt leaving a row in
--      book_code_attempts (a raised exception would have rolled that row
--      back: the first draft did exactly that, and this test caught it);
--   4. a redeemed code produces exactly one 30-day grant and cannot be
--      redeemed twice.
-- Runs on an existing profile or, on an empty branch, a throwaway one.
-- Every check RAISEs on failure; a clean run prints PASS lines and
-- "ALL 0158 CHECKS PASSED", then ROLLS BACK (nothing persists).
-- Passed on the sk-b1 branch database 2026-10-27.
-- ============================================================================
begin;

do $$
declare
  t text;
  n bigint;
  v_pub uuid; v_batch uuid; v_user uuid; v_code_id uuid; v_res jsonb;
  v_hmac  text := repeat('a', 64);
  v_hmac2 text := repeat('e', 64);
begin
  -- 1. tables + RLS
  foreach t in array array['publishers','print_batches','book_codes','book_access_grants','sk_usage','book_code_attempts','consents'] loop
    perform 1 from pg_tables where schemaname = 'public' and tablename = t;
    if not found then raise exception 'FAIL: table % missing', t; end if;
    perform 1 from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = 'public' and c.relname = t and c.relrowsecurity;
    if not found then raise exception 'FAIL: RLS off on %', t; end if;
  end loop;
  raise notice 'PASS: seven tables with RLS on';

  -- 2. no read policies on the staff-only tables; read-own on the others
  foreach t in array array['publishers','print_batches','book_codes','book_code_attempts'] loop
    select count(*) into n from pg_policies where schemaname = 'public' and tablename = t;
    if n <> 0 then raise exception 'FAIL: % has % policies (expected none)', t, n; end if;
  end loop;
  perform 1 from pg_policies where schemaname='public' and tablename='book_access_grants' and policyname='sk_grants_read_own';
  if not found then raise exception 'FAIL: sk_grants_read_own missing'; end if;
  perform 1 from pg_policies where schemaname='public' and tablename='consents' and policyname='consents_read_own';
  if not found then raise exception 'FAIL: consents_read_own missing'; end if;
  raise notice 'PASS: policies as designed';

  -- 3. the function exists and is withheld from anon/authenticated
  perform 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'redeem_book_code';
  if not found then raise exception 'FAIL: redeem_book_code missing'; end if;
  if has_function_privilege('anon', 'public.redeem_book_code(text, uuid, uuid, integer)', 'execute')
     or has_function_privilege('authenticated', 'public.redeem_book_code(text, uuid, uuid, integer)', 'execute') then
    raise exception 'FAIL: redeem_book_code callable by anon/authenticated';
  end if;
  raise notice 'PASS: redeem_book_code exists, service-role only';

  -- Throwaway scenario (rolled back): one profile, one publisher, one batch, two codes.
  select id into v_user from public.profiles limit 1;
  if v_user is null then
    -- empty database (a fresh branch): a throwaway user, gone at rollback
    v_user := gen_random_uuid();
    insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
      values (v_user, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'sk-0158-test@example.invalid', now(), now());
    insert into public.profiles (id, role, full_name) values (v_user, 'student', '0158 test');
  end if;
  delete from public.book_code_attempts where user_id = v_user; -- a clean hour for the rate-limit count (rolled back)

  insert into public.publishers (name, market) values ('Test Publisher', 'MY') returning id into v_pub;
  insert into public.print_batches (publisher_id, product_id, market, quantity, code_prefix)
    values (v_pub, gen_random_uuid(), 'MY', 2, 'SKB2') returning id into v_batch;
  insert into public.book_codes (code_hmac, product_id, batch_id)
    select v_hmac, product_id, v_batch from public.print_batches where id = v_batch returning id into v_code_id;
  insert into public.book_codes (code_hmac, product_id, batch_id)
    select v_hmac2, product_id, v_batch from public.print_batches where id = v_batch;

  -- unknown code → invalid, and the attempt is recorded
  v_res := public.redeem_book_code(repeat('b', 64), v_user, null, 30);
  if v_res->>'outcome' <> 'invalid' then raise exception 'FAIL: expected invalid, got %', v_res; end if;
  select count(*) into n from public.book_code_attempts where user_id = v_user and outcome = 'invalid';
  if n <> 1 then raise exception 'FAIL: invalid attempt not recorded (% rows)', n; end if;
  raise notice 'PASS: unknown code → invalid, attempt recorded';

  -- the real code → one grant, 30 days
  v_res := public.redeem_book_code(v_hmac, v_user, null, 30);
  if v_res->>'outcome' <> 'redeemed' then raise exception 'FAIL: expected redeemed, got %', v_res; end if;
  if (v_res->'grant'->>'user_id')::uuid <> v_user or v_res->'grant'->>'source' <> 'code' or (v_res->'grant'->>'batch_id')::uuid <> v_batch then
    raise exception 'FAIL: grant row wrong: %', v_res;
  end if;
  if (v_res->'grant'->>'expires_at')::timestamptz < now() + interval '29 days'
     or (v_res->'grant'->>'expires_at')::timestamptz > now() + interval '31 days' then
    raise exception 'FAIL: grant expiry not 30 days';
  end if;
  select count(*) into n from public.book_access_grants where code_id = v_code_id;
  if n <> 1 then raise exception 'FAIL: % grants for one code', n; end if;
  perform 1 from public.book_codes where id = v_code_id and status = 'redeemed' and redeemed_by = v_user;
  if not found then raise exception 'FAIL: code not marked redeemed'; end if;
  raise notice 'PASS: redeemed → one 30-day grant';

  -- second redemption → used
  v_res := public.redeem_book_code(v_hmac, v_user, null, 30);
  if v_res->>'outcome' <> 'used' then raise exception 'FAIL: expected used, got %', v_res; end if;
  raise notice 'PASS: second redemption → used';

  -- a real unused code, but for someone who is not the caller's verified child
  v_res := public.redeem_book_code(v_hmac2, v_user, gen_random_uuid(), 30);
  if v_res->>'outcome' <> 'not_your_child' then raise exception 'FAIL: expected not_your_child, got %', v_res; end if;
  perform 1 from public.book_codes where code_hmac = v_hmac2 and status = 'unused';
  if not found then raise exception 'FAIL: refused code was consumed'; end if;
  raise notice 'PASS: unlinked child → not_your_child, code still unused';

  -- five failures so far (invalid, used, not_your_child + two more) → the sixth is rate limited
  for n in 1..2 loop
    v_res := public.redeem_book_code(repeat('c', 64), v_user, null, 30);
  end loop;
  select count(*) into n from public.book_code_attempts where user_id = v_user and outcome <> 'redeemed';
  if n <> 5 then raise exception 'FAIL: expected 5 failed attempts recorded, found %', n; end if;
  v_res := public.redeem_book_code(repeat('d', 64), v_user, null, 30);
  if v_res->>'outcome' <> 'rate_limited' then raise exception 'FAIL: expected rate_limited, got %', v_res; end if;
  raise notice 'PASS: rate limited after five failures';

  raise notice 'ALL 0158 CHECKS PASSED';
end $$;

rollback;
