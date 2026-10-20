-- Rollback for 0146: restore the 0109 / 0128 allowances.

create or replace function public.fair_use_caps(tier text)
returns table(parts_cap integer, docs_cap integer, books_cap integer)
language sql immutable as
$function$
  select t.parts_cap, t.docs_cap, t.books_cap from (values
    ('trial',      7, 0, 2147483647),
    ('promo',     28, 0, 2),
    ('pro',       28, 0, 2),
    ('pro_plus',  84, 0, 4),
    ('family',    14, 0, 2),
    ('homeschool',56, 0, 4),
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
    when 'pro_plus'         then 10
    when 'homeschool'       then 10
    when 'pro'              then 5
    when 'family'           then 5
    when 'school_suspended' then 0
    else 1   -- trial, promo, school_expired, anything new
  end
$$;
