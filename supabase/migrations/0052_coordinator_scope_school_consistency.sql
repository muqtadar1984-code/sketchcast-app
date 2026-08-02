-- Coordinator grants must follow the coordinator's CURRENT school
-- ============================================================================
-- Found by the 2026-07-17 timetable-v2 adversarial review: accepting an invite
-- to another school updates profiles.school_id but left the user's old
-- coordinator_scope rows behind, and every check that matches a scope row only
-- against the TARGET's school kept honouring them — a moved user retained
-- leadership READ (0009 policies, 0043 calendar) and timetable WRITE (0045
-- tt_coord_write) into the school they left.
--
-- Four layers, so no single writer can recreate the hole:
--   1. One-time cleanup of existing cross-school rows.
--   2. profiles trigger — changing school_id deletes grants that no longer
--      match (grants are per-school capabilities; they never travel).
--   3. coordinator_scope trigger — a row can only be written for the
--      coordinator's current school (guards every writer, incl. service role).
--   4. Hardened helpers (0009's coordinates_* and 0043's leader_of_school /
--      calendar_events_for): a scope row only counts while it matches the
--      holder's current profiles.school_id. Same signatures — every policy
--      that calls them picks the fix up automatically.
-- The app-side gates gained the same explicit .eq("school_id", ...) filter in
-- the matching app change, and the invite-accept route now deletes stale
-- grants itself (belt and braces if this migration lags the deploy).
--
-- Idempotent: safe to re-run.

-- 1. Cleanup: drop rows whose school no longer matches the holder's profile. --
delete from coordinator_scope cs
using profiles p
where p.id = cs.coordinator_id
  and (p.school_id is null or p.school_id <> cs.school_id);

-- 2. Moving schools revokes the old school's grants. -------------------------
create or replace function coordinator_scope_drop_on_school_change() returns trigger
  language plpgsql security definer set search_path = public as
$$
begin
  delete from coordinator_scope
  where coordinator_id = new.id
    and (new.school_id is null or school_id <> new.school_id);
  return new;
end;
$$;

drop trigger if exists profiles_drop_stale_coordinator_scope on profiles;
create trigger profiles_drop_stale_coordinator_scope
  after update of school_id on profiles
  for each row
  when (new.school_id is distinct from old.school_id)
  execute function coordinator_scope_drop_on_school_change();

-- 3. New/updated rows must match the coordinator's current school. -----------
create or replace function coordinator_scope_school_must_match() returns trigger
  language plpgsql security definer set search_path = public as
$$
begin
  if not exists (
    select 1 from profiles p
    where p.id = new.coordinator_id and p.school_id = new.school_id
  ) then
    raise exception 'coordinator_scope.school_id must match the coordinator''s current school';
  end if;
  return new;
end;
$$;

drop trigger if exists coordinator_scope_school_check on coordinator_scope;
create trigger coordinator_scope_school_check
  before insert or update of school_id, coordinator_id on coordinator_scope
  for each row
  execute function coordinator_scope_school_must_match();

-- 4a. 0009 helpers, hardened: the scope row must ALSO match the holder's -----
--     current profile school (join profiles me). Bodies otherwise unchanged.
create or replace function coordinates_class(cls uuid) returns boolean
  language sql stable security definer set search_path = public as
$$
  select exists (
    select 1 from classes c
    join coordinator_scope cs
      on  cs.coordinator_id = auth.uid()
      and cs.school_id = c.school_id
      and cs.grade = c.grade
    join profiles me
      on  me.id = auth.uid()
      and me.school_id = cs.school_id
    where c.id = cls
  )
$$;

create or replace function coordinates_student(stu uuid) returns boolean
  language sql stable security definer set search_path = public as
$$
  select exists (
    select 1 from enrollments e
    join classes c on c.id = e.class_id
    join coordinator_scope cs
      on  cs.coordinator_id = auth.uid()
      and cs.school_id = c.school_id
      and cs.grade = c.grade
    join profiles me
      on  me.id = auth.uid()
      and me.school_id = cs.school_id
    where e.student_id = stu
  )
$$;

create or replace function coordinates_generation(gen uuid) returns boolean
  language sql stable security definer set search_path = public as
$$
  select exists (
    select 1
    from generation_shares gs
    join classes c on c.id = gs.class_id
    join coordinator_scope cs
      on  cs.coordinator_id = auth.uid()
      and cs.school_id = c.school_id
      and cs.grade = c.grade
    join profiles me
      on  me.id = auth.uid()
      and me.school_id = cs.school_id
    left join generations g on g.id = gs.generation_id
    left join books b on b.id = g.book_id
    where gs.generation_id = gen
      and (cs.subject is null or cs.subject = b.subject)
  )
$$;

create or replace function coordinates_profile(pid uuid) returns boolean
  language sql stable security definer set search_path = public as
$$
  select coordinates_student(pid)
      or exists (
        select 1 from classes c
        join coordinator_scope cs
          on  cs.coordinator_id = auth.uid()
          and cs.school_id = c.school_id
          and cs.grade = c.grade
        join profiles me
          on  me.id = auth.uid()
          and me.school_id = cs.school_id
        where c.teacher_id = pid
      )
$$;

-- 4b. 0043 calendar checks, hardened the same way. ---------------------------
create or replace function leader_of_school(sid uuid) returns boolean
  language sql stable security definer set search_path = public as
$$ select exists (select 1 from profiles p where p.id = auth.uid() and p.school_id = sid and p.role = 'school_admin')
       or exists (select 1 from coordinator_scope cs
                  join profiles me on me.id = auth.uid() and me.school_id = cs.school_id
                  where cs.coordinator_id = auth.uid() and cs.school_id = sid); $$;

-- Feed resolver (token-authenticated, runs as service role with an explicit
-- uid) — the coordinator branches gain the same profile-school join.
create or replace function calendar_events_for(uid uuid)
returns setof school_events
language sql
stable
security definer
set search_path = public
as $$
  select ev.* from school_events ev
  where ev.starts_at > now() - interval '60 days'
    and ev.starts_at < now() + interval '400 days'
    and (
      (ev.audience = 'leadership' and (
         exists (select 1 from profiles p where p.id = uid and p.school_id = ev.school_id and p.role = 'school_admin')
         or exists (select 1 from coordinator_scope cs
                    join profiles cp on cp.id = cs.coordinator_id and cp.school_id = cs.school_id
                    where cs.coordinator_id = uid and cs.school_id = ev.school_id)))
      or (ev.audience = 'staff' and
         exists (select 1 from profiles p where p.id = uid and p.school_id = ev.school_id and p.role <> 'student'))
      or (ev.audience = 'school' and (
         exists (select 1 from profiles p where p.id = uid and p.school_id = ev.school_id)
         or exists (select 1 from parent_links pl join profiles ch on ch.id = pl.child_id
                    where pl.parent_id = uid and ch.school_id = ev.school_id)))
      or (ev.audience = 'class' and ev.class_id is not null and (
         exists (select 1 from classes c where c.id = ev.class_id and c.teacher_id = uid)
         or exists (select 1 from enrollments e where e.class_id = ev.class_id and e.student_id = uid)
         or exists (select 1 from profiles p where p.id = uid and p.school_id = ev.school_id and p.role = 'school_admin')
         or exists (select 1 from coordinator_scope cs
                    join profiles cp on cp.id = cs.coordinator_id and cp.school_id = cs.school_id
                    where cs.coordinator_id = uid and cs.school_id = ev.school_id)
         or exists (select 1 from parent_links pl join enrollments e on e.student_id = pl.child_id
                    where pl.parent_id = uid and e.class_id = ev.class_id)))
    )
  order by ev.starts_at;
$$;

-- create or replace preserves the ACL, but re-assert 0043's lockdown anyway
-- (PUBLIC must be in the list — see 0043's note).
revoke execute on function public.calendar_events_for(uuid) from public, anon, authenticated;
