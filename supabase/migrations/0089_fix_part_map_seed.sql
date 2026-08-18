-- 0089 — Resurrect the part-map units seed: it has been dead code since 0060.
--
-- THE BUG. credit_ledger_write's seeding gate reads:
--
--   if new.kind = 'presentation' and not (new.params->>'part' ~ '^[0-9]{1,9}$')
--
-- When params carries no 'part' key — which is EVERY chapter-level lesson
-- insert; src/app/dashboard/kit.ts only adds 'part' when a part is chosen —
-- `new.params->>'part'` is NULL, `NULL ~ regex` is NULL, `not NULL` is NULL,
-- and plpgsql treats a NULL condition as not-taken. Part-scoped inserts
-- (numeric 'part') skip the branch by design. Net effect: the branch NEVER
-- runs, and units always seeds 1. Verified live on prod (2026-08-18): the
-- expression evaluates to "branch skipped" for NULL params, on the same
-- server the trigger runs on.
--
-- WHAT IT WAS FOR. 0060, verbatim: "Under a PERIOD-total promo cap that let
-- a fast batch enqueue several multi-part chapters past the 4 before any
-- render synced (each read as 1). Seeding the known part count at insert
-- closes that — and makes the monthly meters accurate immediately too."
-- That hole was never actually closed: the seed shipped stillborn in 0060
-- and was carried verbatim through 0061 and 0086.
--
-- MEASURED BLAST RADIUS (prod pblaxsqhjwlqbrwbraxy, read 2026-08-18):
-- 27 books carry chapters[].parts arrays, 177 parted chapters, 150 of them
-- multi-part — the surface is real and growing (scanned books estimate parts
-- from page ranges at index time). But only FIVE chapter-level lessons were
-- ever inserted on multi-part chapters; two were later corrected by the
-- worker's video_parts sync, and zero live ledger rows disagree with a
-- written video_parts. History is settled; this is a forward-looking
-- enforcement fix. NO BACKFILL: re-stamping old rows would recharge closed
-- months for work the sync already priced.
--
-- WHAT CHANGES. The ledger row for a chapter-level lesson on a parted
-- chapter now records the part-map estimate at insert, so the NEXT statement
-- enforces against the real weight instead of 1-until-render. Within the
-- inserting statement itself nothing changes: enforce_fair_use runs BEFORE
-- INSERT per row while ledger writes land at statement end, so same-statement
-- admission still counts the fallback arm's 1 — 0059's accepted one-chapter
-- overshoot shape survives, it just can no longer compound across statements.
--
-- COMPANION WORKER CHANGE (sketchcast repo, worker/process.py). The sync can
-- only correct a seed the worker reports on: it wrote video_parts solely when
-- n_parts > 1, so a seed of 3 on a chapter that rendered as ONE video could
-- never be corrected down — 0060's "the worker's sync still corrects any
-- book whose real render differs from its stored map" was only true upward.
-- The worker now writes video_parts for every chapter-level render (nothing
-- in the app reads the key; its only consumers are credit_ledger_sync and
-- fair_use_used's fallback arm). 0088's un-void resync is keyed on the key
-- existing and needs no change: with the companion, a requeued chapter-level
-- success always carries the key and reconciles to delivered truth.
--
-- FORENSIC NOTE CORRECTION. 0078:220-224 argued units > 1 "is equally
-- consistent with never having run at all" because of insert-time seeding.
-- For rows created in the dead-seed era (0060 → 0089) that was backwards:
-- units > 1 could ONLY come from the sync, so it proved the worker ran. From
-- 0089 on, 0078's reading is finally the correct one.
--
-- Idempotent. Requires 0086 (source stamping; body below is 0086's verbatim
-- except the one fixed condition).
create or replace function credit_ledger_write() returns trigger
  language plpgsql security definer set search_path = public as
$$
declare
  n int := 1;
  src text := 'plan';
  tier text;
  caps record;
  eff_cap int;
  m0 timestamptz := date_trunc('month', now());
  plan_used int;
  used_prev int;
  carry_v int := 0;
begin
  if new.kind in ('presentation', 'worksheet', 'exam_paper', 'lesson_plan', 'activity', 'case_study') then
    -- 0089: coalesce, so an ABSENT part key (every chapter-level lesson)
    -- takes the branch — `not (NULL ~ …)` is NULL and never fired.
    if new.kind = 'presentation' and coalesce(new.params->>'part', '') !~ '^[0-9]{1,9}$' then
      select coalesce((
        select greatest(jsonb_array_length(c.value->'parts'), 1)
        from books b, jsonb_array_elements(coalesce(b.chapters, '[]'::jsonb)) c
        where b.id = new.book_id and c.value->>'num' = new.chapter_ref
          and jsonb_typeof(c.value->'parts') = 'array'
          limit 1), 1) into n;
    end if;

    -- Which pool does this row consume? Console-blessed accounts, promo (a
    -- period-total budget packs are never sold against) and unlimited tiers
    -- always charge 'plan'. Otherwise: 'plan' while any monthly room (cap +
    -- carry + live 0079 grants) remains, else 'purchase'. Decided from the
    -- LEDGER alone — see 0086's header for why fair_use_used() would
    -- mislabel a kit's early rows here.
    if not exists (select 1 from profiles p where p.id = new.owner_id
                   and (p.max_books is not null or p.max_chapters is not null)) then
      tier := plan_tier(new.owner_id);
      select * into caps from fair_use_caps(tier);
      if tier <> 'promo' and caps.parts_cap < 2147483647 then
        eff_cap := caps.parts_cap + fair_use_granted(new.owner_id);
        select coalesce(sum(cl.units), 0)::int into plan_used
          from credit_ledger cl
         where cl.owner_id = new.owner_id and not cl.voided
           and coalesce(cl.source, 'plan') = 'plan'
           and cl.created_at >= m0 and cl.created_at < m0 + interval '1 month';
        -- Carry mirrors fair_use_avail(uid, 'credits', eff_cap) exactly.
        if exists (select 1 from profiles p where p.id = new.owner_id and p.created_at < m0) then
          used_prev := fair_use_used(new.owner_id, 'credits', m0 - interval '1 month');
          carry_v := least(eff_cap, greatest(0, eff_cap - used_prev));
        end if;
        if plan_used >= eff_cap + carry_v then
          src := 'purchase';
        end if;
      end if;
    end if;

    insert into credit_ledger (owner_id, generation_id, kind, units, book_id, chapter_ref, part, voided, source)
    values (new.owner_id, new.id, new.kind, n, new.book_id, new.chapter_ref,
            coalesce(case when new.params->>'part' ~ '^[0-9]{1,9}$' then (new.params->>'part')::int end, 0),
            new.status = 'error', src);
  end if;
  return null;
end $$;
drop trigger if exists credit_ledger_write on generations;
create trigger credit_ledger_write after insert on generations
  for each row execute function credit_ledger_write();
