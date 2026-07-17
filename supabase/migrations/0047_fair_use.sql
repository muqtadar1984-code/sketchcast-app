-- 0047 — Fair-use caps: monthly, transparent, with one-month rollover.
--
-- Pricing decision (2026-07-17, all USD): generation volume is metered per
-- CALENDAR MONTH (UTC) with a clean rollover — unused allowance carries ONE
-- month forward, banked at most one full month's cap:
--
--     available = cap + min(cap, unused_last_month) − used_this_month
--
-- Units (deliberately honest to cost):
--   lesson parts — one ~15-minute video. A long chapter renders as several
--                  parts and is NEVER capped per chapter (product rule); each
--                  part simply draws from the monthly allowance. A new lesson
--                  reserves ONE part at enqueue; if the chapter renders as N
--                  parts the extra N−1 are counted after the fact (bounded
--                  overshoot by one chapter — accepted by design).
--   documents    — worksheet / exam / lesson plan / activities / case study.
--   books        — new uploads per month (paid tiers); the TRIAL keeps its
--                  lifetime-1 ledger rule from 0046.
--
-- Caps by tier (the ONE place to tune numbers — re-run this migration to
-- change policy):        parts  docs  books/mo
--   trial                  20    40   (lifetime 1 via 0046 ledger)
--   pro        ($24/mo)    20    40    2
--   pro_plus   ($49/mo)    40    80    4
--   family                 10    30    2
--   school     (annual)    ∞     ∞     ∞   — school fair use is decided with
--                                            the annual pricing, later.
--
-- Enforcement is DB triggers (server-side truth, same pattern as 0011/0016/
-- 0024); the Library meter reads my_fair_use() so the UI is a mirror, never
-- the guard. Failed generations (status='error') don't count against anyone.
-- Rollover only applies to accounts that existed before the current month (a
-- brand-new subscriber starts with exactly one month's cap).
--
-- Idempotent: safe to re-run. Requires 0022 (entitlements) + 0046 (ledger).

-- ── Plan tier from entitlements (active + unexpired), else trial ─────────────
create or replace function public.plan_tier(uid uuid) returns text
  language sql stable security definer set search_path = public as
$$
  select coalesce(
    -- School plans are ONE entitlement row held by the purchasing admin, with
    -- the school in entitlements.school_id — every MEMBER of a paid school is
    -- on the school tier (checked FIRST so it dominates any personal plan).
    (select 'school'
     from profiles p
     join entitlements e on e.school_id = p.school_id
     where p.id = uid and p.school_id is not null
       and e.active and e.plan_key like 'school%'
       and (e.current_period_end is null or e.current_period_end > now())
     limit 1),
    (select case
       when e.plan_key like 'teacher_pro_plus%' then 'pro_plus'
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
       when e.plan_key like 'teacher_pro%'      then 3
       when e.plan_key like 'family%'           then 4
       else 5 end
     limit 1),
    'trial');
$$;

-- ── The policy table-as-function: caps per tier ───────────────────────────────
create or replace function public.fair_use_caps(tier text)
returns table (parts_cap int, docs_cap int, books_cap int)
  language sql immutable as
$$
  -- Explicit column list: the declared return type has THREE columns, so the
  -- tier key must not leak into the projection (42P13 at CREATE otherwise).
  select t.parts_cap, t.docs_cap, t.books_cap from (values
    ('trial',    20,  40,  2147483647),  -- books bounded by the 0046 lifetime ledger
    ('pro',      20,  40,  2),
    ('pro_plus', 40,  80,  4),
    ('family',   10,  30,  2),
    ('school',   2147483647, 2147483647, 2147483647)
  ) as t(k, parts_cap, docs_cap, books_cap)
  where t.k = coalesce(tier, 'trial');
$$;

-- ── Usage counters (calendar month, UTC). Errors never count. ────────────────
create or replace function public.fair_use_used(uid uuid, unit text, month_start timestamptz)
returns int
  language sql stable security definer set search_path = public as
$$
  select coalesce(sum(case
    when unit = 'parts' then greatest(coalesce((g.params->>'video_parts')::int, 1), 1)
    else 1 end), 0)::int
  from generations g
  where g.owner_id = uid
    and g.status <> 'error'
    and g.created_at >= month_start
    and g.created_at < month_start + interval '1 month'
    and case when unit = 'parts'
             then g.kind = 'presentation'
             else g.kind in ('worksheet', 'exam_paper', 'lesson_plan', 'activity', 'case_study') end;
$$;

-- available = cap + carry − used;  carry = min(cap, unused last month), and
-- only for accounts older than this month.
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

-- ── Enforcement: BEFORE INSERT on generations ─────────────────────────────────
create or replace function enforce_fair_use() returns trigger
  language plpgsql security definer set search_path = public as
$$
declare
  tier text;
  caps record;
  a record;
begin
  -- Console-blessed accounts (any per-user override set: demo teachers,
  -- founder) are exempt from monthly fair-use — the overrides ARE their plan.
  if exists (select 1 from profiles p where p.id = new.owner_id
             and (p.max_books is not null or p.max_chapters is not null)) then
    return new;
  end if;
  tier := plan_tier(new.owner_id);
  select * into caps from fair_use_caps(tier);
  if new.kind = 'presentation' then
    if caps.parts_cap < 2147483647 then
      perform pg_advisory_xact_lock(hashtext('fair_use:' || new.owner_id::text));
      select * into a from fair_use_avail(new.owner_id, 'parts', caps.parts_cap);
      if a.available < 1 then
        raise exception 'Monthly fair-use limit reached: your plan includes % lesson parts/month (+% carried over). It resets on the 1st — or upgrade for more.',
          caps.parts_cap, a.carry;
      end if;
    end if;
  elsif new.kind in ('worksheet', 'exam_paper', 'lesson_plan', 'activity', 'case_study') then
    if caps.docs_cap < 2147483647 then
      perform pg_advisory_xact_lock(hashtext('fair_use:' || new.owner_id::text));
      select * into a from fair_use_avail(new.owner_id, 'docs', caps.docs_cap);
      if a.available < 1 then
        raise exception 'Monthly fair-use limit reached: your plan includes % documents/month (+% carried over). It resets on the 1st — or upgrade for more.',
          caps.docs_cap, a.carry;
      end if;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists fair_use_cap on generations;
create trigger fair_use_cap before insert on generations
  for each row execute function enforce_fair_use();

-- ── Books: monthly for PAID tiers, lifetime ledger for trial (0046) ──────────
create or replace function enforce_beta_book_cap() returns trigger
  language plpgsql security definer set search_path = public as
$$
declare
  cap int;
  tier text;
  caps record;
  a record;
  m0 timestamptz := date_trunc('month', now());
begin
  tier := plan_tier(new.owner_id);
  if tier = 'trial' then
    -- Lifetime rule (0046): uploads-ever minus refunded never-used deletes.
    cap := effective_cap(new.owner_id, 'books');
    if cap >= 2147483647 then
      return new;
    end if;
    perform pg_advisory_xact_lock(hashtext('beta_book:' || new.owner_id::text));
    if tg_op = 'UPDATE' then
      if auth.uid() = new.owner_id
         and (new.storage_path is distinct from old.storage_path
              or new.chapters is distinct from old.chapters
              or new.owner_id is distinct from old.owner_id)
         and (select count(*) from book_upload_ledger where owner_id = new.owner_id) >= cap then
        raise exception 'Your plan includes % book. Generate every content type for the book you already have, or upgrade for more.', cap;
      end if;
      return new;
    end if;
    if (select count(*) from book_upload_ledger where owner_id = new.owner_id) >= cap then
      raise exception 'Your plan includes % book (deleting a book you generated from does not free the slot). Upgrade for more.', cap;
    end if;
    return new;
  end if;

  -- Paid tiers: monthly uploads with rollover. A per-user console override
  -- (profiles.max_books) still wins when set (demo/founder accounts) — but the
  -- worker's own UPDATEs (indexing writes chapters!) must always pass, exactly
  -- like 0046: only an owner-authenticated content swap is ever checked.
  if (select max_books from profiles where id = new.owner_id) is not null then
    if tg_op = 'UPDATE'
       and (auth.uid() is distinct from new.owner_id
            or not (new.storage_path is distinct from old.storage_path
                    or new.chapters is distinct from old.chapters
                    or new.owner_id is distinct from old.owner_id)) then
      return new;
    end if;
    cap := effective_cap(new.owner_id, 'books');
    if (select count(*) from book_upload_ledger where owner_id = new.owner_id) >= cap
       and tg_op = 'INSERT' then
      raise exception 'Your plan includes % books.', cap;
    end if;
    return new;
  end if;
  select * into caps from fair_use_caps(tier);
  if caps.books_cap >= 2147483647 then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    -- Content-swap guard for paid tiers too: replacing a book's PDF in place
    -- must not dodge the monthly upload cap. NULL-safe polarity: the worker's
    -- service-role updates (auth.uid() null — indexing writes chapters) must
    -- ALWAYS pass, so the early-return fires unless this is provably an
    -- owner-authenticated content swap.
    if auth.uid() is distinct from new.owner_id
       or not (new.storage_path is distinct from old.storage_path
               or new.chapters is distinct from old.chapters
               or new.owner_id is distinct from old.owner_id) then
      return new;
    end if;
  end if;
  perform pg_advisory_xact_lock(hashtext('beta_book:' || new.owner_id::text));
  declare
    used_now int;
    used_prev int;
    carry_v int := 0;
  begin
    select count(*) into used_now from book_upload_ledger
      where owner_id = new.owner_id and created_at >= m0;
    if exists (select 1 from profiles p where p.id = new.owner_id and p.created_at < m0) then
      select count(*) into used_prev from book_upload_ledger
        where owner_id = new.owner_id and created_at >= m0 - interval '1 month' and created_at < m0;
      carry_v := least(caps.books_cap, greatest(0, caps.books_cap - used_prev));
    end if;
    if used_now >= caps.books_cap + carry_v then
      raise exception 'Monthly fair-use limit reached: your plan includes % new books/month (+% carried over). It resets on the 1st.',
        caps.books_cap, carry_v;
    end if;
  end;
  return new;
end $$;

-- ── The meter's read: my own fair-use status (auth.uid(), no parameters) ─────
create or replace function public.my_fair_use() returns jsonb
  language plpgsql stable security definer set search_path = public as
$$
declare
  uid uuid := auth.uid();
  tier text;
  caps record;
  p record;
  d record;
begin
  if uid is null then
    return null;
  end if;
  -- Console-blessed accounts are exempt from enforcement (see enforce_fair_use)
  -- — the meter must agree and stay hidden, not show a scary over-cap bar.
  if exists (select 1 from profiles p where p.id = uid
             and (p.max_books is not null or p.max_chapters is not null)) then
    return jsonb_build_object('tier', 'unlimited', 'unlimited', true);
  end if;
  tier := plan_tier(uid);
  select * into caps from fair_use_caps(tier);
  select * into p from fair_use_avail(uid, 'parts', caps.parts_cap);
  select * into d from fair_use_avail(uid, 'docs', caps.docs_cap);
  return jsonb_build_object(
    'tier', tier,
    'unlimited', caps.parts_cap >= 2147483647,
    'parts', jsonb_build_object('cap', caps.parts_cap, 'carry', p.carry, 'used', p.used,
                                'available', greatest(0, p.available)),
    'docs',  jsonb_build_object('cap', caps.docs_cap, 'carry', d.carry, 'used', d.used,
                                'available', greatest(0, d.available)),
    'resets_on', to_char(date_trunc('month', now()) + interval '1 month', 'YYYY-MM-DD')
  );
end;
$$;

revoke execute on function public.my_fair_use() from public, anon;
grant execute on function public.my_fair_use() to authenticated;
revoke execute on function public.plan_tier(uuid) from public, anon, authenticated;
revoke execute on function public.fair_use_used(uuid, text, timestamptz) from public, anon, authenticated;
revoke execute on function public.fair_use_avail(uuid, text, int) from public, anon, authenticated;
