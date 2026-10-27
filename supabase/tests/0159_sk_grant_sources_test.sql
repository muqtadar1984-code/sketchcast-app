-- SketchCast AI — verification for 0159 (SK grant sources: purchase + edition code)
-- ============================================================================
-- Run AFTER applying 0159. Proves:
--   1. the schema: new sources allowed, expires_at nullable, tutor_expires_at
--      present, edition_codes / order_claims / book_purchases exist with RLS
--      on and NO policies, sk_book_products.ls_product_id exists, the four
--      functions exist and are withheld from anon/authenticated;
--   2. the back-fill: no grant is left with a NULL tutor window or a non-NULL
--      book expiry (every pre-0159 row became permanent book access);
--   3. a purchase: parked by email grants nothing; claim_book_purchases()
--      binds it and creates ONE 'purchase' grant with expires_at NULL and a
--      30-day tutor window; a second claim binds nothing; a re-delivered order
--      is 'duplicate'; a known buyer is granted at once; a refund revokes the
--      grant; a refund-before-create leaves a tombstone the create no-ops on;
--   4. an edition code: redeemed → one 'edition_code' grant (permanent book,
--      30-day tutoring, the edition's allowance) + one order claim; the same
--      order number again → order_used with nothing consumed; an unlinked
--      child → not_your_child (no slot used); the daily cap; a revoked edition
--      and an unknown code → invalid; five failures → rate_limited — every
--      attempt leaving a book_code_attempts row;
--   5. RLS unchanged: as `authenticated`, a student sees only their own grants
--      and cannot read the staff-only tables at all (privilege denied).
-- Passed on the sk-b1 branch database 2026-10-27 (after the rollback file had
-- been run and the final 0159 re-applied on the same branch).
-- Every check RAISEs on failure; a clean run prints PASS lines and
-- "ALL 0159 CHECKS PASSED", then ROLLS BACK (nothing persists).
-- ============================================================================
begin;

do $$
declare
  t text;
  n bigint;
  v_prod uuid; v_user uuid; v_other uuid; v_ed uuid; v_ed_revoked uuid; v_res jsonb; v_grant uuid; v_grant2 uuid;
  v_code  text := repeat('1', 64);   -- HMACs are opaque 64-hex strings; any distinct values do
  v_code2 text := repeat('2', 64);
  v_ord1  text := repeat('a', 64);
  v_ord2  text := repeat('b', 64);
  v_ord3  text := repeat('c', 64);
  v_ord4  text := repeat('d', 64);
begin
  -- ── 1. schema ─────────────────────────────────────────────────────────────
  foreach t in array array['edition_codes','order_claims','book_purchases'] loop
    perform 1 from pg_tables where schemaname = 'public' and tablename = t;
    if not found then raise exception 'FAIL: table % missing', t; end if;
    perform 1 from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = 'public' and c.relname = t and c.relrowsecurity;
    if not found then raise exception 'FAIL: RLS off on %', t; end if;
    select count(*) into n from pg_policies where schemaname = 'public' and tablename = t;
    if n <> 0 then raise exception 'FAIL: % has % policies (expected none)', t, n; end if;
  end loop;
  perform 1 from pg_policies where schemaname='public' and tablename='book_access_grants' and policyname='sk_grants_read_own';
  if not found then raise exception 'FAIL: sk_grants_read_own missing'; end if;
  select count(*) into n from pg_policies where schemaname='public' and tablename='book_access_grants';
  if n <> 1 then raise exception 'FAIL: book_access_grants has % policies (expected the one from 0158)', n; end if;
  perform 1 from information_schema.columns where table_schema='public' and table_name='book_access_grants' and column_name='expires_at' and is_nullable='YES';
  if not found then raise exception 'FAIL: book_access_grants.expires_at still NOT NULL'; end if;
  perform 1 from information_schema.columns where table_schema='public' and table_name='book_access_grants' and column_name='tutor_expires_at';
  if not found then raise exception 'FAIL: book_access_grants.tutor_expires_at missing'; end if;
  perform 1 from information_schema.columns where table_schema='public' and table_name='sk_book_products' and column_name='ls_product_id';
  if not found then raise exception 'FAIL: sk_book_products.ls_product_id missing'; end if;
  foreach t in array array['redeem_edition_code','record_book_purchase','claim_book_purchases','refund_book_purchase'] loop
    perform 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace where ns.nspname = 'public' and p.proname = t;
    if not found then raise exception 'FAIL: function % missing', t; end if;
  end loop;
  if has_function_privilege('anon', 'public.redeem_edition_code(text, text, uuid, uuid, integer, text)', 'execute')
     or has_function_privilege('authenticated', 'public.redeem_edition_code(text, text, uuid, uuid, integer, text)', 'execute')
     or has_function_privilege('authenticated', 'public.record_book_purchase(text, uuid, uuid, text, integer, text, text, boolean, integer, jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.claim_book_purchases(uuid, text, integer, jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.refund_book_purchase(text, uuid, text)', 'execute') then
    raise exception 'FAIL: a 0159 function is callable by anon/authenticated';
  end if;
  -- privileges: the read-own policies are reachable (SELECT for authenticated), nothing wider, nothing for anon
  if not has_table_privilege('authenticated', 'public.book_access_grants', 'select') then
    raise exception 'FAIL: authenticated cannot select book_access_grants (sk_grants_read_own unreachable)';
  end if;
  foreach t in array array['book_access_grants','sk_usage','consents'] loop
    if has_table_privilege('authenticated', 'public.' || t, 'insert') or has_table_privilege('authenticated', 'public.' || t, 'update')
       or has_table_privilege('authenticated', 'public.' || t, 'delete') or has_table_privilege('anon', 'public.' || t, 'select') then
      raise exception 'FAIL: % privileges wider than read-own', t;
    end if;
  end loop;
  foreach t in array array['edition_codes','order_claims','book_purchases','book_codes','publishers','print_batches','book_code_attempts'] loop
    if has_table_privilege('authenticated', 'public.' || t, 'select') or has_table_privilege('anon', 'public.' || t, 'select') then
      raise exception 'FAIL: staff table % readable by anon/authenticated', t;
    end if;
  end loop;
  raise notice 'PASS: schema, RLS, privileges, functions withheld';

  -- ── 2. back-fill ──────────────────────────────────────────────────────────
  select count(*) into n from public.book_access_grants where expires_at is not null;
  if n <> 0 then raise exception 'FAIL: % grants still carry a book expiry after the back-fill', n; end if;
  select count(*) into n from public.book_access_grants where tutor_expires_at is null;
  if n <> 0 then raise exception 'FAIL: % grants have no tutor window after the back-fill', n; end if;
  -- the 0158 shape is refused now: a 'code' grant without tutor_expires_at is
  -- still legal SQL (the column is nullable) — but a source outside the list is not
  begin
    insert into public.book_access_grants (user_id, product_id, source, tutor_expires_at)
    values (gen_random_uuid(), gen_random_uuid(), 'gift', now());
    raise exception 'FAIL: unknown source accepted';
  exception when check_violation then null;
           when foreign_key_violation then null; -- the user does not exist; the check fired or the FK did — either refuses
  end;
  raise notice 'PASS: back-fill — every grant permanent, every grant with a tutor window';

  -- ── scenario data (rolled back) ───────────────────────────────────────────
  select id into v_user from public.profiles order by id limit 1;
  select id into v_other from public.profiles where id <> v_user order by id limit 1;
  if v_user is null then
    v_user := gen_random_uuid();
    insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
      values (v_user, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'sk-0159-a@example.invalid', now(), now());
    insert into public.profiles (id, role, full_name) values (v_user, 'student', '0159 test A');
  end if;
  if v_other is null then
    v_other := gen_random_uuid();
    insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
      values (v_other, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'sk-0159-b@example.invalid', now(), now());
    insert into public.profiles (id, role, full_name) values (v_other, 'student', '0159 test B');
  end if;
  delete from public.book_code_attempts where user_id in (v_user, v_other); -- a clean hour for the rate-limit count
  insert into public.sk_book_products (slug, title, ls_product_id) values ('sk-0159-test-book', '0159 test book', 'ls-0159-test') returning id into v_prod;

  -- ── 3. purchases ──────────────────────────────────────────────────────────
  -- public-link purchase: parked, no grant
  v_res := public.record_book_purchase('ord-0159-1', v_prod, null, 'Buyer@Example.invalid', 1900, 'usd', 'paid', false, 30, '{"live_turns": 300}'::jsonb);
  if v_res->>'outcome' <> 'parked' then raise exception 'FAIL: expected parked, got %', v_res; end if;
  perform 1 from public.book_purchases where ls_order_id = 'ord-0159-1' and owner_id is null and claim_email = 'buyer@example.invalid' and grant_id is null;
  if not found then raise exception 'FAIL: parked purchase row wrong'; end if;
  select count(*) into n from public.book_access_grants where product_id = v_prod;
  if n <> 0 then raise exception 'FAIL: a parked purchase granted access'; end if;
  -- re-delivery → duplicate, nothing changes
  v_res := public.record_book_purchase('ord-0159-1', v_prod, null, 'buyer@example.invalid', 1900, 'usd', 'paid', false, 30, null);
  if v_res->>'outcome' <> 'duplicate' then raise exception 'FAIL: expected duplicate, got %', v_res; end if;
  -- a different email claims nothing
  v_res := public.claim_book_purchases(v_user, 'someone-else@example.invalid', 30, '{"live_turns": 300}'::jsonb);
  if (v_res->>'bound')::int <> 0 then raise exception 'FAIL: wrong email bound a purchase: %', v_res; end if;
  -- the verified buyer signs in → bound, ONE permanent grant with a 30-day tutor window
  v_res := public.claim_book_purchases(v_user, 'buyer@example.invalid', 30, '{"live_turns": 300}'::jsonb);
  if (v_res->>'bound')::int <> 1 then raise exception 'FAIL: expected 1 bound, got %', v_res; end if;
  select id into v_grant from public.book_access_grants where user_id = v_user and product_id = v_prod and source = 'purchase';
  if v_grant is null then raise exception 'FAIL: no purchase grant after claim'; end if;
  perform 1 from public.book_access_grants where id = v_grant and expires_at is null
     and tutor_expires_at between now() + interval '29 days' and now() + interval '31 days'
     and usage_allowance = '{"live_turns": 300}'::jsonb and revoked_at is null;
  if not found then raise exception 'FAIL: purchase grant shape wrong (expires_at must be NULL, tutor window 30 d)'; end if;
  perform 1 from public.book_purchases where ls_order_id = 'ord-0159-1' and owner_id = v_user and claim_email is null and grant_id = v_grant;
  if not found then raise exception 'FAIL: purchase not bound to the buyer'; end if;
  v_res := public.claim_book_purchases(v_user, 'buyer@example.invalid', 30, null);
  if (v_res->>'bound')::int <> 0 then raise exception 'FAIL: second claim bound again: %', v_res; end if;
  select count(*) into n from public.book_access_grants where user_id = v_user and product_id = v_prod;
  if n <> 1 then raise exception 'FAIL: % purchase grants for one order', n; end if;
  raise notice 'PASS: parked purchase → claimed once → one permanent grant (NULL expires_at, 30-day tutoring)';

  -- in-app purchase by a known buyer → granted at once
  v_res := public.record_book_purchase('ord-0159-2', v_prod, v_other, 'other@example.invalid', 1900, 'usd', 'paid', false, 30, null);
  if v_res->>'outcome' <> 'granted' then raise exception 'FAIL: expected granted, got %', v_res; end if;
  v_grant2 := (v_res->'grant'->>'id')::uuid;
  if (v_res->'grant'->>'user_id')::uuid <> v_other or v_res->'grant'->>'source' <> 'purchase' or (v_res->'grant'->>'expires_at') is not null then
    raise exception 'FAIL: granted row wrong: %', v_res;
  end if;
  -- refund → the grant is revoked (book AND tutoring)
  v_res := public.refund_book_purchase('ord-0159-2', v_prod, 'other@example.invalid');
  if v_res->>'outcome' <> 'refunded' or (v_res->>'grant_revoked')::boolean is not true then raise exception 'FAIL: refund outcome %', v_res; end if;
  perform 1 from public.book_access_grants where id = v_grant2 and revoked_at is not null;
  if not found then raise exception 'FAIL: refunded purchase grant not revoked'; end if;
  perform 1 from public.book_purchases where ls_order_id = 'ord-0159-2' and refunded_at is not null;
  if not found then raise exception 'FAIL: purchase not stamped refunded'; end if;
  -- refund BEFORE create → tombstone; the retried create no-ops and grants nothing
  v_res := public.refund_book_purchase('ord-0159-3', v_prod, 'late@example.invalid');
  if v_res->>'outcome' <> 'tombstone' then raise exception 'FAIL: expected tombstone, got %', v_res; end if;
  v_res := public.record_book_purchase('ord-0159-3', v_prod, v_other, 'late@example.invalid', 1900, 'usd', 'paid', false, 30, null);
  if v_res->>'outcome' <> 'duplicate' then raise exception 'FAIL: create after tombstone should be duplicate, got %', v_res; end if;
  v_res := public.claim_book_purchases(v_other, 'late@example.invalid', 30, null);
  if (v_res->>'bound')::int <> 0 then raise exception 'FAIL: a refunded tombstone was claimed'; end if;
  select count(*) into n from public.book_access_grants where user_id = v_other and product_id = v_prod;
  if n <> 1 then raise exception 'FAIL: expected exactly the (revoked) grant for v_other, found %', n; end if;
  raise notice 'PASS: known buyer granted at once; refund revokes; refund-before-create tombstone';

  -- ── 4. edition code (KDP) ─────────────────────────────────────────────────
  insert into public.edition_codes (product_id, edition, code_hmac, daily_cap, usage_allowance)
    values (v_prod, 'kdp-test-1', v_code, 2, '{"live_turns": 120}'::jsonb) returning id into v_ed;
  insert into public.edition_codes (product_id, edition, code_hmac, status)
    values (v_prod, 'kdp-test-revoked', v_code2, 'revoked') returning id into v_ed_revoked;
  select count(*) into n from public.book_access_grants where user_id = v_user and source = 'edition_code';
  if n <> 0 then raise exception 'FAIL: edition grants present before the test'; end if;

  -- unknown code → invalid (failure 1)
  v_res := public.redeem_edition_code(repeat('9', 64), v_ord1, v_user, null, 30);
  if v_res->>'outcome' <> 'invalid' then raise exception 'FAIL: expected invalid, got %', v_res; end if;
  select count(*) into n from public.book_code_attempts where user_id = v_user and outcome = 'invalid';
  if n <> 1 then raise exception 'FAIL: invalid attempt not recorded'; end if;

  -- happy path: edition code + order 1 → one grant, one claim
  v_res := public.redeem_edition_code(v_code, v_ord1, v_user, null, 30);
  if v_res->>'outcome' <> 'redeemed' then raise exception 'FAIL: expected redeemed, got %', v_res; end if;
  v_grant := (v_res->'grant'->>'id')::uuid;
  perform 1 from public.book_access_grants where id = v_grant and user_id = v_user and product_id = v_prod and source = 'edition_code'
     and edition_code_id = v_ed and expires_at is null
     and tutor_expires_at between now() + interval '29 days' and now() + interval '31 days'
     and usage_allowance = '{"live_turns": 120}'::jsonb;
  if not found then raise exception 'FAIL: edition grant shape wrong: %', v_res; end if;
  perform 1 from public.order_claims where order_hmac = v_ord1 and edition_code_id = v_ed and grant_id = v_grant and user_id = v_user and channel = 'kdp';
  if not found then raise exception 'FAIL: order claim missing'; end if;
  raise notice 'PASS: edition code + order number → permanent grant, 30-day tutoring, order claimed';

  -- the same order number again → order_used, nothing consumed (failure 2)
  v_res := public.redeem_edition_code(v_code, v_ord1, v_user, null, 30);
  if v_res->>'outcome' <> 'order_used' then raise exception 'FAIL: expected order_used, got %', v_res; end if;
  select count(*) into n from public.book_access_grants where user_id = v_user and source = 'edition_code';
  if n <> 1 then raise exception 'FAIL: order reuse minted a grant (% grants)', n; end if;
  select count(*) into n from public.order_claims where edition_code_id = v_ed;
  if n <> 1 then raise exception 'FAIL: order reuse added a claim'; end if;
  -- the same order number on ANOTHER edition → order_used too (unique index path)
  update public.edition_codes set status = 'active' where id = v_ed_revoked;
  v_res := public.redeem_edition_code(v_code2, v_ord1, v_user, null, 30);
  if v_res->>'outcome' <> 'order_used' then raise exception 'FAIL: cross-edition reuse expected order_used, got %', v_res; end if;
  update public.edition_codes set status = 'revoked' where id = v_ed_revoked;
  select count(*) into n from public.book_access_grants where user_id = v_user and source = 'edition_code';
  if n <> 1 then raise exception 'FAIL: cross-edition reuse minted a grant'; end if;
  -- that was failure 3; clear it so the count below stays readable
  delete from public.book_code_attempts where user_id = v_user and outcome = 'order_used' and id = (select max(id) from public.book_code_attempts where user_id = v_user and outcome = 'order_used');
  raise notice 'PASS: order number reuse refused, same edition and across editions';

  -- an unlinked child → not_your_child, no slot used (failure 3)
  v_res := public.redeem_edition_code(v_code, v_ord2, v_user, gen_random_uuid(), 30);
  if v_res->>'outcome' <> 'not_your_child' then raise exception 'FAIL: expected not_your_child, got %', v_res; end if;
  select count(*) into n from public.order_claims where edition_code_id = v_ed;
  if n <> 1 then raise exception 'FAIL: refused child claim consumed a slot'; end if;
  -- order 2 → the second (and last) slot of the day
  v_res := public.redeem_edition_code(v_code, v_ord2, v_user, null, 30);
  if v_res->>'outcome' <> 'redeemed' then raise exception 'FAIL: second order expected redeemed, got %', v_res; end if;
  -- order 3 → daily cap (failure 4)
  v_res := public.redeem_edition_code(v_code, v_ord3, v_user, null, 30);
  if v_res->>'outcome' <> 'daily_cap' then raise exception 'FAIL: expected daily_cap, got %', v_res; end if;
  select count(*) into n from public.order_claims where edition_code_id = v_ed;
  if n <> 2 then raise exception 'FAIL: cap did not hold (% claims)', n; end if;
  -- a claim older than 24 h no longer counts
  update public.order_claims set created_at = now() - interval '25 hours' where order_hmac = v_ord1;
  v_res := public.redeem_edition_code(v_code, v_ord3, v_user, null, 30);
  if v_res->>'outcome' <> 'redeemed' then raise exception 'FAIL: cap should roll after 24 h, got %', v_res; end if;
  raise notice 'PASS: daily cap holds for 24 h then rolls';

  -- revoked edition → invalid (failure 5)
  v_res := public.redeem_edition_code(v_code2, v_ord4, v_user, null, 30);
  if v_res->>'outcome' <> 'invalid' then raise exception 'FAIL: revoked edition expected invalid, got %', v_res; end if;
  select count(*) into n from public.book_code_attempts where user_id = v_user and outcome <> 'redeemed';
  if n <> 5 then raise exception 'FAIL: expected 5 failed attempts recorded, found %', n; end if;
  -- the sixth call is rate limited, even with a valid code + fresh order number
  v_res := public.redeem_edition_code(v_code, v_ord4, v_user, null, 30);
  if v_res->>'outcome' <> 'rate_limited' then raise exception 'FAIL: expected rate_limited, got %', v_res; end if;
  perform 1 from public.book_code_attempts where user_id = v_user and outcome = 'rate_limited';
  if not found then raise exception 'FAIL: rate_limited attempt not recorded'; end if;
  select count(*) into n from public.order_claims where order_hmac = v_ord4;
  if n <> 0 then raise exception 'FAIL: a rate-limited call claimed an order'; end if;
  raise notice 'PASS: rate limited after five failures, every attempt recorded';

  -- ── 5. RLS unchanged: a student reads their own grants only ───────────────
  perform set_config('request.jwt.claims', json_build_object('sub', v_user, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.book_access_grants where user_id <> v_user;
  if n <> 0 then raise exception 'FAIL: authenticated sees % other users'' grants', n; end if;
  select count(*) into n from public.book_access_grants where user_id = v_user and product_id = v_prod;
  if n <> 4 then raise exception 'FAIL: student sees % of their own 4 grants', n; end if;
  foreach t in array array['edition_codes','order_claims','book_purchases'] loop
    begin
      execute format('select count(*) from public.%I', t) into n;
      raise exception 'FAIL: authenticated can read % (% rows)', t, n;
    exception when insufficient_privilege then null; -- the staff table is closed at the privilege level
    end;
  end loop;
  perform set_config('request.jwt.claims', json_build_object('sub', v_other, 'role', 'authenticated')::text, true);
  select count(*) into n from public.book_access_grants where product_id = v_prod;
  if n <> 1 then raise exception 'FAIL: the other student sees % grants (expected only their own, revoked one)', n; end if;
  reset role;
  raise notice 'PASS: RLS — own grants only; staff tables invisible';

  raise notice 'ALL 0159 CHECKS PASSED';
end $$;

rollback;
