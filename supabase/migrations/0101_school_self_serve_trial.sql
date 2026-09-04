-- 0101 — self-serve school registration: a school becomes a BOUNDED tenant the
-- moment it is created (a 30-day trial), and the tiers that make that true.
--
-- APPLIED TO PROD 2026-09-03 under the history name `0100_school_self_serve_trial`
-- (supabase_migrations version 20260903120051). Renumbered to 0101 in the repo
-- the next day: a book-delete migration landed on main as 0100 first. Same SQL.
--
-- WHY. /schoolsignup has been public since 0042 and creates a school with just
-- a name. Nothing distinguishes that school from a paying one except the
-- absence of an entitlements row — and plan_tier() answers that absence by
-- dropping every member to the INDIVIDUAL 'trial' tier (6 credits, one-part
-- pin). A school evaluating the product got crumbs; a school that stopped
-- paying would keep its members on crumbs forever; and schools.status, the only
-- kill switch, is honoured by the portal host alone — the dashboard never reads
-- it. Measured in prod on 2026-09-03: two schools exist, both demo, zero school
-- entitlements anywhere, so nothing here needs a backfill.
--
-- HOW.
--   * schools gains the trial clock (trial_started_at / trial_ends_at), who
--     created it, its country and contact, and a small `meta` of qualification
--     data the FORM collects. Every column on schools is member-readable (the
--     SELECT grant is table-wide and the RLS row test is "my school"), so
--     nothing private goes there: the registrant's phone and IP and the
--     founder's sales notes live in school_registrations, which has NO client
--     grants at all.
--   * plan_tier() learns three school states and resolves them in an order
--     that is the whole safety story:
--         suspended > paid school > personal paid > active trial > expired trial > legacy
--     Suspension beats a paid entitlement; a paid entitlement beats an expired
--     clock; a member's OWN paid plan beats their school's trial (they pay for
--     it); a school with NO clock — every school that exists today — resolves
--     exactly as before.
--   * school_trial is a PERIOD budget counted from the trial anchor, the way
--     promo was — not a monthly allowance — so a trial straddling the 1st cannot
--     double. school_expired / school_suspended are hard-stopped at the TOP of
--     both enforcer triggers: the exam and revision-paper branches return before
--     any credit check, so a 0 cap alone would not have stopped them.
--   * finish_school_registration() does the whole registration in ONE
--     transaction — profile row lock, confirmed-email check, school insert,
--     admin role, audit row — and is idempotent: a retried or timed-out request
--     returns the school it already made. A partial unique index makes "one
--     self-serve school per creator" a fact of the table, not of the route.
--   * set_school_slug() stops minting slugs the portal proxy reserves
--     (src/utils/school-routing.ts RESERVED_SEGMENTS): a school named
--     "Dashboard" used to get the slug `dashboard` and simply never resolve.
--
-- Idempotent: every statement is create-or-replace / if-not-exists; safe to
-- re-run.

-- ── 1. schools: the trial clock, who made it, where it is ────────────────────

alter table public.schools
  add column if not exists country          text,
  add column if not exists contact_email    text,
  add column if not exists created_by       uuid references auth.users(id) on delete set null,
  add column if not exists trial_started_at timestamptz,
  add column if not exists trial_ends_at    timestamptz,
  add column if not exists meta             jsonb not null default '{}'::jsonb;

-- Derived once, for the console's "same organisation?" flags. NULL when there
-- is no contact (every pre-0101 school).
alter table public.schools
  add column if not exists email_domain text
    generated always as (nullif(lower(split_part(coalesce(contact_email, ''), '@', 2)), '')) stored;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'schools_country_chk') then
    alter table public.schools
      add constraint schools_country_chk check (country is null or country ~ '^[A-Z]{2}$');
  end if;
end $$;

-- 'suspended' is the console kill switch (plan_tier branch 1). 'archived' keeps
-- its 0042 meaning. The portal host already refuses anything but 'active'.
alter table public.schools drop constraint if exists schools_status_chk;
alter table public.schools
  add constraint schools_status_chk check (status in ('active', 'suspended', 'archived'));

-- One self-serve school per creator — belt to finish_school_registration()'s
-- row-lock braces. Seeded / staff-created schools carry no source and are exempt.
create unique index if not exists schools_one_self_serve_per_creator
  on public.schools (created_by) where (meta->>'source') = 'self_serve';

create index if not exists schools_trial_ends_idx
  on public.schools (trial_ends_at) where trial_ends_at is not null;

comment on column public.schools.trial_ends_at is
  '0101: NULL = no trial clock (legacy/seeded/staff-activated). Set only by self-serve registration and the console. plan_tier() reads it AFTER the paid entitlement check, so expiry can never override a paying school.';
comment on column public.schools.meta is
  '0101: member-readable qualification data from the registration form — source, school_type, size_band, curricula, name_key. Nothing private: see school_registrations.';

-- ── 2. school_registrations: the private half of a registration ─────────────
-- Console-only. No policies, no client grants — service role reads and writes.

create table if not exists public.school_registrations (
  school_id               uuid primary key references public.schools(id) on delete cascade,
  user_id                 uuid references public.profiles(id) on delete set null,
  registrant_role         text,
  phone                   text,
  heard_from              text,
  reg_ip                  text,
  -- Hand-set by the founder; never derived. The derived lifecycle (trial /
  -- expired / paid / suspended) is computed from schools + entitlements.
  sales_stage             text not null default 'new'
                          check (sales_stage in ('new', 'contacted', 'invoice_sent', 'paid', 'lost')),
  sales_notes             text,
  activation_requested_at timestamptz,
  stripe_customer_id      text,
  stripe_invoice_id       text,
  hosted_invoice_url      text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

alter table public.school_registrations enable row level security;
revoke all on public.school_registrations from anon, authenticated;

-- ── 3. Reserved slugs: the proxy's list, enforced where slugs are minted ──────

create or replace function public.school_slug_reserved(p_slug text) returns boolean
  language sql immutable as
$$
  -- Mirror of RESERVED_SEGMENTS in src/utils/school-routing.ts. A slug in this
  -- list is routed as an app path on the school host and never reaches the
  -- tenant resolver.
  select p_slug = any (array[
    'api', 'auth', 'console', 'dashboard', 'invite', 'login', 'signup',
    'schoolsignup', 'onboarding', 'staff-login', 'school', 'present', 'preview',
    'favicon.ico', '_next'
  ]);
$$;

create or replace function public.set_school_slug() returns trigger
  language plpgsql security definer set search_path = public as
$$
declare
  base text;
  candidate text;
  n int := 1;
begin
  if new.slug is not null and new.slug <> '' then
    new.slug := lower(new.slug);
    -- An explicit reserved slug is a seeder/operator mistake — say so.
    if school_slug_reserved(new.slug) then
      raise exception 'Slug "%" is reserved by the portal router; choose another.', new.slug;
    end if;
    return new;
  end if;
  base := school_slugify(new.name);
  -- A school called "Dashboard" gets dashboard-school, not a dead address.
  if school_slug_reserved(base) then
    base := base || '-school';
  end if;
  candidate := base;
  while exists (select 1 from schools where slug = candidate) loop
    n := n + 1;
    candidate := base || '-' || n;
  end loop;
  new.slug := candidate;
  return new;
end;
$$;

-- ── 4. Tiers ─────────────────────────────────────────────────────────────────

create or replace function public.school_trial_days() returns int
  language sql immutable as
$$ select 30 $$;

-- The trial anchor: usage is a period total from here, never a monthly bucket.
create or replace function public.school_trial_anchor(uid uuid) returns timestamptz
  language sql stable security definer set search_path = public as
$$
  select coalesce(s.trial_started_at, s.created_at)
  from profiles p join schools s on s.id = p.school_id
  where p.id = uid;
$$;

-- fair_use_used() without the one-month upper bound: everything since `since`.
-- Same two sources (ledger rows on the plan, plus generations the ledger has
-- not caught up with), same video_parts weighting — a school trial straddling
-- the 1st, or extended by the console, must count every generation it made.
create or replace function public.fair_use_used_since(uid uuid, since timestamptz) returns int
  language sql stable security definer set search_path = public as
$$
  select (
    coalesce((select sum(cl.units) from credit_ledger cl
              where cl.owner_id = uid and not cl.voided
                and coalesce(cl.source, 'plan') = 'plan'
                and cl.created_at >= since), 0)
    +
    coalesce((select sum(case when g.kind = 'presentation'
                              then greatest(coalesce((g.params->>'video_parts')::int, 1), 1)
                              else 1 end)
              from generations g
              where g.owner_id = uid
                and g.kind in ('presentation','worksheet','exam_paper','lesson_plan','activity','case_study')
                and g.status <> 'error'
                and g.created_at >= since
                and not exists (select 1 from credit_ledger cl2 where cl2.generation_id = g.id)), 0)
  )::int;
$$;

create or replace function public.fair_use_caps(tier text)
returns table(parts_cap integer, docs_cap integer, books_cap integer)
language sql immutable as
$function$
  select t.parts_cap, t.docs_cap, t.books_cap from (values
    -- parts_cap is a count of GENERATIONS (0075), not lessons.
    ('trial',      6, 0, 2147483647),  -- 1 kit — the 0057 pin, priced honestly (was 96; books via 0046 lifetime ledger)
    ('promo',     24, 0, 2),           -- 4 kits — launch trial (expired 2026-08-14; branch kept for history)
    ('pro',       24, 0, 2),           -- 4 kits
    ('pro_plus',  72, 0, 4),           -- 12 kits
    ('family',    12, 0, 2),           -- 2 kits — sold as "Home Basic" (plan_key unchanged)
    ('homeschool',48, 0, 4),           -- 8 kits, 4 books/month, 10 learners
    ('school',    2147483647, 2147483647, 2147483647),
    -- 0101: school states. school_trial is a PERIOD budget for the whole trial
    -- (any mix of kinds — docs_cap has been retired since 0059), counted from
    -- school_trial_anchor(); the two locked states are hard-stopped in the
    -- enforcers before these zeros are ever read.
    ('school_trial',     12, 0, 2),
    ('school_expired',    0, 0, 0),
    ('school_suspended',  0, 0, 0)
  ) as t(k, parts_cap, docs_cap, books_cap)
  where t.k = coalesce(tier, 'trial');
$function$;

create or replace function public.plan_tier(uid uuid) returns text
  language sql stable security definer set search_path = public as
$function$
  select coalesce(
    -- 0101 (1): a suspended school locks every member — paid or not. This is
    -- the console kill switch; nothing below can out-rank it.
    (select 'school_suspended'
     from profiles p join schools s on s.id = p.school_id
     where p.id = uid and s.status <> 'active'),
    -- (2) School plan (one entitlement held by the admin; every member is 'school').
    (select 'school'
     from profiles p
     join entitlements e on e.school_id = p.school_id
     where p.id = uid and p.school_id is not null
       and e.active and e.plan_key like 'school%'
       and (e.current_period_end is null or e.current_period_end > now())
     limit 1),
    -- (3) Personal paid entitlement (the buyer's own plan). Ranked above the
    -- school trial on purpose: a teacher who pays for Pro keeps Pro even while
    -- their school is only trialling, and keeps it after that trial expires.
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
    -- 0101 (4): a school inside its trial window.
    (select 'school_trial'
     from profiles p join schools s on s.id = p.school_id
     where p.id = uid and s.trial_ends_at is not null and s.trial_ends_at > now()),
    -- 0101 (5): the clock ran out and nothing was paid — read-only until the
    -- console activates it. A school with NO clock (every school that predates
    -- 0101) skips (4) and (5) and resolves exactly as it did before.
    (select 'school_expired'
     from profiles p join schools s on s.id = p.school_id
     where p.id = uid and s.trial_ends_at is not null and s.trial_ends_at <= now()),
    -- Launch free-trial period: any non-school account with no paid plan, while
    -- the promo runs. School members are out (staff-provisioned/sales-led).
    (select 'promo'
     from profiles p
     where p.id = uid and p.school_id is null and now() < promo_ends_at()),
    'trial');
$function$;

-- ── 5. Enforcers: hard-stop the locked states, budget the trial ──────────────

create or replace function public.enforce_fair_use() returns trigger
  language plpgsql security definer set search_path = public as
$function$
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
  tier := plan_tier(new.owner_id);

  -- 0101: the locked school states are decided FIRST. Suspension is the console
  -- kill switch, so it sits above even the console cap override; expiry sits
  -- just below that override (a blessed account stays blessed). Both must come
  -- before the exam and revision-paper branches, which return without ever
  -- reaching a credit check — a 0 cap alone would not stop them.
  if tier = 'school_suspended' then
    raise exception 'Your school''s SketchCast access is suspended. Please contact support.';
  end if;

  if exists (select 1 from profiles p where p.id = new.owner_id
             and (p.max_books is not null or p.max_chapters is not null)) then
    return new;
  end if;

  if tier = 'school_expired' then
    raise exception 'Your school''s free trial has ended. Ask your SketchCast contact to activate the school to keep generating.';
  end if;

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
    -- 0101: the school trial is a period total from its anchor, not a month.
    if tier = 'school_trial' then
      if fair_use_used_since(new.owner_id, school_trial_anchor(new.owner_id)) >= eff_cap then
        raise exception 'Your school''s free trial includes % generations, and you''ve used them all. Ask your SketchCast contact to activate the school to keep generating.',
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
    elsif tier = 'school_trial' then
      -- 0101: same period budget as the lesson path.
      if fair_use_used_since(new.owner_id, school_trial_anchor(new.owner_id)) >= eff_cap then
        raise exception 'Your school''s free trial includes % generations, and you''ve used them all. Ask your SketchCast contact to activate the school to keep generating.',
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
$function$;

create or replace function public.enforce_beta_book_cap() returns trigger
  language plpgsql security definer set search_path = public as
$function$
declare
  cap int;
  tier text;
  caps record;
  m0 timestamptz := date_trunc('month', now());
begin
  tier := plan_tier(new.owner_id);

  -- 0101: locked school states. Uploads stop; nothing already on the shelf is
  -- touched. Only new rows are refused — service-role UPDATEs (indexing, health,
  -- chapter heals) run with auth.uid() NULL and must keep flowing, and the
  -- per-tier UPDATE branches below already refuse a member's own re-upload.
  if tg_op = 'INSERT' and tier = 'school_suspended' then
    raise exception 'Your school''s SketchCast access is suspended. Please contact support.';
  end if;
  if tg_op = 'INSERT' and tier = 'school_expired'
     and (select max_books from profiles where id = new.owner_id) is null then
    raise exception 'Your school''s free trial has ended. Ask your SketchCast contact to activate the school to add books.';
  end if;

  -- Promo (launch trial): a PERIOD total from the promo anchor, so it doesn't
  -- reset at the month boundary the promo crosses. Console-blessed accounts
  -- (a max_books override — founder/demo) fall THROUGH to their override
  -- branch below, which honours the override number; without this gate the
  -- promo cap would pin them to 2 books while my_fair_use shows "unlimited".
  if tier = 'promo'
     and (select max_books from profiles where id = new.owner_id) is null then
    select * into caps from fair_use_caps('promo');
    cap := caps.books_cap;
    perform pg_advisory_xact_lock(hashtext('beta_book:' || new.owner_id::text));
    if tg_op = 'UPDATE' then
      if auth.uid() = new.owner_id
         and (new.storage_path is distinct from old.storage_path
              or new.chapters is distinct from old.chapters
              or new.owner_id is distinct from old.owner_id)
         and (select count(*) from book_upload_ledger
              where owner_id = new.owner_id and created_at >= promo_credit_from()) >= cap then
        raise exception 'Your free trial includes % books. Subscribe to add more.', cap;
      end if;
      return new;
    end if;
    if (select count(*) from book_upload_ledger
        where owner_id = new.owner_id and created_at >= promo_credit_from()) >= cap then
      raise exception 'Your free trial includes % books. Subscribe to add more.', cap;
    end if;
    return new;
  end if;

  -- 0101: the school trial — the promo shape, anchored at the school's trial
  -- start. A period total, so it cannot reset on the 1st.
  if tier = 'school_trial'
     and (select max_books from profiles where id = new.owner_id) is null then
    select * into caps from fair_use_caps('school_trial');
    cap := caps.books_cap;
    perform pg_advisory_xact_lock(hashtext('beta_book:' || new.owner_id::text));
    if tg_op = 'UPDATE' then
      if auth.uid() = new.owner_id
         and (new.storage_path is distinct from old.storage_path
              or new.chapters is distinct from old.chapters
              or new.owner_id is distinct from old.owner_id)
         and (select count(*) from book_upload_ledger
              where owner_id = new.owner_id and created_at >= school_trial_anchor(new.owner_id)) >= cap then
        raise exception 'Your school''s free trial includes % books. Ask your SketchCast contact to activate the school to add more.', cap;
      end if;
      return new;
    end if;
    if (select count(*) from book_upload_ledger
        where owner_id = new.owner_id and created_at >= school_trial_anchor(new.owner_id)) >= cap then
      raise exception 'Your school''s free trial includes % books. Ask your SketchCast contact to activate the school to add more.', cap;
    end if;
    return new;
  end if;

  if tier = 'trial' then
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

  -- Paid tiers: monthly uploads with rollover; a console override wins.
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
end
$function$;

-- ── 6. The meter's read: mirror the enforcers, never guard ───────────────────

create or replace function public.my_fair_use() returns jsonb
  language plpgsql stable security definer set search_path = public as
$function$
declare
  uid uuid := auth.uid();
  tier text;
  caps record;
  c record;
  promo_used int;
  eff_cap int;
  trial_used int;
  trial_end text;
begin
  if uid is null then
    return null;
  end if;
  tier := plan_tier(uid);

  -- 0101: the school's trial end, as the meter's date. NULL for every school
  -- without a clock, and for everyone outside a school.
  select to_char(s.trial_ends_at at time zone 'UTC', 'YYYY-MM-DD') into trial_end
    from profiles p join schools s on s.id = p.school_id
   where p.id = uid;

  -- 0101: locked states, in the enforcers' order — suspension above the
  -- console override, expiry below it. `locked` is the meter's cue; the zero
  -- bucket keeps the pre-0101 readers rendering something sane.
  if tier = 'school_suspended' then
    return jsonb_build_object(
      'tier', tier, 'unlimited', false, 'locked', true,
      'credits', jsonb_build_object('cap', 0, 'carry', 0, 'used', 0, 'available', 0),
      'granted', 0,
      'trial_ends', trial_end,
      'resets_on', coalesce(trial_end, to_char(now() at time zone 'UTC', 'YYYY-MM-DD'))
    );
  end if;

  if exists (select 1 from profiles p where p.id = uid
             and (p.max_books is not null or p.max_chapters is not null)) then
    return jsonb_build_object('tier', 'unlimited', 'unlimited', true);
  end if;

  if tier = 'school_expired' then
    return jsonb_build_object(
      'tier', tier, 'unlimited', false, 'locked', true,
      'credits', jsonb_build_object('cap', 0, 'carry', 0, 'used', 0, 'available', 0),
      'granted', 0,
      'trial_ends', trial_end,
      'resets_on', coalesce(trial_end, to_char(now() at time zone 'UTC', 'YYYY-MM-DD'))
    );
  end if;

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

  -- 0101: the school trial reads like promo did — a period budget with an end
  -- date — under its own flag so the meter can word the next step honestly
  -- ("ask us to activate", not "subscribe").
  if tier = 'school_trial' then
    trial_used := fair_use_used_since(uid, school_trial_anchor(uid));
    return jsonb_build_object(
      'tier', 'school_trial',
      'unlimited', false,
      'school_trial', true,
      'credits', jsonb_build_object('cap', eff_cap, 'carry', 0, 'used', trial_used,
                                    'available', greatest(0, eff_cap - trial_used)),
      'granted', fair_use_granted(uid),
      'resets_on', trial_end,
      'trial_ends', trial_end
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
$function$;

-- ── 7. Registration: one transaction, idempotent ─────────────────────────────
-- Called by /api/school-finish through the service role, AFTER the route has
-- done what only a route can (Turnstile, rate limit, request headers). The
-- function is the part that must never half-happen.
--
-- Errors are short machine strings the route maps to copy:
--   email_not_confirmed · name_too_short · no_profile

create or replace function public.finish_school_registration(
  p_user uuid,
  p_name text,
  p_country text,
  p_meta jsonb default '{}'::jsonb,
  p_registration jsonb default '{}'::jsonb
) returns jsonb
  language plpgsql security definer set search_path = public as
$function$
declare
  v_existing uuid;
  v_email text;
  v_confirmed timestamptz;
  v_name text := trim(coalesce(p_name, ''));
  v_country text := upper(nullif(trim(coalesce(p_country, '')), ''));
  v_school_id uuid;
  v_slug text;
  v_now timestamptz := now();
  v_meta jsonb;
  v_curricula jsonb;
begin
  if p_user is null then
    raise exception 'no_profile';
  end if;

  -- The row lock is what makes a double-submit produce one school: the second
  -- caller waits here, then sees school_id already set and returns it.
  select school_id into v_existing from profiles where id = p_user for update;
  if not found then
    raise exception 'no_profile';
  end if;
  if v_existing is not null then
    select slug into v_slug from schools where id = v_existing;
    return jsonb_build_object('school_id', v_existing, 'slug', v_slug, 'created', false);
  end if;

  select email, email_confirmed_at into v_email, v_confirmed from auth.users where id = p_user;
  if v_confirmed is null then
    raise exception 'email_not_confirmed';
  end if;
  if length(v_name) < 2 then
    raise exception 'name_too_short';
  end if;
  if v_country !~ '^[A-Z]{2}$' then
    v_country := null;
  end if;

  -- meta is member-readable, so it is rebuilt from a whitelist — never stored
  -- as received. Values are clipped; the form's vocabularies are validated in
  -- the route, this is the second gate.
  v_curricula := case when jsonb_typeof(p_meta->'curricula') = 'array'
                      then (select coalesce(jsonb_agg(left(s.x, 40)), '[]'::jsonb)
                              from (select x from jsonb_array_elements_text(p_meta->'curricula') x
                                     where x <> '' limit 10) s)
                      else '[]'::jsonb end;
  v_meta := jsonb_strip_nulls(jsonb_build_object(
    'source',      'self_serve',
    'school_type', left(nullif(trim(coalesce(p_meta->>'school_type', '')), ''), 40),
    'size_band',   left(nullif(trim(coalesce(p_meta->>'size_band', '')), ''), 20),
    'curricula',   v_curricula,
    'name_key',    school_slugify(v_name)
  ));

  insert into schools (name, display_name, country, contact_email, created_by,
                       trial_started_at, trial_ends_at, status, config, meta)
  values (v_name, v_name, v_country, v_email, p_user,
          v_now, v_now + make_interval(days => school_trial_days()), 'active',
          -- The seeder's defaults minus the assistant (its flag is off
          -- product-wide): a trial portal should not look empty on day one.
          jsonb_build_object('school_analytics', true, 'calendar', true, 'timetable_enabled', true),
          v_meta)
  returning id, slug into v_school_id, v_slug;

  insert into school_registrations (school_id, user_id, registrant_role, phone, heard_from, reg_ip)
  values (v_school_id, p_user,
          left(nullif(trim(coalesce(p_registration->>'registrant_role', '')), ''), 40),
          left(nullif(trim(coalesce(p_registration->>'phone', '')), ''), 40),
          left(nullif(trim(coalesce(p_registration->>'heard_from', '')), ''), 80),
          left(nullif(trim(coalesce(p_registration->>'reg_ip', '')), ''), 64));

  -- role/school_id are service-role-only columns (0010); this function is the
  -- one place self-serve may set them. onboarded_at is stamped because setting
  -- up a school identifies the user as its admin — they skip the joiner gate
  -- (0038), exactly as the old route did.
  update profiles
     set role = 'school_admin', school_id = v_school_id,
         onboarded_at = coalesce(onboarded_at, v_now)
   where id = p_user;

  insert into platform_audit_log (actor_id, action, target_kind, target_id, detail)
  values (p_user, 'school.self_serve_registered', 'school', v_school_id,
          jsonb_build_object('name', v_name, 'slug', v_slug, 'country', v_country,
                             'trial_ends_at', v_now + make_interval(days => school_trial_days()),
                             'meta', v_meta));

  return jsonb_build_object('school_id', v_school_id, 'slug', v_slug, 'created', true);
end;
$function$;

-- ── 8. Grants ────────────────────────────────────────────────────────────────

revoke execute on function public.plan_tier(uuid)                               from public, anon, authenticated;
revoke execute on function public.school_trial_anchor(uuid)                     from public, anon, authenticated;
revoke execute on function public.fair_use_used_since(uuid, timestamptz)        from public, anon, authenticated;
revoke execute on function public.finish_school_registration(uuid, text, text, jsonb, jsonb) from public, anon, authenticated;
grant  execute on function public.finish_school_registration(uuid, text, text, jsonb, jsonb) to service_role;
