-- 0130: the ready-made kits stay "coming soon" for everyone but the preview list.
--
-- Founder, 2026-10-16: the PUBLIC topic pages (explanations + links to the
-- YouTube lessons) are open to all. The KITS behind sign-in are visible only
-- to muqtadar1984@gmail.com until the founder releases them; everyone else
-- sees "coming soon / stay tuned".
--
-- The gate lives in the DATABASE, not only in the page: unlock_catalogue_kit
-- and catalogue_has_access are callable by any signed-in user straight from
-- the API, so a UI-only gate would leak. The switch is one platform_settings
-- row (RLS on, no client policy, so clients cannot read or change it):
--
--   catalogue_release = {"public": false, "preview_emails": ["muqtadar1984@gmail.com"]}
--
-- RELEASE TO EVERYONE (one statement, no deploy):
--   update platform_settings set value = jsonb_set(value, '{public}', 'true'), updated_at = now()
--    where key = 'catalogue_release';
-- ADD A TESTER:
--   update platform_settings set value = jsonb_set(value, '{preview_emails}',
--     (value->'preview_emails') || '"someone@example.com"'), updated_at = now()
--    where key = 'catalogue_release';
--
-- Before release, catalogue_ineligible_reason() answers 'coming_soon' for
-- anyone not on the list, so unlock refuses, access is false, and
-- my_catalogue_allowance() says {eligible:false, reason:'coming_soon',
-- released:false}. public_catalogue() is untouched: the public pages stay public.
-- Matching is on the sign-in email, case-insensitive (auth.users.email).

insert into public.platform_settings (key, value)
values ('catalogue_release', '{"public": false, "preview_emails": ["muqtadar1984@gmail.com"]}'::jsonb)
on conflict (key) do nothing;

create or replace function public.catalogue_released_for(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select (s.value->>'public')::boolean
        or exists (
             select 1
             from jsonb_array_elements_text(coalesce(s.value->'preview_emails', '[]'::jsonb)) e(email)
             join auth.users u on u.id = uid
             where lower(btrim(e.email)) = lower(u.email))
    from platform_settings s
    where s.key = 'catalogue_release'), false)
$$;

comment on function public.catalogue_released_for(uuid) is
  'Ready-made kits are live for this user: released to the public, or the user''s sign-in email is on platform_settings.catalogue_release.preview_emails. Missing setting = not released (fail closed).';

-- Same body as 0128 plus the 'coming_soon' branch, right after sign-in, so
-- everyone not yet released gets one answer whatever their role or plan.
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
    when not catalogue_released_for(uid) then 'coming_soon'
    when exists (select 1 from profiles p where p.id = uid and p.suspended_at is not null) then 'suspended'
    when exists (select 1 from profiles p where p.id = uid and p.role = 'student') then 'forbidden_role'
    when plan_tier(uid) = 'school_suspended' then 'suspended'
  end
$$;

-- Same body as 0128 plus `released`, so the page can choose between the tab
-- and the "coming soon" card without a second call.
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
    return jsonb_build_object('eligible', false, 'reason', 'not_signed_in', 'released', false);
  end if;
  tier := plan_tier(me);
  cap  := catalogue_weekly_cap(tier);
  select count(*)::int into used
    from catalogue_unlocks u
   where u.user_id = me and u.source = 'allowance' and u.week_start = wk;
  return jsonb_build_object(
    'eligible',  catalogue_ineligible_reason(me) is null,
    'reason',    catalogue_ineligible_reason(me),
    'released',  catalogue_released_for(me),
    'tier',      tier,
    'cap',       cap,
    'used',      used,
    'resets_at', (wk + 7)::timestamp at time zone 'UTC');
end
$$;

revoke all on function public.catalogue_released_for(uuid) from public, anon, authenticated;
grant execute on function public.catalogue_released_for(uuid) to service_role;
