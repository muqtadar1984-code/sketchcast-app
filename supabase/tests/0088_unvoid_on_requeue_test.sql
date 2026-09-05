-- SketchCast AI — requeue-to-success un-void verification for 0088
-- ============================================================================
-- Run in the Supabase SQL editor AFTER applying 0088_unvoid_on_requeued_success.sql.
--
-- CAP BASELINE: 0107 (trial 7 · pro 28 · homeschool 56). The seeded quota fills
-- below are arithmetic against public.fair_use_caps, so they move when it does.
-- A kit still costs SIX credits — the deck rides free (0103).
-- Seeds throwaway users and drives the REAL trigger with the same plain
-- status UPDATEs the worker's finish_job and every requeue path issue.
-- Proves, in order:
--   1. error → voided + labelled worker_error, meter refunds (0059/0078
--      behaviour unchanged);
--   2. the requeue legs (error → queued → processing) keep the refund —
--      credits are charged on delivery, never mid-retry;
--   3. landing 'done' un-voids (voided=false, void_reason NULL) and
--      fair_use_used counts the row again;
--   4. the done → error → done cycle stays stable (re-void, re-charge);
--   5. a presentation whose successful re-run wrote video_parts while its
--      row was voided gets units resynced at un-void time — and one whose
--      re-run wrote NO video_parts (single-part render) keeps its part-map
--      seeded units, exactly like a first-try success;
--   6. purchase-funded rows re-draw the purchased balance on un-void
--      (error restores it, requeued success takes it back);
--   7. 0078 'unconsumed_on_delete' voids are never resurrected.
-- Every check RAISEs on failure; a clean run prints PASS lines and
-- "ALL 0088 CHECKS PASSED", then ROLLS BACK (nothing persists).
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

do $$
declare
  H  uuid := '33333333-0000-0000-0000-00000000d001'; -- homeschool subscriber (plan pool)
  P  uuid := '33333333-0000-0000-0000-00000000d002'; -- teacher pro, quota spent (purchase pool)
  bh uuid := '77777777-0000-0000-0000-00000000d001';
  bp uuid := '77777777-0000-0000-0000-00000000d002';
  g1 uuid := '99999999-0000-0000-0000-00000000d001';
  g2 uuid := '99999999-0000-0000-0000-00000000d002';
  g3 uuid := '99999999-0000-0000-0000-00000000d003';
  g4 uuid := '99999999-0000-0000-0000-00000000d004';
  g5 uuid := '99999999-0000-0000-0000-00000000d005';
  m0 timestamptz := date_trunc('month', now());
begin
  insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at)
  select '00000000-0000-0000-0000-000000000000', u, 'authenticated', 'authenticated',
         u::text || '@unvoidtest.example.com', now(), now()
  from unnest(array[H, P]) as u
  on conflict (id) do nothing;

  insert into profiles (id, role, school_id) values
    (H, 'teacher', null), (P, 'teacher', null)
  on conflict (id) do update set role = excluded.role, school_id = excluded.school_id,
    max_books = null, max_chapters = null, max_children = null;

  insert into entitlements (user_id, active, plan_key, status) values
    (H, true, 'homeschool_monthly', 'active'),
    (P, true, 'teacher_pro_monthly', 'active');

  insert into books (id, title, owner_id) values (bh, 'H Book', H), (bp, 'P Book', P);

  -- ── 1. Error voids and the meter refunds (0059/0078 unchanged) ───────────
  insert into generations (id, kind, book_id, chapter_ref, owner_id)
  values (g1, 'presentation', bh, '1', H);
  perform _expect_eq((select voided from credit_ledger where generation_id = g1), false,
    'fresh row is live');
  perform _expect_eq(fair_use_used(H, 'credits', m0), 1, 'insert charged 1');
  update generations set status = 'error' where id = g1;
  perform _expect_eq((select voided from credit_ledger where generation_id = g1), true,
    'error voided the row');
  perform _expect_eq((select void_reason from credit_ledger where generation_id = g1), 'worker_error',
    'void labelled worker_error');
  perform _expect_eq(fair_use_used(H, 'credits', m0), 0, 'meter refunded');

  -- ── 2. The requeue legs keep the refund (charge on delivery only) ────────
  update generations set status = 'queued' where id = g1;
  perform _expect_eq((select voided from credit_ledger where generation_id = g1), true,
    'requeued (queued): still refunded');
  update generations set status = 'processing' where id = g1;
  perform _expect_eq((select voided from credit_ledger where generation_id = g1), true,
    'claimed (processing): still refunded');
  perform _expect_eq(fair_use_used(H, 'credits', m0), 0, 'meter unchanged mid-retry');

  -- ── 3. Landing done re-charges ───────────────────────────────────────────
  update generations set status = 'done' where id = g1;
  perform _expect_eq((select voided from credit_ledger where generation_id = g1), false,
    'done un-voided the row');
  perform _expect_eq((select void_reason from credit_ledger where generation_id = g1), null::text,
    'void_reason cleared (NULL on live rows, the 0078 contract)');
  perform _expect_eq(fair_use_used(H, 'credits', m0), 1, 'fair_use_used counts the row again');

  -- ── 4. The cycle is stable: done → error → done ──────────────────────────
  update generations set status = 'error' where id = g1;
  perform _expect_eq((select voided from credit_ledger where generation_id = g1), true,
    're-error re-voids');
  update generations set status = 'done' where id = g1;
  perform _expect_eq((select voided from credit_ledger where generation_id = g1), false,
    're-done re-charges');

  -- ── 5. Units resync: video_parts written while the row was voided ────────
  insert into generations (id, kind, book_id, chapter_ref, owner_id)
  values (g2, 'presentation', bh, '2', H);
  update generations set status = 'error' where id = g2;
  -- The successful re-run writes its part count while the row is voided;
  -- 0059's sync clause skips voided rows, so units must still lag here …
  update generations set params = coalesce(params, '{}'::jsonb) || '{"video_parts": 3}'::jsonb
   where id = g2;
  perform _expect_eq((select units from credit_ledger where generation_id = g2), 1,
    'voided row: units not synced yet');
  -- … and the un-void must catch it up from params.
  update generations set status = 'done' where id = g2;
  perform _expect_eq((select units from credit_ledger where generation_id = g2), 3,
    'un-void resynced units to what was delivered');
  perform _expect_eq(fair_use_used(H, 'credits', m0), 4, 'meter = g1 (1) + g2 (3)');

  -- No video_parts at done time (single-part render — the worker writes the
  -- key only when n_parts > 1): units set by any earlier legitimate sync must
  -- SURVIVE the un-void; an absent key must never clobber the charge back to
  -- 1. The direct units write stands in for such an earlier sync — the same
  -- synthetic-ledger technique the 0086 harness uses for quota seeding.
  insert into generations (id, kind, book_id, chapter_ref, owner_id)
  values (g5, 'presentation', bh, '3', H);
  update credit_ledger set units = 3 where generation_id = g5;
  update generations set status = 'error' where id = g5;
  update generations set status = 'done' where id = g5;
  perform _expect_eq((select voided from credit_ledger where generation_id = g5), false,
    'g5 un-voided');
  perform _expect_eq((select units from credit_ledger where generation_id = g5), 3,
    'absent video_parts: existing units kept, not clobbered to 1');
  perform _expect_eq(fair_use_used(H, 'credits', m0), 7, 'meter = g1 (1) + g2 (3) + g5 (3)');

  -- ── 6. Purchase pool: un-void re-draws the balance ───────────────────────
  insert into credit_ledger (owner_id, kind, units, part, source, created_at)
  values (P, 'presentation', 28, 0, 'plan', now() - interval '1 hour'); -- pro quota spent (0107 cap)
  insert into credit_purchases (owner_id, credits, pack_key, usd, ls_order_id)
  values (P, 6, 'pack_6', 8.00, 'ord_unvoid_1');
  perform _expect_eq(fair_use_purchased_remaining(P), 6, 'pack credited: balance 6');
  insert into generations (id, kind, book_id, chapter_ref, owner_id)
  values (g3, 'presentation', bp, '1', P);
  perform _expect_eq((select source from credit_ledger where generation_id = g3), 'purchase',
    'over-quota row charged to PURCHASE');
  perform _expect_eq(fair_use_purchased_remaining(P), 5, 'balance drawn to 5');
  update generations set status = 'error' where id = g3;
  perform _expect_eq(fair_use_purchased_remaining(P), 6, 'error restored the balance');
  update generations set status = 'queued' where id = g3;
  update generations set status = 'done' where id = g3;
  perform _expect_eq((select voided from credit_ledger where generation_id = g3), false,
    'purchase-funded row un-voided');
  perform _expect_eq(fair_use_purchased_remaining(P), 5,
    'requeued success re-drew the purchased balance');

  -- ── 7. unconsumed_on_delete is never resurrected ─────────────────────────
  -- A real 0078 delete-void's generations row is GONE, so the trigger can
  -- never fire for it; this synthetic row proves the WHERE-clause guard
  -- holds even if the firing condition is ever loosened.
  insert into generations (id, kind, book_id, chapter_ref, owner_id)
  values (g4, 'presentation', bp, '2', P);
  insert into credit_ledger (owner_id, generation_id, kind, units, part, voided, void_reason, source)
  values (P, g4, 'presentation', 1, 0, true, 'unconsumed_on_delete', 'plan');
  update generations set status = 'done' where id = g4;
  perform _expect_eq(
    (select voided from credit_ledger where generation_id = g4 and void_reason = 'unconsumed_on_delete'),
    true, 'delete-void stays voided through a done transition');
  perform _expect_eq(
    (select count(*)::int from credit_ledger where generation_id = g4 and not voided),
    1, 'the live row (the real charge) is untouched');

  raise notice '================ ALL 0088 CHECKS PASSED ================';
end $$;

rollback;
