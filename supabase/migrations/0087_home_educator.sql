-- 0087 — profiles.home_educator: is this parent a HOME EDUCATOR (homeschooling
-- or tutoring) rather than a school-supporting parent?
--
-- The homeschool release forks the parent onboarding: "Supporting school
-- learning" (the existing world — paper-first, children linked to a school)
-- vs "Homeschooling or tutoring". The latter sets this flag, and the flag
-- alone decides which surface is HOME for the account: a home educator lands
-- on the full dashboard Library (teacher-style authoring) instead of the
-- children page. Pure routing/presentation — it grants no capability parents
-- don't already hold (parents are full authors since 0035), so a wrong value
-- can misplace a landing, never widen access.
--
-- Existing parents are NEVER re-prompted: the onboarding gate only fires while
-- onboarded_at IS NULL, so every existing row simply keeps the default false.
--
-- DDL + grant ONLY, no backfill. Idempotent: safe to re-run.

alter table profiles add column if not exists home_educator boolean not null default false;

comment on column profiles.home_educator is
  'Parent onboarding purpose: true = homeschooling or tutoring (home surface is the full Library), false = supporting school learning (default). Set once at onboarding; display/routing only, never a permission.';

-- Same posture as country/country_source (0085): 0010 revoked blanket UPDATE
-- on profiles and every later per-user column is re-granted COLUMN-BY-COLUMN,
-- never table-wide. The onboarding flow writes the user's own answer from
-- their AUTHENTICATED session; the profiles_update_self row policy confines
-- the write to their own row, and boolean not null confines the values.
grant update (home_educator) on public.profiles to authenticated;
