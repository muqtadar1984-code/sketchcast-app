-- 0098 — capture the country when the ACCOUNT is created, not when onboarding
-- is finished.
--
-- WHY. 0085 added profiles.country and the blocking onboarding step fills it,
-- and that half works: measured in prod on 2026-08-31, every one of the 63
-- onboarded adults had a country, none missing. But onboarding is step TWO. The
-- profile row exists from the moment auth.users does, so anyone who never
-- reaches or never finishes that step is a permanent blank — 19 rows on the day
-- this was written:
--
--   12  self-signup students   — exempt from the onboarding gate by design
--                                (dashboard/layout.tsx): students have their own
--                                must-reset-password first run and the form has
--                                no student branch, so gating them would trap
--                                them with nowhere to go
--    4  adults who abandoned the form  (accepted: they are dead rows)
--    3  who confirmed and never signed in, or never confirmed at all
--
-- None of those are recoverable after the fact — auth.audit_log_entries is
-- pruned by Supabase and was empty, so no IP survives anywhere. The only fix is
-- to stop creating new ones, which means capturing at INSERT.
--
-- HOW. handle_new_user already copies full_name and role out of
-- raw_user_meta_data, which every creation path controls: the signup form
-- (options.data), and admin.createUser (user_metadata) for provisioned
-- students. Adding country there covers BOTH in one place, and covers them
-- before the first sign-in, which is the only way to reach the "never signed
-- in" rows at all. Google OAuth is the one path that can't use it — the
-- metadata comes from Google — so /auth/callback writes it after the exchange,
-- and the dashboard layout backstops everything else.
--
-- The value always comes from the CDN's edge header, so it is always
-- country_source='assumed' and renders "≈ EG" on the console. The user's own
-- answer at onboarding overwrites it with 'signup'. That distinction is the
-- whole reason 0085 has a provenance column, and this migration must not blur
-- it: a guess is never recorded as an answer.
--
-- Idempotent: CREATE OR REPLACE, safe to re-run.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_country text;
begin
  -- Shape-checked here rather than trusted: raw_user_meta_data is client
  -- supplied. The app only ever puts an assigned ISO code in it (see
  -- src/utils/geo.ts, which validates against the full alpha-2 list), so this
  -- is the second gate, not the only one. Anything unexpected becomes NULL —
  -- a missing country must never fail a registration.
  v_country := upper(nullif(trim(new.raw_user_meta_data->>'country'), ''));
  if v_country !~ '^[A-Z]{2}$' then
    v_country := null;
  end if;

  insert into public.profiles (id, full_name, role, beta_tester, country, country_source)
  values (new.id, new.raw_user_meta_data->>'full_name',
          coalesce((new.raw_user_meta_data->>'role')::user_role, 'teacher'),
          true,  -- public beta: every new registration starts capped
          v_country,
          -- Never claim provenance we don't have: no country, no source.
          case when v_country is null then null else 'assumed' end)
  on conflict (id) do nothing;
  return new;
end $function$;
