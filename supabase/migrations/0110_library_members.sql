-- 0110_library_members
--
-- Who may enter the SketchCast Library portal (library.sketchcast.app).
--
-- Founder decision 2026-09-06 (topic-catalogue plan §7.1): the portal has its
-- own sign-in, and "the console controls who has access to this page". Access
-- is MEMBERSHIP, deliberately not the e-mail domain, so an outside subject
-- reviewer can be let in without being made staff.
--
-- WHAT IT DOES
--   library_members — one row per account, mirroring platform_admins (0014):
--     role        'editor' | 'reviewer'. What each may do is decided in the app
--                 (src/utils/library-routing.ts, libraryAllows) from ONE role
--                 string, so the rule has one home. 'admin' is NOT a row here:
--                 a platform admin is a library admin implicitly (below).
--     revoked_at  soft revoke, like platform_admins — the audit trail keeps the
--                 row; is_library_member() ignores revoked rows.
--   library_role(uid) — the single answer the guards read:
--     'admin' for an unrevoked platform_admins row (0014), else the member's
--     role, else NULL. Admin wins over a stray member row so staff never lose
--     a permission by also being granted 'reviewer'.
--   is_library_member(uid) — library_role(uid) is not null.
--
-- ACCESS
--   RLS on, no policies, everything revoked from anon/authenticated: the table
--   is read and written by the service role only (the console's API route and
--   the portal's server components), exactly like platform_admins. The two
--   functions are SECURITY DEFINER and locked to the service role too — a
--   browser client must not be able to ask who the reviewers are.
--
-- WHAT IT DOES NOT DO
--   No rows are inserted. Sara, the catalogue system account and any outside
--   reviewer are granted from the console Users page ("Library access").
--   It touches no plan, cap or credit function: membership here grants the
--   PORTAL, not the product (that is the staff tier, 0109).
--
-- NOT APPLIED BY ANY AGENT. The founder applies prod schema changes.

begin;

create table if not exists public.library_members (
  user_id    uuid primary key references public.profiles(id) on delete cascade,
  role       text not null check (role in ('editor', 'reviewer')),
  granted_by uuid references public.profiles(id) on delete set null,
  note       text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_at timestamptz            -- soft revoke keeps audit continuity
);

comment on table public.library_members is
  '0110: who may enter library.sketchcast.app (the topic-catalogue portal). Membership, not domain; granted from the console. Platform admins are admins implicitly — see library_role().';

drop trigger if exists library_members_touch on public.library_members;
create trigger library_members_touch before update on public.library_members
  for each row execute function touch_updated_at();

alter table public.library_members enable row level security;
revoke all on public.library_members from anon, authenticated;

create or replace function public.library_role(uid uuid) returns text
  language sql stable security definer set search_path = public as
$$
  select coalesce(
    (select 'admin' where public.is_platform_admin(uid)),
    (select m.role from library_members m
      where m.user_id = uid and m.revoked_at is null))
$$;
revoke execute on function public.library_role(uuid) from public, anon, authenticated;
grant execute on function public.library_role(uuid) to service_role;

create or replace function public.is_library_member(uid uuid) returns boolean
  language sql stable security definer set search_path = public as
$$ select public.library_role(uid) is not null $$;
revoke execute on function public.is_library_member(uuid) from public, anon, authenticated;
grant execute on function public.is_library_member(uuid) to service_role;

commit;
