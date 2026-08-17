-- 0085 — profiles.country: where the user is, as an ISO 3166-1 alpha-2 code.
--
-- Until now the platform captured no country anywhere: profiles had no such
-- column and auth.users raw_user_meta_data carries only OAuth identity keys
-- (verified against prod 2026-08-17) — the console roster's Country column
-- rendered an honest dash on every row. This adds the column plus a provenance
-- tag, because a country we KNOW (the user picked it at signup) and a country
-- we GUESSED must never be indistinguishable in analytics or on the console:
--
--   country_source = 'signup'  — the user chose it on the blocking onboarding
--                                step (the same screen that confirms their role)
--   country_source = 'assumed' — inferred, not user-stated; the console renders
--                                these with a "≈ " prefix
--   country_source = 'staff'   — set by platform staff from the console ops panel
--
-- DDL + grants ONLY — deliberately NO backfill of any kind. Every existing row
-- stays NULL until the founder separately approves values; nothing in this file
-- writes data. Idempotent: safe to re-run.

alter table profiles add column if not exists country text;
alter table profiles add column if not exists country_source text;

comment on column profiles.country is
  'ISO 3166-1 alpha-2 country code (e.g. MY). NULL = never captured. Kept in step with src/utils/countries.ts.';
comment on column profiles.country_source is
  'Provenance of country: signup (user chose it at onboarding), assumed (inferred, shown with a "≈ " prefix), staff (set from the console ops panel). NULL when country is NULL.';

-- Shape, not vocabulary: the CHECK pins two uppercase ASCII letters so casing
-- and junk can never land, while the actual ISO list lives in
-- src/utils/countries.ts (client select + server validation) — a new ISO
-- assignment must not need a migration.
alter table profiles drop constraint if exists profiles_country_chk;
alter table profiles add constraint profiles_country_chk
  check (country is null or country ~ '^[A-Z]{2}$');

-- A closed vocabulary, like ui_locale's (0069): an unknown source would render
-- as plainly trusted on the console, which is exactly the confusion the column
-- exists to prevent. Every existing row is NULL, so it validates instantly.
alter table profiles drop constraint if exists profiles_country_source_chk;
alter table profiles add constraint profiles_country_source_chk
  check (country_source is null or country_source in ('signup', 'assumed', 'staff'));

-- 0010 revoked blanket UPDATE on profiles and re-granted only safe columns —
-- the posture every later per-user column (0055, 0064, 0066, 0068, 0069, 0070)
-- extended COLUMN-BY-COLUMN, never table-wide (a table-level grant would
-- reopen the role/school_id self-escalation hole 0010 closed). The onboarding
-- flow writes the user's own pick from their AUTHENTICATED session, so grant
-- exactly these two columns; the profiles_update_self row policy still
-- confines the write to their own row, and the CHECKs above confine the
-- values. Staff writes from the console go through the service role and need
-- no grant.
grant update (country, country_source) on public.profiles to authenticated;
