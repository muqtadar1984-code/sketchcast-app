-- SketchCast AI — part-map seeding verification for 0089
-- ============================================================================
-- Run in the Supabase SQL editor AFTER applying 0089_fix_part_map_seed.sql.
--
-- CAP BASELINE: 0107 (trial 7 · pro 28 · homeschool 56). The seeded quota fills
-- below are arithmetic against public.fair_use_caps, so they move when it does.
-- A kit still costs SIX credits — the deck rides free (0103).
-- Seeds throwaway users and drives the REAL triggers with direct inserts.
-- Proves, in order:
--   1. seeding: a chapter-level lesson on a 3-part chapter charges 3 units
--      at INSERT (the 0060 promise, dead until 0089), and the meter reflects
--      it immediately; part-scoped lessons, single-part chapters, part-less
--      chapters and document kinds all stay at 1;
--   2. the worker's video_parts sync corrects the seed BOTH ways (down as
--      well as up — the companion worker change writes the key on every
--      chapter-level render);
--   3. 0088 interplay: a seeded row that errors and requeues to done keeps
--      its seeded units when no video_parts was written, and reconciles when
--      it was;
--   4. the 0060 hole is closed: after a seeded multi-part charge lands, the
--      NEXT statement enforces against the real weight and blocks — under
--      the dead-seed code it read 1-until-render and admitted.
-- Every check RAISEs on failure; a clean run prints PASS lines and
-- "ALL 0089 CHECKS PASSED", then ROLLS BACK (nothing persists).
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
  H  uuid := '44444444-0000-0000-0000-00000000e001'; -- homeschool subscriber
  bh uuid := '77777777-0000-0000-0000-00000000e001';
  g1 uuid := '99999999-0000-0000-0000-00000000e001'; -- chapter-level, 3-part chapter
  g2 uuid := '99999999-0000-0000-0000-00000000e002'; -- part-scoped on the same chapter
  g3 uuid := '99999999-0000-0000-0000-00000000e003'; -- chapter-level, 1-part chapter
  g4 uuid := '99999999-0000-0000-0000-00000000e004'; -- chapter-level, no parts array
  g5 uuid := '99999999-0000-0000-0000-00000000e005'; -- 0088 interplay
  g6 uuid := '99999999-0000-0000-0000-00000000e006'; -- the 0060 hole
  w1 uuid := '99999999-0000-0000-0000-00000000e007'; -- document kind
  m0 timestamptz := date_trunc('month', now());
begin
  insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at)
  values ('00000000-0000-0000-0000-000000000000', H, 'authenticated', 'authenticated',
          H::text || '@seedtest.example.com', now(), now())
  on conflict (id) do nothing;

  insert into profiles (id, role, school_id) values (H, 'teacher', null)
  on conflict (id) do update set role = excluded.role, school_id = excluded.school_id,
    max_books = null, max_chapters = null, max_children = null;

  insert into entitlements (user_id, active, plan_key, status)
  values (H, true, 'homeschool_monthly', 'active');

  -- Chapter 1 has 3 parts, chapter 2 has 1, chapter 3 has no parts array.
  insert into books (id, title, owner_id, chapters) values
    (bh, 'Seed Book', H,
     '[{"num": "1", "title": "Ch 1", "parts": [{}, {}, {}]},
       {"num": "2", "title": "Ch 2", "parts": [{}]},
       {"num": "3", "title": "Ch 3"}]'::jsonb);

  -- Staggered created_at keeps every same-tuple insert outside 0076's
  -- 10-second duplicate window; all rows stay inside the current month.

  -- ── 1. Seeding at insert ─────────────────────────────────────────────────
  insert into generations (id, kind, book_id, chapter_ref, owner_id, created_at)
  values (g1, 'presentation', bh, '1', H, now() - interval '10 minutes');
  perform _expect_eq((select units from credit_ledger where generation_id = g1), 3,
    'chapter-level lesson on a 3-part chapter seeds units 3');
  perform _expect_eq(fair_use_used(H, 'credits', m0), 3,
    'the meter is accurate immediately (the 0060 promise)');

  insert into generations (id, kind, book_id, chapter_ref, owner_id, params, created_at)
  values (g2, 'presentation', bh, '1', H, '{"part": 2}'::jsonb, now() - interval '9 minutes');
  perform _expect_eq((select units from credit_ledger where generation_id = g2), 1,
    'part-scoped lesson stays 1 (by design)');
  perform _expect_eq((select part from credit_ledger where generation_id = g2), 2,
    'part column recorded from params');

  insert into generations (id, kind, book_id, chapter_ref, owner_id, created_at)
  values (g3, 'presentation', bh, '2', H, now() - interval '8 minutes');
  perform _expect_eq((select units from credit_ledger where generation_id = g3), 1,
    'single-part chapter seeds 1');

  insert into generations (id, kind, book_id, chapter_ref, owner_id, created_at)
  values (g4, 'presentation', bh, '3', H, now() - interval '7 minutes');
  perform _expect_eq((select units from credit_ledger where generation_id = g4), 1,
    'chapter with no parts array seeds 1');

  insert into generations (id, kind, book_id, chapter_ref, owner_id, created_at)
  values (w1, 'worksheet', bh, '1', H, now() - interval '6 minutes');
  perform _expect_eq((select units from credit_ledger where generation_id = w1), 1,
    'document kinds never seed from the part-map');

  -- ── 2. The sync corrects the seed BOTH ways ──────────────────────────────
  update generations set params = coalesce(params, '{}'::jsonb) || '{"video_parts": 5}'::jsonb
   where id = g1;
  perform _expect_eq((select units from credit_ledger where generation_id = g1), 5,
    'render bigger than the map: sync corrects 3 -> 5');
  update generations set params = params || '{"video_parts": 1}'::jsonb
   where id = g1;
  perform _expect_eq((select units from credit_ledger where generation_id = g1), 1,
    'render smaller than the map: sync corrects down to 1 (companion worker write)');

  -- ── 3. 0088 interplay: seeded units survive an un-void without the key ───
  insert into generations (id, kind, book_id, chapter_ref, owner_id, created_at)
  values (g5, 'presentation', bh, '1', H, now() - interval '5 minutes');
  perform _expect_eq((select units from credit_ledger where generation_id = g5), 3,
    'g5 seeds 3');
  update generations set status = 'error' where id = g5;
  update generations set status = 'done' where id = g5;
  perform _expect_eq((select voided from credit_ledger where generation_id = g5), false,
    'g5 un-voided on requeued success (0088)');
  perform _expect_eq((select units from credit_ledger where generation_id = g5), 3,
    'no video_parts written: the seeded estimate stands');
  update generations set params = coalesce(params, '{}'::jsonb) || '{"video_parts": 2}'::jsonb
   where id = g5;
  perform _expect_eq((select units from credit_ledger where generation_id = g5), 2,
    'a late video_parts write still reconciles to delivered truth');

  -- ── 4. The 0060 hole is closed ───────────────────────────────────────────
  -- used so far: g1 (1) + g2 (1) + g3 (1) + g4 (1) + g5 (2) + w1 (1) = 7.
  perform _expect_eq(fair_use_used(H, 'credits', m0), 7, 'checkpoint: 7 used');
  -- Burn to 54/56: available 2 — enough to ADMIT one more lesson…
  insert into credit_ledger (owner_id, kind, units, part, source, created_at)
  values (H, 'presentation', 47, 0, 'plan', now() - interval '1 hour');
  insert into generations (id, kind, book_id, chapter_ref, owner_id, created_at)
  values (g6, 'presentation', bh, '1', H, now() - interval '4 minutes');
  perform _expect_eq((select units from credit_ledger where generation_id = g6), 3,
    '…which lands at its real 3-unit weight');
  perform _expect_eq(fair_use_used(H, 'credits', m0), 57,
    'used 57/56 — the accepted single-statement overshoot');
  -- The NEXT statement now sees the truth and blocks. Under the dead-seed
  -- code g6 read as 1 (used 55) and this insert was admitted — the exact
  -- fast-batch hole 0060 described and never actually closed.
  perform _expect_block(
    format('insert into generations (kind, book_id, chapter_ref, owner_id) values (''presentation'', %L, ''2'', %L)', bh, H),
    'Monthly limit reached', 'next statement blocked at the seeded weight');

  raise notice '================ ALL 0089 CHECKS PASSED ================';
end $$;

rollback;
