-- 0022 billing RLS assertions — run in the Supabase SQL editor AFTER 0022.
-- Self-rolling-back: everything happens inside a transaction that ends in
-- ROLLBACK; no data is left behind. "Success. No rows returned" = PASS
-- (the editor may swallow RAISE NOTICE output).

begin;

do $$
declare
  v_school  uuid;
  v_teacher uuid := gen_random_uuid();
  v_student uuid := gen_random_uuid();
  v_other   uuid := gen_random_uuid();
  n int;
begin
  -- Seed a school + three profiles (bypass the auth.users FK via direct rows
  -- if the FK blocks, surface loudly).
  insert into schools (name) values ('RLS Billing Test School') returning id into v_school;
  begin
    insert into auth.users (id, email) values
      (v_teacher, 'rls-billing-teacher@test.local'),
      (v_student, 'rls-billing-student@test.local'),
      (v_other,   'rls-billing-other@test.local');
  exception when others then
    raise exception 'Could not seed auth.users for the test: %', sqlerrm;
  end;
  insert into profiles (id, full_name, role, school_id) values
    (v_teacher, 'RLS Teacher', 'teacher', v_school),
    (v_student, 'RLS Student', 'student', v_school),
    (v_other,   'RLS Other Teacher', 'teacher', null)
  on conflict (id) do update set role = excluded.role, school_id = excluded.school_id;

  -- Service-side rows (as the webhook would write them).
  insert into billing_customers (user_id, school_id, stripe_customer_id, role)
    values (v_teacher, v_school, 'cus_rls_test', 'teacher');
  insert into entitlements (user_id, school_id, active, plan_key, status)
    values (v_teacher, v_school, true, 'teacher_monthly', 'active');

  -- ── teacher sees their own rows ─────────────────────────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub', v_teacher, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  select count(*) into n from entitlements;
  if n <> 1 then raise exception 'FAIL: teacher should see exactly their own entitlement, saw %', n; end if;

  -- teacher cannot WRITE billing tables
  begin
    insert into entitlements (user_id, active) values (v_teacher, true);
    raise exception 'FAIL: client insert into entitlements must be denied';
  exception when insufficient_privilege or check_violation then null;
  end;
  begin
    update entitlements set active = true where user_id = v_teacher;
    -- RLS with no UPDATE policy silently updates 0 rows only if a permissive
    -- policy existed; with none + revoke, expect a privilege error instead.
    if found then raise exception 'FAIL: client update on entitlements must be denied'; end if;
  exception when insufficient_privilege then null;
  end;

  -- ── another (unrelated) adult sees nothing ──────────────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub', v_other, 'role', 'authenticated')::text, true);
  select count(*) into n from entitlements;
  if n <> 0 then raise exception 'FAIL: unrelated adult must see 0 entitlements, saw %', n; end if;
  select count(*) into n from billing_customers;
  if n <> 0 then raise exception 'FAIL: unrelated adult must see 0 billing_customers, saw %', n; end if;

  -- ── student sees nothing, ever ──────────────────────────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub', v_student, 'role', 'authenticated')::text, true);
  select count(*) into n from entitlements;
  if n <> 0 then raise exception 'FAIL: student must see 0 entitlements, saw %', n; end if;
  select count(*) into n from billing_customers;
  if n <> 0 then raise exception 'FAIL: student must see 0 billing_customers, saw %', n; end if;
  select count(*) into n from subscriptions;
  if n <> 0 then raise exception 'FAIL: student must see 0 subscriptions, saw %', n; end if;
  select count(*) into n from payments;
  if n <> 0 then raise exception 'FAIL: student must see 0 payments, saw %', n; end if;

  -- ── webhook_events is invisible to every client ─────────────────────────
  begin
    select count(*) into n from webhook_events;
    raise exception 'FAIL: webhook_events must not be readable by clients';
  exception when insufficient_privilege then null;
  end;

  perform set_config('role', 'postgres', true);
  raise notice 'PASS: all 0022 billing RLS assertions held';
end $$;

rollback;
