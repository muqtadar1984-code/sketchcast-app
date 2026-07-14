-- 0042 — School as a first-class tenant workspace: slug + config + branding.
--
-- Until now `schools` was little more than (id, name): tenancy is enforced by
-- profiles.school_id + RLS, but a school had no ADDRESS (nothing to put in a URL)
-- and no per-tenant knobs. This migration gives each school:
--
--   slug         — the URL-safe tenant address (school.sketchcast.app/{slug}/…).
--                  Lowercase [a-z0-9-], unique. A BEFORE INSERT trigger derives it
--                  from `name` when omitted, so every existing insert path (e.g.
--                  /api/school-finish) keeps working and every school is
--                  portal-addressable automatically. NOT NULL after backfill.
--   display_name — what the portal shows (falls back to `name` when null).
--   config       — per-tenant behaviour overrides (jsonb, e.g.
--                  {"school_analytics": true} lights the leadership suite for ONE
--                  tenant without flipping the global env flag for everyone).
--   branding     — per-tenant look (jsonb; logo/colors), portal-side only.
--   status       — soft lifecycle: 'active' | 'archived'. Archived schools stop
--                  resolving via school_by_slug (their data is untouched).
--
-- Tenant resolution: school_by_slug(slug) is SECURITY DEFINER because the portal
-- must resolve a slug BEFORE anyone is signed in (the login page itself), and
-- schools_read (0001) only lets members read their own school. The function
-- returns only the school's id/display/branding surface — a uuid grants nothing
-- under RLS, so this leaks no tenant data. Existing RLS is NOT relaxed:
-- per-school isolation stays keyed on school_id everywhere.
--
-- Idempotent: safe to re-run.

-- ── Columns ──────────────────────────────────────────────────────────────────
alter table public.schools add column if not exists slug         text;
alter table public.schools add column if not exists display_name text;
alter table public.schools add column if not exists config       jsonb not null default '{}'::jsonb;
alter table public.schools add column if not exists branding     jsonb;
alter table public.schools add column if not exists status       text not null default 'active';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'schools_status_chk') then
    alter table public.schools
      add constraint schools_status_chk check (status in ('active', 'archived'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'schools_slug_chk') then
    alter table public.schools
      add constraint schools_slug_chk check (slug ~ '^[a-z0-9][a-z0-9-]*$');
  end if;
end $$;

create unique index if not exists schools_slug_uq on public.schools (slug);

-- ── Slug derivation (shared by the backfill and the insert trigger) ──────────
-- "Demo Primary School" -> "demo-primary-school"; empty/garbage -> "school".
create or replace function public.school_slugify(p_name text)
returns text
language sql
immutable
set search_path = public
as $$
  select coalesce(
    nullif(
      trim(both '-' from regexp_replace(lower(coalesce(p_name, '')), '[^a-z0-9]+', '-', 'g')),
      ''),
    'school');
$$;

-- Derive a UNIQUE slug when an insert omits one (base, base-2, base-3, …) so no
-- existing insert path breaks and NOT NULL can hold.
create or replace function public.set_school_slug()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  base text;
  candidate text;
  n int := 1;
begin
  if new.slug is not null and new.slug <> '' then
    new.slug := lower(new.slug);
    return new;
  end if;
  base := school_slugify(new.name);
  candidate := base;
  while exists (select 1 from schools where slug = candidate) loop
    n := n + 1;
    candidate := base || '-' || n;
  end loop;
  new.slug := candidate;
  return new;
end;
$$;

drop trigger if exists schools_set_slug on public.schools;
create trigger schools_set_slug before insert on public.schools
  for each row execute function public.set_school_slug();

-- ── Backfill existing rows, then lock the column ─────────────────────────────
do $$
declare
  r record;
  base text;
  candidate text;
  n int;
begin
  for r in select id, name from public.schools where slug is null order by created_at loop
    base := school_slugify(r.name);
    candidate := base;
    n := 1;
    while exists (select 1 from public.schools where slug = candidate and id <> r.id) loop
      n := n + 1;
      candidate := base || '-' || n;
    end loop;
    update public.schools set slug = candidate where id = r.id;
  end loop;
end $$;

alter table public.schools alter column slug set not null;

-- ── Tenant resolution for the portal (pre-auth) ──────────────────────────────
-- SECURITY DEFINER: the login/landing page must resolve slug -> school before a
-- session exists. Archived schools intentionally do not resolve.
create or replace function public.school_by_slug(p_slug text)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from schools where slug = lower(trim(p_slug)) and status = 'active';
$$;

grant execute on function public.school_by_slug(text) to anon, authenticated;
grant execute on function public.school_slugify(text) to anon, authenticated;
