-- 0018 — Parent portal core: parent↔child links, direct-to-child assignment,
-- parent read access, and parent-specific guards.
--
-- Parenthood is a GRANT (parent_links rows), like coordinator scopes — a
-- teacher can hold links without changing role. Parents are the first adults
-- that must NOT inherit the implicit-teacher surfaces; server-side that means
-- a kind trigger (test papers only) — the UI never being shown is not enough.
-- Links are written ONLY by the service role (invite accept, /api/children):
-- no client write path exists, so a parent can never self-grant access to a
-- minor. Requires 0017 (run alone) and 0016 (effective_cap). Idempotent.

-- ── Links ─────────────────────────────────────────────────────────────────────
create table if not exists public.parent_links (
  id          uuid primary key default gen_random_uuid(),
  parent_id   uuid not null references public.profiles(id) on delete cascade,
  child_id    uuid not null references public.profiles(id) on delete cascade,
  source      text not null default 'school' check (source in ('school','self')),
  created_by  uuid references public.profiles(id) on delete set null,
  verified_at timestamptz,   -- invite email matched the child's parent_email
  created_at  timestamptz not null default now(),
  unique (parent_id, child_id)
);
create index if not exists parent_links_parent_idx on public.parent_links (parent_id);
create index if not exists parent_links_child_idx  on public.parent_links (child_id);

-- Fires even on service-role inserts (triggers ignore RLS).
create or replace function enforce_parent_link_sanity() returns trigger
  language plpgsql security definer set search_path = public as
$$ begin
  if (select role from profiles where id = new.child_id) is distinct from 'student' then
    raise exception 'A child link must point at a student account.';
  end if;
  if (select role from profiles where id = new.parent_id) = 'student' then
    raise exception 'A student account cannot hold children.';
  end if;
  return new;
end $$;
drop trigger if exists parent_link_sanity on public.parent_links;
create trigger parent_link_sanity before insert or update on public.parent_links
  for each row execute function enforce_parent_link_sanity();

-- ── Helpers (SECURITY DEFINER — no policy recursion) ─────────────────────────
create or replace function is_parent_of(stu uuid) returns boolean
  language sql stable security definer set search_path = public as
$$ select exists (select 1 from parent_links
                  where parent_id = auth.uid() and child_id = stu) $$;

create or replace function parent_child_in_class(cls uuid) returns boolean
  language sql stable security definer set search_path = public as
$$ select exists (select 1 from parent_links pl
                  join enrollments e on e.student_id = pl.child_id
                  where pl.parent_id = auth.uid() and e.class_id = cls) $$;

create or replace function admin_school_student(stu uuid) returns boolean
  language sql stable security definer set search_path = public as
$$ select current_role_val() = 'school_admin'
      and exists (select 1 from profiles p
                  where p.id = stu and p.school_id = current_school_id()) $$;

-- ── Direct-to-child shares (generation_shares is class-based today) ──────────
alter table public.generation_shares add column if not exists
  student_id uuid references public.profiles(id) on delete cascade;
alter table public.generation_shares alter column class_id drop not null;
alter table public.generation_shares drop constraint if exists shares_one_target;
alter table public.generation_shares add constraint shares_one_target
  check (num_nonnulls(class_id, student_id) = 1);
-- unique(generation_id, class_id) treats NULL class_id as distinct → mirror:
create unique index if not exists shares_gen_student_uq
  on public.generation_shares (generation_id, student_id) where student_id is not null;
create index if not exists generation_shares_student_idx on public.generation_shares (student_id);

-- THE student read path — redefined to also match direct shares. For class
-- shares the left join keeps 0001's semantics identical.
create or replace function shared_to_me(gen uuid) returns boolean
  language sql stable security definer set search_path = public as
$$ select exists (
     select 1 from generation_shares gs
     left join enrollments e on e.class_id = gs.class_id
     where gs.generation_id = gen
       and (e.student_id = auth.uid() or gs.student_id = auth.uid())
   ) $$;

-- A generation is visible to a parent when it's shared to one of their
-- children (via class or directly). artifacts/jobs inherit via 0001's
-- subquery policies.
create or replace function shared_to_my_child(gen uuid) returns boolean
  language sql stable security definer set search_path = public as
$$ select exists (
     select 1 from generation_shares gs
     left join enrollments e on e.class_id = gs.class_id
     join parent_links pl on pl.parent_id = auth.uid()
      and (pl.child_id = e.student_id or pl.child_id = gs.student_id)
     where gs.generation_id = gen
   ) $$;

-- ── RLS: parent_links itself ──────────────────────────────────────────────────
alter table public.parent_links enable row level security;
-- NO insert/update/delete policies for authenticated: service-role writes only.
drop policy if exists pl_parent_read on public.parent_links;
create policy pl_parent_read on public.parent_links for select
  using (parent_id = auth.uid());
drop policy if exists pl_admin_read on public.parent_links;
create policy pl_admin_read on public.parent_links for select
  using (admin_school_student(child_id));

-- ── Additive parent READ policies: exactly their linked children ─────────────
drop policy if exists profiles_parent_read on public.profiles;
create policy profiles_parent_read on public.profiles for select
  using (is_parent_of(id));
drop policy if exists enroll_parent_read on public.enrollments;
create policy enroll_parent_read on public.enrollments for select
  using (is_parent_of(student_id));
drop policy if exists classes_parent_read on public.classes;
create policy classes_parent_read on public.classes for select
  using (parent_child_in_class(id));
drop policy if exists gen_parent_read on public.generations;
create policy gen_parent_read on public.generations for select
  using (shared_to_my_child(id));
drop policy if exists shares_parent_read on public.generation_shares;
create policy shares_parent_read on public.generation_shares for select
  using ((class_id is not null and parent_child_in_class(class_id))
      or (student_id is not null and is_parent_of(student_id)));
drop policy if exists sp_parent_read on public.student_progress;
create policy sp_parent_read on public.student_progress for select
  using (is_parent_of(student_id));
drop policy if exists sub_parent_read on public.submissions;
create policy sub_parent_read on public.submissions for select
  using (is_parent_of(student_id));

-- ── Share WRITE policies reworked (0001's shares_owner_all only checked
--    generation ownership — with student_id that would let any owner push
--    content at ANY student; tighten while extending) ──────────────────────────
drop policy if exists shares_owner_all on public.generation_shares;
drop policy if exists shares_owner_class_all on public.generation_shares;
create policy shares_owner_class_all on public.generation_shares for all
  using (class_id is not null
         and generation_id in (select id from generations where owner_id = auth.uid()))
  with check (class_id is not null
         and generation_id in (select id from generations where owner_id = auth.uid()));
drop policy if exists shares_direct_parent_all on public.generation_shares;
create policy shares_direct_parent_all on public.generation_shares for all
  using (student_id is not null and is_parent_of(student_id)
         and generation_id in (select id from generations where owner_id = auth.uid()))
  with check (student_id is not null and is_parent_of(student_id)
         and generation_id in (select id from generations where owner_id = auth.uid()));
-- Child reads shares aimed directly at them (mirror of shares_student_read):
drop policy if exists shares_child_read on public.generation_shares;
create policy shares_child_read on public.generation_shares for select
  using (student_id = auth.uid());

-- ── Parents generate TEST PAPERS only (server-side, not just hidden UI) ──────
create or replace function enforce_parent_generation_kind() returns trigger
  language plpgsql security definer set search_path = public as
$$ begin
  if (select role from profiles where id = new.owner_id) = 'parent'
     and new.kind is distinct from 'exam_paper' then
    raise exception 'Parent accounts can generate test papers only.';
  end if;
  return new;
end $$;
drop trigger if exists parent_generation_kind on public.generations;
create trigger parent_generation_kind before insert or update of kind, owner_id on public.generations
  for each row execute function enforce_parent_generation_kind();

-- ── Children cap, routed through the console's override system (0016) ────────
alter table public.profiles add column if not exists
  max_children int check (max_children is null or max_children >= 0);

create or replace function public.effective_cap(uid uuid, which text) returns int
  language sql stable security definer set search_path = public as
$$
  select coalesce(
    (select case which when 'books'    then max_books
                       when 'chapters' then max_chapters
                       when 'students' then max_students
                       when 'children' then max_children end
     from profiles where id = uid),
    case when is_beta_tester(uid)
         then case which when 'books' then 1 when 'chapters' then 1 else 2 end
         else 2147483647 end)
$$;

create or replace function enforce_beta_child_cap() returns trigger
  language plpgsql security definer set search_path = public as
$$
declare cap int;
begin
  cap := effective_cap(new.parent_id, 'children');
  if cap >= 2147483647 then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtext('beta_child:' || new.parent_id::text));
  if (select count(*) from parent_links
      where parent_id = new.parent_id and child_id <> new.child_id) >= cap then
    raise exception 'Beta is limited to % children.', cap;
  end if;
  return new;
end $$;
drop trigger if exists beta_child_cap on public.parent_links;
create trigger beta_child_cap before insert on public.parent_links
  for each row execute function enforce_beta_child_cap();

-- Suspension coverage for the new table (0015's pattern):
drop policy if exists parent_links_not_suspended on public.parent_links;
create policy parent_links_not_suspended on public.parent_links
  as restrictive for all using (not current_user_suspended());
