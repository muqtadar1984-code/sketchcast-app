-- 0038 — New-joiner profile onboarding: a blocking, one-time setup that captures
-- WHO a user is (Teacher / Parent) + their profile BEFORE they use the app, so no
-- one lands as a silently-defaulted teacher.
--
-- onboarded_at = the gate (NULL → forced through /onboarding, can't proceed until
-- the mandatory fields + a Teacher/Parent role are set). profile jsonb = the
-- flexible answers (adding a question is not a migration). role/full_name stay
-- real columns. Additive + idempotent.

alter table public.profiles add column if not exists onboarded_at timestamptz;
alter table public.profiles add column if not exists profile jsonb;

-- Backfill EXISTING users so only NEW signups see onboarding. The 5-minute guard
-- makes a re-run safe: a brand-new signup (created in the last few minutes) is not
-- swept in and force-onboarded away. Run this before enabling FEATURE_ONBOARDING.
update public.profiles
   set onboarded_at = now()
 where onboarded_at is null
   and created_at < now() - interval '5 minutes';
