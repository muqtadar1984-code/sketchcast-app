-- 0045 — Timetable: the per-class period grid (Plan 3 Phase 1).
--
-- One row per filled cell: (class, day, period) → subject + teacher (+ room).
-- The DB enforces the hard invariant (a class can't hold two lessons in one
-- period — unique index); teacher double-booking across classes is deliberately
-- NOT a constraint (schools sometimes co-timetable) — the editor computes and
-- highlights those conflicts live instead.
--
-- Period/day SHAPE lives in schools.config.timetable (jsonb, no migration per
-- tweak): {"days": 5, "periods": [{"label": "P1", "time": "07:30"}, ...]} —
-- the app falls back to Mon–Fri × 8 periods when unset.
--
-- Who does what: every school member reads their school's timetable; the
-- school_admin edits all of it; a coordinator edits classes inside their grade
-- slice (coordinates_class, 0009). Published timetables become the anchor for
-- per-period attendance later.
--
-- Depends on 0009 (coordinates_class) — run migrations in order, as always.
-- Idempotent: safe to re-run.

create table if not exists timetable_slots (
  id         uuid primary key default gen_random_uuid(),
  school_id  uuid not null references schools(id) on delete cascade,
  class_id   uuid not null references classes(id) on delete cascade,
  day        smallint not null check (day between 1 and 7),        -- 1 = Monday
  period     smallint not null check (period between 1 and 12),
  subject    text not null,
  teacher_id uuid references profiles(id) on delete set null,
  room       text,
  created_by uuid references profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);
create unique index if not exists timetable_slots_cell_uq on timetable_slots (class_id, day, period);
create index if not exists timetable_slots_school_idx on timetable_slots (school_id);
create index if not exists timetable_slots_teacher_idx on timetable_slots (teacher_id);

drop trigger if exists timetable_slots_touch on timetable_slots;
create trigger timetable_slots_touch before update on timetable_slots
  for each row execute function touch_updated_at();

-- The slot's class must belong to the slot's school (cross-tenant guard, same
-- lesson as the calendar's class events).
create or replace function timetable_class_ok(cid uuid, sid uuid) returns boolean
  language sql stable security definer set search_path = public as
$$ select exists (select 1 from classes c where c.id = cid and c.school_id = sid); $$;

alter table timetable_slots enable row level security;

-- Read: every member of the school (timetables aren't sensitive; students and
-- teachers alike need theirs).
drop policy if exists tt_member_read on timetable_slots;
create policy tt_member_read on timetable_slots for select
  using (member_of_school(school_id));

-- Write: the school admin, anywhere in their school.
drop policy if exists tt_admin_write on timetable_slots;
create policy tt_admin_write on timetable_slots for all
  using (current_role_val() = 'school_admin' and school_id = current_school_id())
  with check (current_role_val() = 'school_admin' and school_id = current_school_id()
              and timetable_class_ok(class_id, school_id));

-- Write: coordinators, for classes inside their grade slice.
drop policy if exists tt_coord_write on timetable_slots;
create policy tt_coord_write on timetable_slots for all
  using (coordinates_class(class_id))
  with check (coordinates_class(class_id) and school_id = current_school_id()
              and timetable_class_ok(class_id, school_id));
