-- 0059 — The LESSON is the meter: per-lesson credits, kit documents free.
--
-- Founder decision (2026-07-19), replacing the two-pool parts/docs model:
--   · 1 credit = 1 generated video lesson PART. A chapter-level lesson on a
--     chapter that renders as N parts costs N credits (counted after render,
--     0047's accepted one-chapter overshoot). Regenerating costs again.
--   · The document kit generates WITH the lesson and is FREE: documents for
--     a unit whose lesson exists reuse its analysis (~$0.01 each). Documents
--     never generate standalone — a doc insert for a unit with no live
--     non-error lesson is refused (the app queues the presentation first in
--     the same batch; rows inserted earlier in the statement are visible to
--     later rows' triggers).
--   · Free documents are bounded: at most 3 rows per (unit, kind) per month.
--   · Credits/month: pro 16, pro_plus 32, family 6, trial 16 (the 0057/0058
--     pin bounds trial units; credits bound regen volume). school unlimited.
--   · Books caps and the one-month rollover are unchanged.
--
-- rev 2 (adversarial review): credits are metered on an INSERT-TIME LEDGER
-- (credit_ledger), not surviving generations rows — deleting a lesson (or
-- the regenerate flow's insert-then-delete) must never refund its credit,
-- exactly the lesson 0046 taught for books and 0057 for the trial pin. The
-- ledger rows have NO FK to generations, so they survive deletion; worker
-- errors void them (genuine failures don't burn credits); the worker's
-- video_parts write syncs the row's units. Enforcement counts the ledger
-- PLUS any same-month generations rows not yet ledgered (AFTER-insert
-- ledger writes land at statement end, so a multi-kit batch's earlier rows
-- are counted via their live generations rows — no overshoot).
--
-- Margin (measured 2026-07-19, Haiku authoring + Sonnet ingestion live):
-- lesson part ≈ $0.46 expected incl. render/delivery; kit docs ≈ $0.05.
-- At 100% utilization: pro $24 → ~$9.0 COGS (63% GM), pro_plus $49 → ~$17.9
-- (63%), family $9.99 → ~$3.9 (61%). All above the >50% rule.
--
-- Deploy order: app first (meter falls back on the old shape), then run
-- this. Idempotent. Requires 0047/0049 (and composes with 0057/0058 —
-- beta_generation_cap runs before fair_use_cap on each row).

-- ── The credit ledger (survives deletes; voided on worker error) ─────────────
create table if not exists public.credit_ledger (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references auth.users(id) on delete cascade,
  generation_id uuid,               -- deliberately NO foreign key: must outlive the row
  kind          text not null,
  units         int  not null default 1,  -- video parts for presentations; 1 per document
  book_id       uuid,
  chapter_ref   text,
  part          int  not null default 0,
  voided        boolean not null default false, -- worker-errored: refunded
  created_at    timestamptz not null default now()
);
create index if not exists credit_ledger_owner_month_idx on public.credit_ledger (owner_id, created_at);
create index if not exists credit_ledger_generation_idx on public.credit_ledger (generation_id);
alter table public.credit_ledger enable row level security;
revoke all on public.credit_ledger from anon, authenticated;

-- Backfill this month + last (rollover math) so 0059 doesn't hand every
-- account a fresh meter mid-month. Idempotent via the generation_id guard.
insert into public.credit_ledger (owner_id, generation_id, kind, units, book_id, chapter_ref, part, voided, created_at)
select g.owner_id, g.id, g.kind,
       case when g.kind = 'presentation'
            then greatest(coalesce((g.params->>'video_parts')::int, 1), 1) else 1 end,
       g.book_id, g.chapter_ref,
       coalesce(case when g.params->>'part' ~ '^[0-9]{1,9}$' then (g.params->>'part')::int end, 0),
       g.status = 'error', g.created_at
from generations g
where g.kind in ('presentation', 'worksheet', 'exam_paper', 'lesson_plan', 'activity', 'case_study')
  and g.created_at >= date_trunc('month', now()) - interval '1 month'
  and not exists (select 1 from credit_ledger cl where cl.generation_id = g.id);

-- Writer: every counted generation lands in the ledger at insert.
create or replace function credit_ledger_write() returns trigger
  language plpgsql security definer set search_path = public as
$$
begin
  if new.kind in ('presentation', 'worksheet', 'exam_paper', 'lesson_plan', 'activity', 'case_study') then
    insert into credit_ledger (owner_id, generation_id, kind, units, book_id, chapter_ref, part, voided)
    values (new.owner_id, new.id, new.kind,
            case when new.kind = 'presentation'
                 then greatest(coalesce((new.params->>'video_parts')::int, 1), 1) else 1 end,
            new.book_id, new.chapter_ref,
            coalesce(case when new.params->>'part' ~ '^[0-9]{1,9}$' then (new.params->>'part')::int end, 0),
            new.status = 'error');
  end if;
  return null;
end $$;
drop trigger if exists credit_ledger_write on generations;
create trigger credit_ledger_write after insert on generations
  for each row execute function credit_ledger_write();

-- Sync: the worker's video_parts write updates units; a worker error voids
-- (refunds) the entry — retries insert fresh rows and are charged normally.
create or replace function credit_ledger_sync() returns trigger
  language plpgsql security definer set search_path = public as
$$
begin
  if new.kind = 'presentation'
     and (new.params->>'video_parts') is distinct from (old.params->>'video_parts') then
    update credit_ledger
       set units = greatest(coalesce((new.params->>'video_parts')::int, 1), 1)
     where generation_id = new.id and not voided;
  end if;
  if new.status = 'error' and new.status is distinct from old.status then
    update credit_ledger set voided = true where generation_id = new.id;
  end if;
  return null;
end $$;
drop trigger if exists credit_ledger_sync on generations;
create trigger credit_ledger_sync after update of params, status on generations
  for each row execute function credit_ledger_sync();

-- ── Caps per tier ────────────────────────────────────────────────────────────
create or replace function public.fair_use_caps(tier text)
returns table (parts_cap int, docs_cap int, books_cap int)
  language sql immutable as
$$
  -- parts_cap = LESSON CREDITS since 0059. docs_cap retired (docs are free
  -- with their lesson, bounded per-unit in enforce_fair_use, never pooled).
  select t.parts_cap, t.docs_cap, t.books_cap from (values
    ('trial',    16, 0, 2147483647),  -- books bounded by the 0046 lifetime ledger
    ('pro',      16, 0, 2),
    ('pro_plus', 32, 0, 4),
    ('family',    6, 0, 2),
    ('school',   2147483647, 2147483647, 2147483647)
  ) as t(k, parts_cap, docs_cap, books_cap)
  where t.k = coalesce(tier, 'trial');
$$;

-- Credits used in a month: the ledger (delete-proof), PLUS same-month live
-- presentation rows not yet ledgered — AFTER-insert ledger writes land at
-- statement end, so earlier rows of a multi-kit batch are counted via their
-- live generations rows and a batch can never overshoot the cap.
-- (`unit` kept for signature compatibility; ignored — one pool.)
create or replace function public.fair_use_used(uid uuid, unit text, month_start timestamptz)
returns int
  language sql stable security definer set search_path = public as
$$
  select (
    coalesce((select sum(cl.units) from credit_ledger cl
              where cl.owner_id = uid and cl.kind = 'presentation' and not cl.voided
                and cl.created_at >= month_start
                and cl.created_at < month_start + interval '1 month'), 0)
    +
    coalesce((select sum(greatest(coalesce((g.params->>'video_parts')::int, 1), 1))
              from generations g
              where g.owner_id = uid and g.kind = 'presentation' and g.status <> 'error'
                and g.created_at >= month_start
                and g.created_at < month_start + interval '1 month'
                and not exists (select 1 from credit_ledger cl2 where cl2.generation_id = g.id)), 0)
  )::int;
$$;

-- available = cap + carry − used;  carry = min(cap, unused last month), only
-- for accounts older than this month. Unchanged shape from 0047.
create or replace function public.fair_use_avail(uid uuid, unit text, cap int)
returns table (used int, carry int, available int)
  language plpgsql stable security definer set search_path = public as
$$
declare
  m0 timestamptz := date_trunc('month', now());
  used_now int;
  used_prev int;
  carry_v int := 0;
begin
  if cap >= 2147483647 then
    used := 0; carry := 0; available := 2147483647;
    return next; return;
  end if;
  used_now := fair_use_used(uid, unit, m0);
  if exists (select 1 from profiles p where p.id = uid and p.created_at < m0) then
    used_prev := fair_use_used(uid, unit, m0 - interval '1 month');
    carry_v := least(cap, greatest(0, cap - used_prev));
  end if;
  used := used_now;
  carry := carry_v;
  available := cap + carry_v - used_now;
  return next;
end;
$$;

-- ── Enforcement: BEFORE INSERT on generations ────────────────────────────────
create or replace function enforce_fair_use() returns trigger
  language plpgsql security definer set search_path = public as
$$
declare
  tier text;
  caps record;
  a record;
  new_part int;
  has_lesson boolean;
  kind_rows int;
begin
  -- Console-blessed accounts (any per-user override set: demo teachers,
  -- founder) are exempt — the overrides ARE their plan.
  if exists (select 1 from profiles p where p.id = new.owner_id
             and (p.max_books is not null or p.max_chapters is not null)) then
    return new;
  end if;
  tier := plan_tier(new.owner_id);
  select * into caps from fair_use_caps(tier);

  if new.kind = 'presentation' then
    if caps.parts_cap < 2147483647 then
      perform pg_advisory_xact_lock(hashtext('fair_use:' || new.owner_id::text));
      select * into a from fair_use_avail(new.owner_id, 'credits', caps.parts_cap);
      if a.available < 1 then
        raise exception 'Monthly limit reached: your plan includes % lessons/month (+% carried over) — each lesson brings its full document kit free. It resets on the 1st, or upgrade for more.',
          caps.parts_cap, a.carry;
      end if;
    end if;
    return new;
  end if;

  if new.kind in ('worksheet', 'exam_paper', 'lesson_plan', 'activity', 'case_study') then
    if caps.parts_cap >= 2147483647 then
      return new; -- unlimited tiers: no kit rule either
    end if;
    perform pg_advisory_xact_lock(hashtext('fair_use:' || new.owner_id::text));
    new_part := coalesce(case when new.params->>'part' ~ '^[0-9]{1,9}$'
                              then (new.params->>'part')::int end, 0);
    -- Documents ride along with their lesson (same owner/book/chapter/part;
    -- the app inserts the presentation FIRST in the same batch, and rows
    -- inserted earlier in the statement are visible here). Any month's live
    -- lesson qualifies — kit docs for last month's lesson stay free.
    select exists (
      select 1 from generations p
      where p.owner_id = new.owner_id
        and p.kind = 'presentation'
        and p.status <> 'error'
        and p.book_id is not distinct from new.book_id
        and p.chapter_ref is not distinct from new.chapter_ref
        and coalesce(case when p.params->>'part' ~ '^[0-9]{1,9}$'
                          then (p.params->>'part')::int end, 0) = new_part
    ) into has_lesson;
    if not has_lesson then
      raise exception 'Documents generate together with their lesson — generate the lesson for this chapter (or part) first; its full document kit is free.';
    end if;
    -- Free-doc bound: at most 3 per (unit, kind) per month. Counted on the
    -- LEDGER (+ any not-yet-ledgered same-statement rows), so the
    -- regenerate flow's insert-then-delete cannot reset it.
    select (
      (select count(*) from credit_ledger cl
        where cl.owner_id = new.owner_id and cl.kind = new.kind and not cl.voided
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
  end if;
  return new;
end $$;

drop trigger if exists fair_use_cap on generations;
create trigger fair_use_cap before insert on generations
  for each row execute function enforce_fair_use();

-- ── The meter's read ─────────────────────────────────────────────────────────
create or replace function public.my_fair_use() returns jsonb
  language plpgsql stable security definer set search_path = public as
$$
declare
  uid uuid := auth.uid();
  tier text;
  caps record;
  c record;
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
  select * into c from fair_use_avail(uid, 'credits', caps.parts_cap);
  return jsonb_build_object(
    'tier', tier,
    'unlimited', caps.parts_cap >= 2147483647,
    'credits', jsonb_build_object('cap', caps.parts_cap, 'carry', c.carry, 'used', c.used,
                                  'available', greatest(0, c.available)),
    'resets_on', to_char(date_trunc('month', now()) + interval '1 month', 'YYYY-MM-DD')
  );
end;
$$;
