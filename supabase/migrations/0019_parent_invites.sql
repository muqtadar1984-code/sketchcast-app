-- 0019 — Parent invites: school admins invite a parent mapped to their
-- child(ren). Requires 0017 (enum) + 0018 (parent_links). Idempotent.

-- 0010 constrained invite roles to school_admin/teacher — widen for parents.
alter table public.invites drop constraint if exists invites_adult_role;
alter table public.invites add constraint invites_adult_role
  check (role in ('school_admin', 'teacher', 'parent'));

-- Child mapping for a parent invite (siblings = several rows).
create table if not exists public.invite_children (
  id         uuid primary key default gen_random_uuid(),
  invite_id  uuid not null references public.invites(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (invite_id, student_id)
);
alter table public.invite_children enable row level security;
-- The invites subquery runs under the caller's RLS (invites_admin_all scopes
-- it to the admin's own school) → admins manage exactly their own mappings.
drop policy if exists ic_admin_all on public.invite_children;
create policy ic_admin_all on public.invite_children for all
  using (invite_id in (select id from invites))
  with check (invite_id in (select id from invites));

drop policy if exists invite_children_not_suspended on public.invite_children;
create policy invite_children_not_suspended on public.invite_children
  as restrictive for all using (not current_user_suspended());
