-- SketchCast AI — homeschool tier + credit-pack verification for 0086
-- ============================================================================
-- Run in the Supabase SQL editor AFTER applying 0086_homeschool_tier.sql.
--
-- CAP BASELINE: 0107. Every seeded fill below is arithmetic against the caps
-- public.fair_use_caps returns, so this script has to move whenever they do —
-- it is hand-run, no CI reads .sql, and a stale number here reports a metering
-- regression that is really just an out-of-date seed. Pinned here:
--   trial 7 · pro 28 · homeschool 56 (0107; they were 6 · 24 · 48 under 0086).
-- A kit still COSTS SIX credits and the credit packs are still 6/18/36 — the
-- deck is the seventh piece and rides free (0103), so 0107 moved the ceiling,
-- never the price. Do not "scale" the pack sizes to match a cap.
-- Seeds throwaway users and drives the REAL triggers with direct inserts (the
-- strongest bypass attempt — every API call goes through the same triggers).
-- Proves, in order:
--   1. tier plumbing: homeschool caps (56/4), trial 96 → 7, plan_tier mapping;
--   2. learner cap: homeschool 10, others 2, console override wins;
--   3. consumption ORDER: monthly quota first, then the purchased balance
--      (ledger rows stamped source='plan' / 'purchase' accordingly);
--   4. purchased balance PERSISTS across months (plan meter resets, balance
--      doesn't);
--   5. 0078/0059 interplay: voiding a purchase-funded generation restores the
--      balance;
--   6. exhausted quota + exhausted/refunded balance BLOCKS;
--   7. a one-statement six-row kit splits plan/purchase correctly, and fails
--      WHOLE when the balance cannot cover its overflow (0075 atomicity).
-- Every check RAISEs on failure; a clean run prints PASS lines and
-- "ALL 0086 CHECKS PASSED", then ROLLS BACK (nothing persists).
-- ============================================================================
begin;

create or replace function _expect_block(stmt text, needle text, msg text) returns void
  language plpgsql as $$
declare blocked boolean := false; errm text := '';
begin
  begin
    execute stmt;
  exception when others then
    blocked := true; errm := sqlerrm;
  end;
  if not blocked then
    raise exception 'FAIL (was NOT blocked): %', msg;
  end if;
  if position(needle in errm) = 0 then
    raise exception 'FAIL (wrong error "%"): %', errm, msg;
  end if;
  raise notice 'PASS (blocked): %', msg;
end $$;

create or replace function _expect_ok(stmt text, msg text) returns void
  language plpgsql as $$
begin
  execute stmt;
  raise notice 'PASS (allowed): %', msg;
end $$;

create or replace function _expect_eq(actual anyelement, expected anyelement, msg text) returns void
  language plpgsql as $$
begin
  if actual is distinct from expected then
    raise exception 'FAIL (got %, wanted %): %', actual, expected, msg;
  end if;
  raise notice 'PASS (= %): %', expected, msg;
end $$;

do $$
declare
  H  uuid := '22222222-0000-0000-0000-00000000c001'; -- homeschool subscriber
  T  uuid := '22222222-0000-0000-0000-00000000c002'; -- free (trial) teacher
  P  uuid := '22222222-0000-0000-0000-00000000c003'; -- teacher pro, kit-split
  Q  uuid := '22222222-0000-0000-0000-00000000c004'; -- teacher pro, kit-blocked
  bh uuid := '66666666-0000-0000-0000-00000000c001';
  bt uuid := '66666666-0000-0000-0000-00000000c002';
  bp uuid := '66666666-0000-0000-0000-00000000c003';
  bq uuid := '66666666-0000-0000-0000-00000000c004';
  g1 uuid := '88888888-0000-0000-0000-00000000c001';
  g2 uuid := '88888888-0000-0000-0000-00000000c002';
  g3 uuid := '88888888-0000-0000-0000-00000000c003';
  g4 uuid := '88888888-0000-0000-0000-00000000c004';
  i  int;
  n  int;
begin
  insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at)
  select '00000000-0000-0000-0000-000000000000', u, 'authenticated', 'authenticated',
         u::text || '@packtest.example.com', now(), now()
  from unnest(array[H, T, P, Q]) as u
  on conflict (id) do nothing;

  insert into profiles (id, role, school_id) values
    (H, 'teacher', null), (T, 'teacher', null), (P, 'teacher', null), (Q, 'teacher', null)
  on conflict (id) do update set role = excluded.role, school_id = excluded.school_id,
    max_books = null, max_chapters = null, max_children = null;

  insert into entitlements (user_id, active, plan_key, status) values
    (H, true, 'homeschool_monthly', 'active'),
    (P, true, 'teacher_pro_monthly', 'active'),
    (Q, true, 'teacher_pro_annual',  'active');

  -- ── 1. Tier plumbing ─────────────────────────────────────────────────────
  perform _expect_eq(plan_tier(H), 'homeschool', 'homeschool_% entitlement maps to tier homeschool');
  perform _expect_eq(plan_tier(T), 'trial',      'no entitlement (promo over) = trial');
  perform _expect_eq((select parts_cap from fair_use_caps('homeschool')), 56, 'homeschool = 56 generations/month');
  perform _expect_eq((select books_cap from fair_use_caps('homeschool')), 4,  'homeschool = 4 books/month');
  perform _expect_eq((select parts_cap from fair_use_caps('trial')), 7,       'trial dropped 96 -> 7 (= one kit, the 0057 pin)');

  -- ── 2. Learner cap ───────────────────────────────────────────────────────
  perform _expect_eq(learners_cap(H), 10, 'homeschool learner cap = 10');
  perform _expect_eq(learners_cap(T), 2,  'non-homeschool learner default stays 2');
  update profiles set max_children = 4 where id = H;
  perform _expect_eq(learners_cap(H), 4,  'console max_children override wins');
  update profiles set max_children = null where id = H;

  -- ── 3. Consumption order: monthly quota FIRST, then purchased ────────────
  insert into books (id, title, owner_id) values (bh, 'H Book', H);
  -- Fill 55 of the 56 plan credits with a synthetic ledger row (units carry
  -- the weight; fair_use_used sums units).
  insert into credit_ledger (owner_id, kind, units, part, source, created_at)
  values (H, 'presentation', 55, 0, 'plan', now() - interval '1 hour');

  perform _expect_ok(
    format('insert into generations (id, kind, book_id, chapter_ref, owner_id) values (%L, ''presentation'', %L, ''1'', %L)', g1, bh, H),
    'homeschool: 56th generation admitted on plan quota');
  perform _expect_eq((select source from credit_ledger where generation_id = g1), 'plan',
    'row 56/56 charged to the PLAN pool');

  perform _expect_block(
    format('insert into generations (id, kind, book_id, chapter_ref, owner_id) values (%L, ''presentation'', %L, ''2'', %L)', g2, bh, H),
    'Monthly limit reached', 'quota spent + no balance = blocked');

  insert into credit_purchases (owner_id, credits, pack_key, usd, ls_order_id)
  values (H, 6, 'pack_6', 8.00, 'ord_h_1');
  perform _expect_eq(fair_use_purchased_remaining(H), 6, 'pack credited: balance 6');

  perform _expect_ok(
    format('insert into generations (id, kind, book_id, chapter_ref, owner_id) values (%L, ''presentation'', %L, ''2'', %L)', g2, bh, H),
    'same insert now admitted on the purchased balance');
  perform _expect_eq((select source from credit_ledger where generation_id = g2), 'purchase',
    'overflow row charged to the PURCHASE pool');
  perform _expect_eq(fair_use_purchased_remaining(H), 5, 'balance drawn to 5');

  -- ── 4. Balance persists across months ────────────────────────────────────
  -- Simulate the month rolling over: plan-sourced rows age out of the window.
  -- (The purchase-sourced row deliberately stays put — the balance is
  -- windowless, so WHERE it sits in time must not matter.)
  update credit_ledger set created_at = created_at - interval '35 days'
   where owner_id = H and source = 'plan';
  perform _expect_ok(
    format('insert into generations (id, kind, book_id, chapter_ref, owner_id) values (%L, ''presentation'', %L, ''3'', %L)', g3, bh, H),
    'new month: plan quota is back');
  perform _expect_eq((select source from credit_ledger where generation_id = g3), 'plan',
    'fresh-month row charged to PLAN again (quota first)');
  perform _expect_eq(fair_use_purchased_remaining(H), 5,
    'purchased balance UNCHANGED by the month rollover');

  -- ── 5. 0078/0059 interplay: voiding restores the pool that paid ──────────
  update generations set status = 'error' where id = g2; -- worker-error path (credit_ledger_sync)
  perform _expect_eq((select voided from credit_ledger where generation_id = g2), true,
    'error transition voided the purchase-funded row');
  perform _expect_eq(fair_use_purchased_remaining(H), 6, 'void restored the balance to 6');

  -- ── 6. Exhausted quota + exhausted/refunded balance blocks ───────────────
  insert into credit_ledger (owner_id, kind, units, part, source)
  values (H, 'presentation', 56, 0, 'plan'); -- burn this month's quota (56 + g3 = 57 used)
  perform _expect_ok(
    format('insert into generations (id, kind, book_id, chapter_ref, owner_id) values (%L, ''presentation'', %L, ''4'', %L)', g4, bh, H),
    'over-quota generation rides the balance');
  perform _expect_eq((select source from credit_ledger where generation_id = g4), 'purchase',
    'over-quota row charged to PURCHASE');
  update credit_purchases set refunded_at = now() where ls_order_id = 'ord_h_1';
  perform _expect_eq(fair_use_purchased_remaining(H), 0,
    'refunded pack stops contributing (spent credits stand, clamped at 0)');
  perform _expect_block(
    format('insert into generations (kind, book_id, chapter_ref, owner_id) values (''presentation'', %L, ''5'', %L)', bh, H),
    'Monthly limit reached', 'no quota + no live balance = blocked');

  -- ── Trial: 7 = exactly one kit; a leftover balance still spends ──────────
  insert into books (id, title, owner_id) values (bt, 'T Book', T);
  for i in 1..7 loop
    -- Staggered created_at keeps each retry outside 0076's 10-second
    -- duplicate window; all rows stay inside the current month.
    insert into generations (kind, book_id, chapter_ref, owner_id, created_at)
    values ('presentation', bt, '0', T, now() - interval '10 minutes' + (i * interval '30 seconds'));
  end loop;
  raise notice 'PASS (allowed): trial: seven generations of the pinned unit';
  perform _expect_block(
    format('insert into generations (kind, book_id, chapter_ref, owner_id) values (''presentation'', %L, ''0'', %L)', bt, T),
    'Monthly limit reached', 'trial blocked at 8 (cap is 7 now, was 96)');
  -- A pack balance held by a (lapsed) free account still spends — purchased
  -- credits never expire, so a subscriber who lapses keeps what they paid for.
  insert into credit_purchases (owner_id, credits, pack_key, usd, ls_order_id)
  values (T, 6, 'pack_6', 8.00, 'ord_t_1');
  perform _expect_ok(
    format('insert into generations (kind, book_id, chapter_ref, owner_id) values (''presentation'', %L, ''0'', %L)', bt, T),
    'trial + purchased balance: 8th generation admitted');
  perform _expect_eq(fair_use_purchased_remaining(T), 5, 'trial drawdown hit the balance');

  -- ── 7. One-statement kit: split correctly / fail whole ───────────────────
  -- P: 25/28 plan used, balance 3 (pack 6 minus 3 already drawn). A kit is
  -- still SIX rows and SIX credits — 0107 moved the cap, not the price.
  insert into books (id, title, owner_id) values (bp, 'P Book', P);
  insert into credit_ledger (owner_id, kind, units, part, source, created_at)
  values (P, 'presentation', 25, 0, 'plan', now() - interval '1 hour');
  insert into credit_purchases (owner_id, credits, pack_key, usd, ls_order_id)
  values (P, 6, 'pack_6', 8.00, 'ord_p_1');
  insert into credit_ledger (owner_id, kind, units, part, source, created_at)
  values (P, 'presentation', 3, 0, 'purchase', now() - interval '1 hour');
  perform _expect_eq(fair_use_purchased_remaining(P), 3, 'P starts with balance 3');

  perform _expect_ok(
    format($k$insert into generations (kind, book_id, chapter_ref, owner_id) values
      ('presentation', %L, '1', %L),
      ('worksheet',    %L, '1', %L),
      ('exam_paper',   %L, '1', %L),
      ('lesson_plan',  %L, '1', %L),
      ('activity',     %L, '1', %L),
      ('case_study',   %L, '1', %L)$k$, bp, P, bp, P, bp, P, bp, P, bp, P, bp, P),
    'six-row kit with 3 plan + 3 purchased available succeeds whole');
  select count(*) into n from credit_ledger cl
   join generations g on g.id = cl.generation_id
   where g.owner_id = P and cl.source = 'plan';
  perform _expect_eq(n, 3, 'kit: exactly 3 rows charged to plan');
  select count(*) into n from credit_ledger cl
   join generations g on g.id = cl.generation_id
   where g.owner_id = P and cl.source = 'purchase';
  perform _expect_eq(n, 3, 'kit: exactly 3 rows charged to purchase');
  perform _expect_eq(fair_use_purchased_remaining(P), 0, 'kit drained the balance to 0');

  -- Q: same shape but balance only 2 — the kit must fail WHOLE (atomic).
  insert into books (id, title, owner_id) values (bq, 'Q Book', Q);
  insert into credit_ledger (owner_id, kind, units, part, source, created_at)
  values (Q, 'presentation', 25, 0, 'plan', now() - interval '1 hour');
  insert into credit_purchases (owner_id, credits, pack_key, usd, ls_order_id)
  values (Q, 6, 'pack_6', 8.00, 'ord_q_1');
  insert into credit_ledger (owner_id, kind, units, part, source, created_at)
  values (Q, 'presentation', 4, 0, 'purchase', now() - interval '1 hour');
  perform _expect_eq(fair_use_purchased_remaining(Q), 2, 'Q starts with balance 2');
  perform _expect_block(
    format($k$insert into generations (kind, book_id, chapter_ref, owner_id) values
      ('presentation', %L, '1', %L),
      ('worksheet',    %L, '1', %L),
      ('exam_paper',   %L, '1', %L),
      ('lesson_plan',  %L, '1', %L),
      ('activity',     %L, '1', %L),
      ('case_study',   %L, '1', %L)$k$, bq, Q, bq, Q, bq, Q, bq, Q, bq, Q, bq, Q),
    'Monthly limit reached', 'kit needing 3 purchased credits fails whole on balance 2');
  select count(*) into n from generations where owner_id = Q;
  perform _expect_eq(n, 0, 'failed kit left NO generations behind (atomic)');

  -- ── Homeschool book cap: 4/month ─────────────────────────────────────────
  perform _expect_ok(
    format('insert into books (title, owner_id) values (''H2'', %L)', H), 'homeschool book 2');
  perform _expect_ok(
    format('insert into books (title, owner_id) values (''H3'', %L)', H), 'homeschool book 3');
  perform _expect_ok(
    format('insert into books (title, owner_id) values (''H4'', %L)', H), 'homeschool book 4');
  perform _expect_block(
    format('insert into books (title, owner_id) values (''H5'', %L)', H),
    'books/month', 'homeschool blocked at book 5 (cap 4)');

  raise notice '================ ALL 0086 CHECKS PASSED ================';
end $$;

rollback;
