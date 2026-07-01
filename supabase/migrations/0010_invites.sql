-- SketchCast AI — admin/teacher invites + close a self-escalation hole
-- ============================================================================
-- Elevated roles are GRANTED, never self-claimed. A school_admin invites a
-- colleague by email as `school_admin` or `teacher` (NEVER student); accepting
-- the invite (server-side, service role, email must match) sets their role +
-- school. See src/app/invite/* and src/app/api-less accept route.
--
-- SECURITY FIX (important): the 0001 `profiles_update_self` policy lets a user
-- UPDATE their own row with no column restriction — so any teacher could set
-- their own `role` to 'school_admin'. RLS can't limit columns, so we use
-- column-level GRANTs: authenticated may edit only safe profile fields; `role`
-- and `school_id` are settable ONLY by the service role (invite accept / the
-- existing admin coordinator actions). Without this, invites would be theatre.
-- Safe to run on the existing database.
-- ============================================================================

create table if not exists invites (
  id          uuid primary key default gen_random_uuid(),
  email       text not null,
  role        user_role not null,
  school_id   uuid references schools(id) on delete cascade,
  token       text unique not null default encode(gen_random_bytes(16), 'hex'),
  invited_by  uuid references profiles(id) on delete set null,
  accepted_at timestamptz,
  expires_at  timestamptz not null default (now() + interval '14 days'),
  created_at  timestamptz not null default now(),
  constraint invites_adult_role check (role in ('school_admin', 'teacher'))
);
create index if not exists invites_email_idx on invites (lower(email));
create index if not exists invites_school_idx on invites (school_id);

alter table invites enable row level security;

-- A school_admin manages invites for their own school. The invitee never reads
-- the table directly — the /invite page + accept route use the service role.
drop policy if exists invites_admin_all on invites;
create policy invites_admin_all on invites for all
  using (current_role_val() = 'school_admin' and school_id = current_school_id())
  with check (current_role_val() = 'school_admin' and school_id = current_school_id());

-- ── Close the self-escalation hole ──────────────────────────────────────────
-- Authenticated users may update only these safe columns of their own profile.
-- role + school_id are NOT grantable to them → only the service role can change
-- them (invite accept, /api/coordinators). Combined with the existing
-- profiles_update_self RLS (own row) this is safe.
revoke update on public.profiles from authenticated;
grant update (full_name, username, parent_email, must_reset_password)
  on public.profiles to authenticated;
