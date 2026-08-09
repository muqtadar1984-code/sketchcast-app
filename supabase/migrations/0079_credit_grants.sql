-- 0079 — Per-user credit grants, so support can comp a teacher without
-- making the account unlimited.
--
-- WHY THIS EXISTS. Our first organic university upload (Sterman's Business
-- Dynamics, 1,008 pages) produced 17 kits from a text layer that turned out to
-- be unreadable OCR — 0078's sibling work fixed the detection, but the teacher
-- had already spent 17 of her 24 promo generations on output built from
-- mojibake. We want to hand those back so she can re-upload and try again.
--
-- THERE WAS NO WAY TO DO THAT. The three levers that existed are all wrong:
--   · profiles.max_chapters — `enforce_fair_use` returns at its FIRST line when
--     any per-user override is set (0047 pattern), so this grants UNLIMITED,
--     not +18, and simultaneously exempts the account from the book cap and the
--     trial pin. `my_fair_use` likewise reports tier 'unlimited' and the meter
--     disappears from the UI.
--   · fair_use_caps() — hardcoded per TIER, so raising promo to 42 would grant
--     18 free generations to every promo user on the platform.
--   · voiding ledger rows — dishonest accounting, and it would poison the
--     void_reason semantics 0078 just established (a row would read
--     'unconsumed_on_delete' when the work very much was consumed).
--
-- So: a real grant, added to the tier cap, recorded with who/why/when.
--
-- WINDOWED ON PURPOSE. A grant with no expiry is a permanent cap increase. The
-- promo tier counts from a fixed anchor (promo_credit_from()), but every paid
-- tier counts per calendar month — so an unbounded grant would silently hand
-- the same bonus back every month forever if the user later subscribes. Each
-- grant therefore carries expires_at, and fair_use_granted() only counts live
-- ones.
--
-- Idempotent. Requires 0059, 0075.

-- ── 1. The grants ────────────────────────────────────────────────────────────
create table if not exists public.credit_grants (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users(id) on delete cascade,
  units       int  not null check (units > 0),
  reason      text not null,
  granted_by  uuid references auth.users(id),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz
);

comment on table public.credit_grants is
  'Per-user generation credits comped by support. ADDS to the tier cap; never makes an account unlimited. Windowed via expires_at so a grant cannot recur monthly on a paid tier.';

create index if not exists credit_grants_owner_live_idx
  on public.credit_grants (owner_id, expires_at);

-- Same posture as credit_ledger (0059:54): the ledger is platform-owned truth.
-- A teacher must not be able to write themselves credits, and does not need to
-- read the table either — my_fair_use() already reports the effective cap.
alter table public.credit_grants enable row level security;
revoke all on public.credit_grants from anon, authenticated;

-- ── 2. How many live granted credits a user has ──────────────────────────────
create or replace function public.fair_use_granted(uid uuid) returns integer
  language sql stable security definer set search_path = public as
$$
  select coalesce(sum(g.units), 0)::int
    from credit_grants g
   where g.owner_id = uid
     and (g.expires_at is null or g.expires_at > now());
$$;

-- ── 3. Fold the grant into enforcement ───────────────────────────────────────
-- Body is the live 0075 function verbatim, with ONE change: every place that
-- compared against caps.parts_cap now compares against eff_cap, which is the
-- tier cap plus any live grant. The unlimited sentinel is left alone rather
-- than added to, so school accounts cannot overflow int.
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
    if a.available < 1 then
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
      if a.available < 1 then
        raise exception 'Monthly limit reached: your plan includes % generations/month (+% carried over) — a lesson, a worksheet, a plan, an activity, a test paper and a case study each count as one. It resets on the 1st, or upgrade for more.',
          eff_cap, a.carry;
      end if;
    end if;
  end if;
  return new;
end;
$$;

-- ── 4. And into the meter the teacher actually sees ───────────────────────────
-- Without this the UI would keep saying 24 while enforcement allowed 42, and
-- the teacher would not know she had been given anything.
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
    'granted', fair_use_granted(uid),
    'resets_on', to_char(date_trunc('month', now()) + interval '1 month', 'YYYY-MM-DD')
  );
end;
$$;

-- ── 5. The grant ─────────────────────────────────────────────────────────────
-- 18 generations = three complete six-piece kits, which is what she needs to
-- re-run the chapters she has already taught from once the book is re-indexed.
-- Expires 2026-09-08: deliberately well past promo_ends_at() (2026-08-14), or
-- the grant would evaporate five days from now and mean nothing. Guarded on the
-- reason string so re-running the migration cannot double-grant.
insert into public.credit_grants (owner_id, units, reason, expires_at)
select u.id, 18,
       'Goodwill: first organic university upload (Sterman, Business Dynamics). '
       'Her 17 generations were built from a broken OCR text layer that book_health '
       'scored 95/100 "excellent" — see worker 6a300fd. Comped so she can re-upload '
       'and regenerate once the fixed indexing is live.',
       timestamptz '2026-09-08 23:59:59+00'
  from auth.users u
 where u.email = '222238072819@univ-constantine3.dz'
   and not exists (
     select 1 from credit_grants g
      where g.owner_id = u.id and g.reason like 'Goodwill: first organic university upload%');
