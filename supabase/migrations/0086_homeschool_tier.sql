-- 0086 — Homeschool tier + purchased credit packs (homeschool release).
--
-- Founder decisions (2026-08-18):
--   · New paid tier 'homeschool' ($34/mo, $340/yr via Lemon Squeezy product
--     "SketchCast Homeschool"): 48 generations/month, 4 books/month, up to 10
--     learners. Entitlement plan_keys: homeschool_monthly / homeschool_annual.
--   · The permanent FREE tier ('trial') drops 96 → 6 generations. 96 was the
--     0075 held-harmless multiplier for beta testers (16 kits); the 0057 pin
--     already limits free accounts to 1 book + ONE part's kit, and a kit is
--     exactly 6 generations — so 6 is the pin, priced honestly. Nothing is
--     deleted from accounts already past 6; only new inserts are blocked.
--   · CREDIT PACKS (one-time purchases): 6/$8, 18/$20, 36/$36. Purchasable on
--     any PAID tier, never trial/free (gated at the app/checkout layer — the
--     DB just accounts for them). Purchased credits DO NOT expire monthly and
--     are consumed AFTER the monthly quota.
--
-- WHY 0079's credit_grants CANNOT CARRY PACKS. A grant raises eff_cap, and
-- fair_use_used() re-counts each calendar month — so a non-expiring grant
-- re-hands the same bonus every month forever (the exact trap 0079's
-- expires_at exists to close). A purchased pack is the opposite shape: a
-- PERSISTENT BALANCE drawn down once. So packs get their own table
-- (credit_purchases) and their own drawdown accounting, and grants stay
-- exactly what 0079 made them: windowed support comps that extend the cap.
--
-- HOW DRAWDOWN WORKS (the subtle piece):
--   · credit_ledger grows a `source` column: 'plan' (monthly quota, incl.
--     carry + live 0079 grants) or 'purchase' (paid balance). Existing rows
--     backfill to 'plan' via the column default — correct, packs are new.
--   · credit_ledger_write (AFTER INSERT, fires per row in insert order)
--     stamps the source: 'plan' while any monthly room remains, else
--     'purchase'. It decides from the LEDGER alone, not fair_use_used():
--     AFTER-row triggers all run at statement end, so the generations
--     fallback arm would count a kit's LATER siblings while labelling its
--     first row and mislabel the whole batch. Ledger rows exist exactly for
--     the rows already written before this one, which is the order we want.
--     (Pre-0059 ledgerless generations are invisible to this decision;
--     acceptable — every generation since 0059 writes a ledger row, and the
--     decision only concerns the current month.)
--   · fair_use_used() now counts only source='plan' ledger rows, so purchased
--     drawdown never eats the monthly meter (or next month's carry).
--   · fair_use_purchased_remaining() = non-refunded purchased credits minus
--     non-voided 'purchase' ledger units, clamped at 0. All-time, no window:
--     that is what "does not expire monthly" means.
--   · enforce_fair_use admits a row when monthly available >= 1, OR when
--     (available + purchased_remaining) >= 1. Adding `available` (which goes
--     negative as a single statement overflows the plan quota) makes a
--     six-row kit consume the balance correctly within ONE statement: row k's
--     BEFORE trigger sees k-1 fallback rows, so the k-th overflow row needs k
--     purchased credits, and a kit the balance cannot cover fails whole —
--     same atomicity 0075 established.
--   · A multi-unit chapter lesson (units seeded from the part map) is charged
--     WHOLE to the side that had any room left — the same bounded
--     one-chapter overshoot 0047 accepted by design.
--   · 0078 interplay is free: void_unconsumed / worker_error voiding flips
--     `voided`, and both the monthly meter and the purchased balance count
--     only `not voided` — so a refunded generation restores whichever pool it
--     was charged to, automatically.
--
-- WHICH TIERS SPEND THE BALANCE. Any tier metered by fair_use_avail (pro,
-- pro_plus, family, homeschool — and 'trial', so a lapsed subscriber's paid
-- credits keep working, which is what "purchased credits don't expire" must
-- mean). NOT promo (period-total launch trial, packs never sold there) and
-- not unlimited tiers (nothing to spend it on). The trial 0057 pin still
-- applies regardless of balance: packs buy volume, not scope.
--
-- LEARNER CAP. enforce_beta_child_cap (0018/0048) enforces
-- effective_cap(uid,'children'), which had a flat default of 2. The default
-- is now tier-aware: homeschool → 10, everything else → 2 (family explicitly
-- stays 2; profiles.max_children console override still wins). A tiny
-- SECURITY DEFINER helper learners_cap(uid) — service_role only — lets
-- /api/children's friendly pre-check read the same number the trigger
-- enforces instead of guessing from beta_tester.
--
-- WHAT THE FOUNDER MUST VERIFY when creating the LS products (webhook side
-- documented in src/utils/billing/packs.ts + src/utils/lemonsqueezy/handlers.ts):
--   · "SketchCast Homeschool" product: set LEMONSQUEEZY_VARIANT_HOMESCHOOL_MONTHLY
--     and LEMONSQUEEZY_VARIANT_HOMESCHOOL_ANNUAL to its two variant ids
--     (primary mapping); name the variants "Monthly" / "Annual" (fallback
--     mapping matches product_name "SketchCast Homeschool" + /annual|year/i).
--   · Pack product names must start with "SketchCast Credits" and carry the
--     credit count in trailing parentheses:
--       "SketchCast Credits — 1 kit (6)"
--       "SketchCast Credits — 3 kits (18)"
--       "SketchCast Credits — 6 kits (36)"
--
-- Idempotent. Requires 0060 (plan_tier/promo), 0075 (per-generation meter),
-- 0078 (void_reason), 0079 (credit_grants/eff_cap).

-- ── 1. Caps: add homeschool, price the free tier honestly ────────────────────
-- Body is the live 0075 definition with exactly two changes: the trial row
-- (96 → 6) and the new homeschool row (48 gens, 4 books/month).
create or replace function public.fair_use_caps(tier text)
returns table(parts_cap integer, docs_cap integer, books_cap integer)
language sql
immutable
as $$
  select t.parts_cap, t.docs_cap, t.books_cap from (values
    -- parts_cap is a count of GENERATIONS (0075), not lessons.
    ('trial',      6, 0, 2147483647),  -- 1 kit — the 0057 pin, priced honestly (was 96; books via 0046 lifetime ledger)
    ('promo',     24, 0, 2),           -- 4 kits — launch trial (expired 2026-08-14; branch kept for history)
    ('pro',       24, 0, 2),           -- 4 kits
    ('pro_plus',  72, 0, 4),           -- 12 kits
    ('family',    12, 0, 2),           -- 2 kits — sold as "Home Basic" (plan_key unchanged)
    ('homeschool',48, 0, 4),           -- 8 kits, 4 books/month, 10 learners
    ('school',    2147483647, 2147483647, 2147483647)
  ) as t(k, parts_cap, docs_cap, books_cap)
  where t.k = coalesce(tier, 'trial');
$$;

-- ── 2. plan_tier: homeschool_% entitlements → 'homeschool' ───────────────────
-- Body is the live 0060 definition (incl. the promo branch) plus the
-- homeschool mapping. Priority sits between pro_plus and pro: when one
-- account somehow holds several plans, the roomier one should win, and
-- homeschool (48 gens / 4 books / 10 learners) outranks pro (24/2).
create or replace function public.plan_tier(uid uuid) returns text
  language sql stable security definer set search_path = public as
$$
  select coalesce(
    -- School plan (one entitlement held by the admin; every member is 'school').
    (select 'school'
     from profiles p
     join entitlements e on e.school_id = p.school_id
     where p.id = uid and p.school_id is not null
       and e.active and e.plan_key like 'school%'
       and (e.current_period_end is null or e.current_period_end > now())
     limit 1),
    -- Personal paid entitlement (the buyer's own plan).
    (select case
       when e.plan_key like 'teacher_pro_plus%' then 'pro_plus'
       when e.plan_key like 'homeschool%'       then 'homeschool'
       when e.plan_key like 'teacher_pro%'      then 'pro'
       when e.plan_key like 'family%'           then 'family'
       when e.plan_key like 'school%'           then 'school'
     end
     from entitlements e
     where e.user_id = uid and e.active
       and (e.current_period_end is null or e.current_period_end > now())
     order by case
       when e.plan_key like 'school%'           then 1
       when e.plan_key like 'teacher_pro_plus%' then 2
       when e.plan_key like 'homeschool%'       then 3
       when e.plan_key like 'teacher_pro%'      then 4
       when e.plan_key like 'family%'           then 5
       else 6 end
     limit 1),
    -- Launch free-trial period: any non-school account with no paid plan, while
    -- the promo runs. School members are out (staff-provisioned/sales-led).
    (select 'promo'
     from profiles p
     where p.id = uid and p.school_id is null and now() < promo_ends_at()),
    'trial');
$$;
revoke execute on function public.plan_tier(uuid) from public, anon, authenticated;

-- ── 3. Learner cap: tier-aware children default ──────────────────────────────
-- Body is the live 0048 definition with ONE change: the 'children' default is
-- tier-aware (homeschool → 10, everything else → 2 — family stays 2). The
-- per-user profiles.max_children console override still wins outright, and
-- enforce_beta_child_cap (0018/0048) needs no change — it already reads this.
create or replace function public.effective_cap(uid uuid, which text) returns int
  language sql stable security definer set search_path = public as
$$
  select coalesce(
    -- 1) explicit per-user override from the console
    (select case which when 'books'    then max_books
                       when 'chapters' then max_chapters
                       when 'students' then max_students
                       when 'children' then max_children end
     from profiles where id = uid),
    -- 2) plan defaults: 1 book (trial lifetime, see 0046/0047); children by
    --    tier (homeschool families are the product's unit of 10, 0086);
    --    chapters/students stay open (fair-use metering covers volume, 0047).
    case which when 'books'    then 1
               when 'children' then (case when plan_tier(uid) = 'homeschool' then 10 else 2 end)
               else 2147483647 end)
$$;

-- The read for /api/children's friendly pre-check — the SAME number the
-- enforce_beta_child_cap trigger enforces, so the route stops guessing from
-- the stale beta_tester flag. service_role only (the route calls it with the
-- admin client); 2147483647 means "no cap" (console-blessed unlimited).
create or replace function public.learners_cap(uid uuid) returns integer
  language sql stable security definer set search_path = public as
$$ select effective_cap(uid, 'children') $$;
revoke execute on function public.learners_cap(uuid) from public, anon, authenticated;
grant execute on function public.learners_cap(uuid) to service_role;

-- ── 4. Purchased credit packs ────────────────────────────────────────────────
-- 4a. The purchases (webhook-written; ls_order_id is the idempotency key —
-- LS re-delivers, order updates re-fire, and one order must credit once).
create table if not exists public.credit_purchases (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid references auth.users(id) on delete cascade,
  claim_email  text,          -- set only while parked (public-link buy, no bound account) — claim.ts binds it
  credits      int  not null check (credits > 0),
  pack_key     text not null, -- 'pack_6' | 'pack_18' | 'pack_36' (src/utils/billing/packs.ts)
  usd          numeric(8,2),  -- list price at purchase time (display/reconciliation only)
  provider     text not null default 'lemonsqueezy',
  ls_order_id  text unique,
  refunded_at  timestamptz,   -- an LS refund zeroes the pack's contribution; already-spent credits stand
  created_at   timestamptz not null default now(),
  -- Every row must be attributable: bound to an account or parked by email.
  constraint credit_purchases_attributable check (owner_id is not null or claim_email is not null)
);

comment on table public.credit_purchases is
  'One-time credit packs bought via Lemon Squeezy. A PERSISTENT balance (no monthly expiry), consumed only after the monthly plan quota — see fair_use_purchased_remaining() and credit_ledger.source. Never sold on trial/free (app-layer gate).';

create index if not exists credit_purchases_owner_idx
  on public.credit_purchases (owner_id);
create index if not exists credit_purchases_claim_idx
  on public.credit_purchases (claim_email) where owner_id is null;

-- Same posture as credit_ledger (0059) and credit_grants (0079): platform-owned
-- truth. The webhook (service role) writes it; my_fair_use() reports the balance.
alter table public.credit_purchases enable row level security;
revoke all on public.credit_purchases from anon, authenticated;

-- 4b. Which pool each ledger row consumed. Existing rows backfill to 'plan'
-- via the default — correct: packs did not exist before this migration.
alter table public.credit_ledger add column if not exists source text not null default 'plan';
alter table public.credit_ledger drop constraint if exists credit_ledger_source_chk;
alter table public.credit_ledger add constraint credit_ledger_source_chk
  check (source in ('plan', 'purchase'));
comment on column public.credit_ledger.source is
  'Which pool this row consumed: plan (monthly quota incl. carry + 0079 grants) or purchase (0086 credit packs). Stamped by credit_ledger_write.';

create index if not exists credit_ledger_purchase_idx
  on public.credit_ledger (owner_id) where source = 'purchase' and not voided;

-- 4c. The balance: bought minus drawn, never negative. All-time on purpose —
-- purchased credits do not expire monthly. Refunded packs stop contributing
-- (already-spent credits stand; the clamp absorbs a refund-after-spend).
create or replace function public.fair_use_purchased_remaining(uid uuid) returns integer
  language sql stable security definer set search_path = public as
$$
  select greatest(0,
    coalesce((select sum(p.credits) from credit_purchases p
               where p.owner_id = uid and p.refunded_at is null), 0)
    -
    coalesce((select sum(cl.units) from credit_ledger cl
               where cl.owner_id = uid and cl.source = 'purchase' and not cl.voided), 0)
  )::int;
$$;
revoke execute on function public.fair_use_purchased_remaining(uuid) from public, anon, authenticated;

-- ── 5. The monthly meter counts only plan-sourced rows ───────────────────────
-- Body is the live 0075 definition with ONE change: the ledger arm takes
-- coalesce(cl.source,'plan') = 'plan', so purchased drawdown neither eats the
-- monthly cap nor suppresses next month's carry. (The generations fallback arm
-- stays source-blind: it exists for pre-0059 rows, which are all plan-era.)
create or replace function public.fair_use_used(uid uuid, unit text, month_start timestamptz)
returns integer
language sql
stable
security definer
set search_path to 'public'
as $$
  select (
    coalesce((select sum(cl.units) from credit_ledger cl
              where cl.owner_id = uid and not cl.voided
                and coalesce(cl.source, 'plan') = 'plan'
                and cl.created_at >= month_start
                and cl.created_at < month_start + interval '1 month'), 0)
    +
    coalesce((select sum(case when g.kind = 'presentation'
                              then greatest(coalesce((g.params->>'video_parts')::int, 1), 1)
                              else 1 end)
              from generations g
              where g.owner_id = uid
                and g.kind in ('presentation','worksheet','exam_paper','lesson_plan','activity','case_study')
                and g.status <> 'error'
                and g.created_at >= month_start
                and g.created_at < month_start + interval '1 month'
                and not exists (select 1 from credit_ledger cl2 where cl2.generation_id = g.id)), 0)
  )::int;
$$;

-- ── 6. Ledger write: stamp the source (monthly quota FIRST, then balance) ────
-- Body is the live 0060 definition plus the source decision documented in the
-- header. Everything else (part-map seeding, voided-on-error) is verbatim.
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
    if new.kind = 'presentation' and not (new.params->>'part' ~ '^[0-9]{1,9}$') then
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
    -- LEDGER alone — see the header for why fair_use_used() would mislabel a
    -- kit's early rows here.
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

-- ── 7. Enforcement: the balance backstops the monthly quota ──────────────────
-- Body is the live 0079 function verbatim, with ONE change repeated in the
-- two metered branches (presentation + documents): where `a.available < 1`
-- used to raise, it now raises only when the purchased balance cannot cover
-- the shortfall either. `a.available` goes negative as a single kit statement
-- overflows the plan quota (each row's BEFORE trigger counts its admitted
-- siblings through the generations fallback arm), so adding it to the balance
-- makes the k-th overflow row require k purchased credits — a kit the balance
-- cannot cover fails WHOLE, exactly like 0075's cap. The promo branch is
-- untouched: packs are never sold against the period-total launch trial.
create or replace function public.enforce_fair_use() returns trigger
  language plpgsql security definer set search_path = public as
$$
declare
  tier text;
  caps record;
  a record;
  new_part int;
  has_lesson boolean;
  kind_rows int;
  cumulative_count int;
  eff_cap int;
begin
  if exists (select 1 from profiles p where p.id = new.owner_id
             and (p.max_books is not null or p.max_chapters is not null)) then
    return new;
  end if;
  tier := plan_tier(new.owner_id);
  select * into caps from fair_use_caps(tier);

  -- The effective cap: tier default + anything support has comped. Guarded so
  -- the school sentinel (2147483647) is never arithmetic'd into an overflow.
  if caps.parts_cap >= 2147483647 then
    eff_cap := caps.parts_cap;
  else
    eff_cap := caps.parts_cap + fair_use_granted(new.owner_id);
  end if;

  if new.kind::text = 'exam' then
    perform pg_advisory_xact_lock(hashtext('fair_use:' || new.owner_id::text));
    if coalesce(jsonb_typeof(new.params->'scope'), '') <> 'array'
       or jsonb_array_length(new.params->'scope') = 0 then
      raise exception 'Pick at least one covered chapter or part to build the exam from.';
    end if;
    if exists (
      select 1 from jsonb_array_elements(new.params->'scope') s
      where not exists (
        select 1 from generations p
        where p.owner_id = new.owner_id and p.kind = 'presentation' and p.status <> 'error'
          and p.book_id is not distinct from new.book_id
          and p.chapter_ref = (s.value->>'chapter')
          and coalesce(case when p.params->>'part' ~ '^[0-9]{1,9}$' then (p.params->>'part')::int end, 0)
              = coalesce(case when s.value->>'part' ~ '^[0-9]{1,9}$' then (s.value->>'part')::int end, 0)
      )
    ) then
      raise exception 'An exam can only cover chapters and parts you''ve already generated a lesson for.';
    end if;
    if caps.parts_cap < 2147483647
       and (select count(*) from generations g
              where g.owner_id = new.owner_id and g.kind::text = 'exam' and g.status <> 'error'
                and g.created_at >= date_trunc('month', now())) >= 12 then
      raise exception 'You''ve reached this month''s exams (12). It resets on the 1st.';
    end if;
    return new;
  end if;

  if new.kind = 'presentation' then
    if caps.parts_cap >= 2147483647 then
      return new;
    end if;
    perform pg_advisory_xact_lock(hashtext('fair_use:' || new.owner_id::text));
    if tier = 'promo' then
      if fair_use_used(new.owner_id, 'credits', promo_credit_from()) >= eff_cap then
        raise exception 'Your free trial includes % generations with every feature unlocked, and you''ve used them all. Subscribe to keep generating.',
          eff_cap;
      end if;
      return new;
    end if;
    select * into a from fair_use_avail(new.owner_id, 'credits', eff_cap);
    if a.available < 1
       and a.available + fair_use_purchased_remaining(new.owner_id) < 1 then
      raise exception 'Monthly limit reached: your plan includes % generations/month (+% carried over) — a lesson, a worksheet, a plan, an activity, a test paper and a case study each count as one. It resets on the 1st, or upgrade for more.',
        eff_cap, a.carry;
    end if;
    return new;
  end if;

  if new.kind in ('worksheet', 'exam_paper', 'lesson_plan', 'activity', 'case_study') then
    if caps.parts_cap >= 2147483647 then
      return new;
    end if;
    perform pg_advisory_xact_lock(hashtext('fair_use:' || new.owner_id::text));

    if (new.params->>'revision') = 'true'
       and new.chapter_ref is null
       and jsonb_typeof(new.params->'chapters') = 'array' then
      if exists (
        select 1 from jsonb_array_elements_text(new.params->'chapters') ch
        where not exists (
          select 1 from generations p
          where p.owner_id = new.owner_id and p.kind = 'presentation' and p.status <> 'error'
            and p.book_id is not distinct from new.book_id
            and p.chapter_ref = ch.value
        )
      ) then
        raise exception 'Revision papers are built from your generated lessons — generate the lesson for every chapter you selected first.';
      end if;
      select count(*) into cumulative_count from generations g
        where g.owner_id = new.owner_id and g.kind = new.kind and g.status <> 'error'
          and (g.params->>'revision') = 'true' and g.chapter_ref is null
          and g.created_at >= date_trunc('month', now());
      if cumulative_count >= 12 then
        raise exception 'You''ve reached this month''s revision papers of this type. It resets on the 1st.';
      end if;
      return new;
    end if;

    new_part := coalesce(case when new.params->>'part' ~ '^[0-9]{1,9}$'
                              then (new.params->>'part')::int end, 0);
    select exists (
      select 1 from generations p
      where p.owner_id = new.owner_id and p.kind = 'presentation' and p.status <> 'error'
        and p.book_id is not distinct from new.book_id
        and p.chapter_ref is not distinct from new.chapter_ref
        and coalesce(case when p.params->>'part' ~ '^[0-9]{1,9}$'
                          then (p.params->>'part')::int end, 0) = new_part
    ) into has_lesson;
    if not has_lesson then
      raise exception 'Documents generate with their lesson — generate the lesson for this chapter first, or use Revision papers over chapters you''ve already taught.';
    end if;
    select (
      (select count(*) from credit_ledger cl
        where cl.owner_id = new.owner_id and cl.kind = new.kind::text and not cl.voided
          and cl.book_id is not distinct from new.book_id
          and cl.chapter_ref is not distinct from new.chapter_ref
          and cl.part = new_part
          and cl.created_at >= date_trunc('month', now()))
      +
      (select count(*) from generations d
        where d.owner_id = new.owner_id and d.kind = new.kind and d.status <> 'error'
          and d.book_id is not distinct from new.book_id
          and d.chapter_ref is not distinct from new.chapter_ref
          and coalesce(case when d.params->>'part' ~ '^[0-9]{1,9}$'
                            then (d.params->>'part')::int end, 0) = new_part
          and d.created_at >= date_trunc('month', now())
          and not exists (select 1 from credit_ledger cl2 where cl2.generation_id = d.id))
    ) into kind_rows;
    if kind_rows >= 3 then
      raise exception 'Regeneration limit: this document type was already generated % times this month for this lesson. It resets on the 1st.', kind_rows;
    end if;

    if tier = 'promo' then
      if fair_use_used(new.owner_id, 'credits', promo_credit_from()) >= eff_cap then
        raise exception 'Your free trial includes % generations with every feature unlocked, and you''ve used them all. Subscribe to keep generating.',
          eff_cap;
      end if;
    else
      select * into a from fair_use_avail(new.owner_id, 'credits', eff_cap);
      if a.available < 1
         and a.available + fair_use_purchased_remaining(new.owner_id) < 1 then
        raise exception 'Monthly limit reached: your plan includes % generations/month (+% carried over) — a lesson, a worksheet, a plan, an activity, a test paper and a case study each count as one. It resets on the 1st, or upgrade for more.',
          eff_cap, a.carry;
      end if;
    end if;
  end if;
  return new;
end;
$$;

-- ── 8. The meter the user sees: surface the balance ──────────────────────────
-- Body is the live 0079 function plus a 'purchased' object on the metered
-- (non-promo) return — without it the UI would block at "0 left" while
-- enforcement happily spent a balance the user paid for. Promo and unlimited
-- returns are untouched (packs are never sold there).
create or replace function public.my_fair_use() returns jsonb
  language plpgsql stable security definer set search_path = public as
$$
declare
  uid uuid := auth.uid();
  tier text;
  caps record;
  c record;
  promo_used int;
  eff_cap int;
begin
  if uid is null then
    return null;
  end if;
  if exists (select 1 from profiles p where p.id = uid
             and (p.max_books is not null or p.max_chapters is not null)) then
    return jsonb_build_object('tier', 'unlimited', 'unlimited', true);
  end if;
  tier := plan_tier(uid);
  select * into caps from fair_use_caps(tier);

  if caps.parts_cap >= 2147483647 then
    eff_cap := caps.parts_cap;
  else
    eff_cap := caps.parts_cap + fair_use_granted(uid);
  end if;

  if tier = 'promo' then
    promo_used := fair_use_used(uid, 'credits', promo_credit_from());
    return jsonb_build_object(
      'tier', 'promo',
      'unlimited', false,
      'promo', true,
      'credits', jsonb_build_object('cap', eff_cap, 'carry', 0, 'used', promo_used,
                                    'available', greatest(0, eff_cap - promo_used)),
      'granted', fair_use_granted(uid),
      'resets_on', to_char(promo_ends_at() at time zone 'UTC', 'YYYY-MM-DD'),
      'trial_ends', to_char(promo_ends_at() at time zone 'UTC', 'YYYY-MM-DD')
    );
  end if;

  select * into c from fair_use_avail(uid, 'credits', eff_cap);
  return jsonb_build_object(
    'tier', tier,
    'unlimited', eff_cap >= 2147483647,
    'credits', jsonb_build_object('cap', eff_cap, 'carry', c.carry, 'used', c.used,
                                  'available', greatest(0, c.available)),
    -- 'available' deliberately: src/app/dashboard/fair-use-meter.tsx already
    -- reads fu.purchased.available (and tolerates a bare number).
    'granted', fair_use_granted(uid),
    'purchased', jsonb_build_object('available', fair_use_purchased_remaining(uid)),
    'resets_on', to_char(date_trunc('month', now()) + interval '1 month', 'YYYY-MM-DD')
  );
end;
$$;
