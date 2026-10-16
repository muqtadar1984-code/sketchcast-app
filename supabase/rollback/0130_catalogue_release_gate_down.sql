-- Rollback for 0130_catalogue_release_gate.sql: restores the 0128 bodies of
-- catalogue_ineligible_reason and my_catalogue_allowance, drops the gate
-- function and the setting. WARNING: this OPENS the kits to every eligible
-- user (the 0128 behaviour). Run inside a transaction.

create or replace function public.catalogue_ineligible_reason(uid uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when uid is null then 'not_signed_in'
    when not exists (select 1 from profiles p where p.id = uid) then 'not_signed_in'
    when exists (select 1 from profiles p where p.id = uid and p.suspended_at is not null) then 'suspended'
    when exists (select 1 from profiles p where p.id = uid and p.role = 'student') then 'forbidden_role'
    when plan_tier(uid) = 'school_suspended' then 'suspended'
  end
$$;

create or replace function public.my_catalogue_allowance()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me   uuid := auth.uid();
  tier text;
  cap  int;
  wk   date := catalogue_week_start(now());
  used int;
begin
  if me is null then
    return jsonb_build_object('eligible', false, 'reason', 'not_signed_in');
  end if;
  tier := plan_tier(me);
  cap  := catalogue_weekly_cap(tier);
  select count(*)::int into used
    from catalogue_unlocks u
   where u.user_id = me and u.source = 'allowance' and u.week_start = wk;
  return jsonb_build_object(
    'eligible',  catalogue_ineligible_reason(me) is null,
    'reason',    catalogue_ineligible_reason(me),
    'tier',      tier,
    'cap',       cap,
    'used',      used,
    'resets_at', (wk + 7)::timestamp at time zone 'UTC');
end
$$;

drop function if exists public.catalogue_released_for(uuid);
delete from public.platform_settings where key = 'catalogue_release';
