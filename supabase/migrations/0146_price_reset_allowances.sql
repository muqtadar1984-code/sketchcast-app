-- 0146: Price reset (founder, 2026-10-20) — the allowances that go with it.
--
-- Prices move on the pricing page and in Lemon Squeezy (Teacher Pro and Home
-- Basic $10/mo, Teacher Pro+ and Homeschool $20/mo, annual = 10×). What the
-- DATABASE decides is how much each plan may use, so this migration changes
-- only those numbers:
--
--   monthly generations (fair_use_caps.parts_cap; a kit = 7 generations, the
--   deck rides free so it costs 6):
--     pro_plus   84 → 56   (about 12 → 8 kits: the same $2.50 a kit as Pro)
--     family     14 → 28   (Home Basic: about 2 → 4 kits, mirroring Pro)
--     pro 28, homeschool 56 unchanged
--   weekly ready-made kits (catalogue_weekly_cap):
--     pro 5 → 4, family 5 → 4, pro_plus 10 → 8, homeschool 10 → 8; free stays 1
--
-- No subscriber is affected today: entitlements holds one expired row. The
-- rollover in fair_use_avail (carry = least(cap, cap − used_prev)) reads the
-- NEW cap from the next month, so a Pro+ subscriber's carry can never exceed
-- the new 56.
--
-- Both functions are recreated exactly as live (0109 / 0128) with only the
-- numbers changed; CREATE OR REPLACE keeps their grants.

create or replace function public.fair_use_caps(tier text)
returns table(parts_cap integer, docs_cap integer, books_cap integer)
language sql immutable as
$function$
  select t.parts_cap, t.docs_cap, t.books_cap from (values
    -- parts_cap is a count of GENERATIONS (0075), not lessons. A kit is SEVEN
    -- generations but SIX credits (0103: the deck rides free).
    ('trial',      7, 0, 2147483647),  -- 1 kit
    ('promo',     28, 0, 2),           -- 4 kits — launch trial (expired 2026-08-14; kept for history)
    ('pro',       28, 0, 2),           -- 4 kits — $10/mo (0146)
    ('pro_plus',  56, 0, 4),           -- 8 kits — $20/mo (0146: was 84)
    ('family',    28, 0, 2),           -- 4 kits — "Home Basic", $10/mo (0146: was 14)
    ('homeschool',56, 0, 4),           -- 8 kits, 4 books/month, 10 learners — $20/mo
    ('school',    2147483647, 2147483647, 2147483647),
    -- 0109: SketchCast staff (platform_admins). A sentinel, not a quantity —
    -- the same one 'school' carries, so every enforcer's unlimited path applies.
    ('staff',     2147483647, 2147483647, 2147483647),
    ('school_trial',     14, 0, 2),
    ('school_expired',    0, 0, 0),
    ('school_suspended',  0, 0, 0)
  ) as t(k, parts_cap, docs_cap, books_cap)
  where t.k = coalesce(tier, 'trial');
$function$;

create or replace function public.catalogue_weekly_cap(tier text)
returns integer
language sql
immutable
set search_path = public
as $$
  -- NULL = unlimited. An unknown tier gets the free allowance, never unlimited.
  select case coalesce(tier, 'trial')
    when 'staff'            then null
    when 'school'           then null
    when 'school_trial'     then null
    when 'pro_plus'         then 8    -- 0146: was 10
    when 'homeschool'       then 8    -- 0146: was 10
    when 'pro'              then 4    -- 0146: was 5
    when 'family'           then 4    -- 0146: was 5
    when 'school_suspended' then 0
    else 1   -- trial, promo, school_expired, anything new
  end
$$;
