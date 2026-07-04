-- 0015 — Account suspension + content takedown (platform console ops).
--
-- Suspension: profiles.suspended_at + RESTRICTIVE policies that AND with every
-- existing permissive policy — data access dies immediately even for a live
-- (~1h) access token; the auth-level ban (set by the ops API) blocks new
-- logins. profiles itself is EXEMPT so the app can still read the flag and
-- show an "account suspended" notice.
--
-- Takedown: soft-delete markers on books/generations. Removed rows vanish for
-- ALL school-side users (owner included) and are frozen (no update/delete), so
-- the owner cannot clear the marker or hard-delete the row. artifacts/jobs
-- inherit invisibility via 0001's RLS-filtered subquery policies. The service
-- role (console, worker) bypasses RLS and still sees everything.
--
-- 0010's column-level GRANT on profiles means suspended_at and the 0016 cap
-- columns are NOT client-writable — no extra revoke needed.
--
-- Behavior-preserving while no one is suspended/removed (all columns NULL).
-- Run as ONE execution. Idempotent.

alter table public.profiles    add column if not exists suspended_at timestamptz;
alter table public.books       add column if not exists removed_at   timestamptz;
alter table public.books       add column if not exists removed_by   uuid references public.profiles(id);
alter table public.generations add column if not exists removed_at   timestamptz;
alter table public.generations add column if not exists removed_by   uuid references public.profiles(id);

create or replace function public.current_user_suspended() returns boolean
  language sql stable security definer set search_path = public as
$$ select coalesce((select suspended_at is not null from profiles
                    where id = auth.uid()), false) $$;

-- ── Takedown: hide + freeze removed rows for authenticated users ─────────────
drop policy if exists books_not_removed on public.books;
create policy books_not_removed on public.books as restrictive for select
  using (removed_at is null);
drop policy if exists books_removed_frozen on public.books;
create policy books_removed_frozen on public.books as restrictive for update
  using (removed_at is null);
drop policy if exists books_removed_nodelete on public.books;
create policy books_removed_nodelete on public.books as restrictive for delete
  using (removed_at is null);

drop policy if exists gen_not_removed on public.generations;
create policy gen_not_removed on public.generations as restrictive for select
  using (removed_at is null);
drop policy if exists gen_removed_frozen on public.generations;
create policy gen_removed_frozen on public.generations as restrictive for update
  using (removed_at is null);
drop policy if exists gen_removed_nodelete on public.generations;
create policy gen_removed_nodelete on public.generations as restrictive for delete
  using (removed_at is null);

-- ── Suspension: cut data access on the hot tables ─────────────────────────────
-- (extend this list when new user-data tables land: attendance, parent_links…)
do $$
declare t text;
begin
  foreach t in array array['books','generations','classes','enrollments',
                           'generation_shares','student_progress','submissions',
                           'artifacts','jobs','artifact_views','beta_feedback',
                           'platform_issues']
  loop
    execute format('drop policy if exists %I on public.%I', t || '_not_suspended', t);
    execute format(
      'create policy %I on public.%I as restrictive for all using (not current_user_suspended())',
      t || '_not_suspended', t);
  end loop;
end $$;
