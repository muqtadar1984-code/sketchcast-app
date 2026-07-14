-- 0043 — School calendar: events + ICS feed tokens.
--
-- One shared calendar per school (meetings, exams, holidays, activities, PD),
-- audience-scoped so each role sees exactly its slice, plus per-user feed
-- tokens so the calendar can be SUBSCRIBED to from Google/Outlook/Apple via a
-- plain ICS URL — the "easily linked to the school's calendar system" story
-- without OAuth. External calendars will flow IN the same way later (the
-- worker polls the school's ICS address and upserts rows with source='ics');
-- this migration already reserves source/external_uid for that.
--
-- Audience model (who can SEE an event):
--   'leadership' — school_admin + coordinator-scope holders of the school
--   'staff'      — every adult of the school
--   'school'     — every member of the school (students too) + parents of its
--                  students (parents carry no school_id — they belong via
--                  parent_links, same as everywhere else)
--   'class'      — the class's teacher + enrolled students + their parents +
--                  school leadership
-- Writes: school_admin manages any native event in their school; a teacher
-- manages 'class' events for classes they own. source='ics' rows are
-- read-only to users (only the service-role sync may touch them).
--
-- Idempotent: safe to re-run.

-- ── Events ────────────────────────────────────────────────────────────────────
create table if not exists school_events (
  id           uuid primary key default gen_random_uuid(),
  school_id    uuid not null references schools(id) on delete cascade,
  class_id     uuid references classes(id) on delete cascade,
  title        text not null,
  description  text,
  location     text,
  kind         text not null default 'other'
               check (kind in ('meeting', 'exam', 'holiday', 'activity', 'pd', 'other')),
  audience     text not null default 'staff'
               check (audience in ('leadership', 'staff', 'school', 'class')),
  starts_at    timestamptz not null,
  ends_at      timestamptz,
  all_day      boolean not null default false,
  source       text not null default 'native' check (source in ('native', 'ics')),
  external_uid text,               -- dedupe key for ICS-synced rows
  created_by   uuid references profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check (audience <> 'class' or class_id is not null),
  check (ends_at is null or ends_at >= starts_at)
);
create index if not exists school_events_school_time_idx on school_events (school_id, starts_at);
create unique index if not exists school_events_ics_uid_uq
  on school_events (school_id, external_uid) where external_uid is not null;

drop trigger if exists school_events_touch on school_events;
create trigger school_events_touch before update on school_events
  for each row execute function touch_updated_at();

-- ── Visibility helpers (SECURITY DEFINER — no RLS recursion) ─────────────────
create or replace function adult_of_school(sid uuid) returns boolean
  language sql stable security definer set search_path = public as
$$ select exists (select 1 from profiles p where p.id = auth.uid() and p.school_id = sid and p.role <> 'student'); $$;

create or replace function member_of_school(sid uuid) returns boolean
  language sql stable security definer set search_path = public as
$$ select exists (select 1 from profiles p where p.id = auth.uid() and p.school_id = sid); $$;

create or replace function parent_of_school(sid uuid) returns boolean
  language sql stable security definer set search_path = public as
$$ select exists (select 1 from parent_links pl join profiles ch on ch.id = pl.child_id
                  where pl.parent_id = auth.uid() and ch.school_id = sid); $$;

create or replace function parent_of_class(cid uuid) returns boolean
  language sql stable security definer set search_path = public as
$$ select exists (select 1 from parent_links pl join enrollments e on e.student_id = pl.child_id
                  where pl.parent_id = auth.uid() and e.class_id = cid); $$;

create or replace function leader_of_school(sid uuid) returns boolean
  language sql stable security definer set search_path = public as
$$ select exists (select 1 from profiles p where p.id = auth.uid() and p.school_id = sid and p.role = 'school_admin')
       or exists (select 1 from coordinator_scope cs where cs.coordinator_id = auth.uid() and cs.school_id = sid); $$;

-- Parents belong to schools through their children (no school_id of their own),
-- so schools_read (0001: id = current_school_id()) never matches for them. Let
-- them READ the school rows of their children's schools — needed for the
-- per-tenant config checks (calendar/analytics flags) and display names.
drop policy if exists schools_parent_read on schools;
create policy schools_parent_read on schools for select using (parent_of_school(id));

-- ── RLS ───────────────────────────────────────────────────────────────────────
alter table school_events enable row level security;

drop policy if exists se_read on school_events;
create policy se_read on school_events for select using (
  case audience
    when 'leadership' then leader_of_school(school_id)
    when 'staff'      then adult_of_school(school_id)
    when 'school'     then member_of_school(school_id) or parent_of_school(school_id)
    else class_id is not null and (
      owns_class(class_id) or enrolled_in_class(class_id)
      or leader_of_school(school_id) or parent_of_class(class_id)
    )
  end
);

-- A class event's class must belong to the event's school — without this, an
-- admin (or drifted teacher) could attach an event to ANOTHER school's class,
-- and se_read's class branch (keyed on class_id alone) would show it to that
-- school's students/parents: cross-tenant event injection.
create or replace function class_in_school(cid uuid, sid uuid) returns boolean
  language sql stable security definer set search_path = public as
$$ select exists (select 1 from classes c where c.id = cid and c.school_id = sid); $$;

-- School admin: full control of their school's NATIVE events (ICS rows are the
-- sync's — read-only to everyone but the service role).
drop policy if exists se_admin_write on school_events;
create policy se_admin_write on school_events for all
  using (current_role_val() = 'school_admin' and school_id = current_school_id() and source = 'native')
  with check (current_role_val() = 'school_admin' and school_id = current_school_id() and source = 'native'
              and (class_id is null or class_in_school(class_id, school_id)));

-- Teachers: 'class' events for classes they own.
drop policy if exists se_teacher_write on school_events;
create policy se_teacher_write on school_events for all
  using (source = 'native' and audience = 'class' and class_id is not null and owns_class(class_id))
  with check (source = 'native' and audience = 'class' and class_id is not null
              and owns_class(class_id) and school_id = current_school_id()
              and class_in_school(class_id, school_id));

-- ── ICS feed tokens (subscribe-by-URL from Google/Outlook/Apple) ─────────────
-- One token per user; DELETE + re-INSERT rotates it (old URL dies instantly).
create table if not exists calendar_feed_tokens (
  user_id    uuid primary key references profiles(id) on delete cascade,
  token      text unique not null default encode(gen_random_bytes(24), 'hex'),
  created_at timestamptz not null default now()
);
alter table calendar_feed_tokens enable row level security;
drop policy if exists cft_self_all on calendar_feed_tokens;
create policy cft_self_all on calendar_feed_tokens for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ── Feed resolver — the ONE source of truth for "what can this user see",
-- callable without a session (the feed URL is opened by Google's servers).
-- Mirrors se_read exactly; keep the two in sync when audiences change.
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
         or exists (select 1 from coordinator_scope cs where cs.coordinator_id = uid and cs.school_id = ev.school_id)))
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
         or exists (select 1 from coordinator_scope cs where cs.coordinator_id = uid and cs.school_id = ev.school_id)
         or exists (select 1 from parent_links pl join enrollments e on e.student_id = pl.child_id
                    where pl.parent_id = uid and e.class_id = ev.class_id)))
    )
  order by ev.starts_at;
$$;

-- The feed route runs with the service role after resolving the token; users
-- never call this directly. PUBLIC must be in the revoke: Postgres grants
-- EXECUTE on every new function to PUBLIC implicitly, and anon/authenticated
-- INHERIT that grant — revoking only those two roles is a no-op, leaving a
-- definer function that takes an arbitrary uid callable by anyone holding the
-- anon key via /rest/v1/rpc (the exact hole 0044 closes for the tutor RPCs).
revoke execute on function public.calendar_events_for(uuid) from public, anon, authenticated;
