-- 0050 — Timetable v2: locks, non-teaching cells, absences + substitutions.
--
-- Four additions, one theme: make the generated grid survive real school life.
--
--   1. timetable_slots.locked — a pinned cell the auto-generator must never
--      touch (generate → hand-fix → regenerate without losing the fixes).
--   2. timetable_slots.kind — 'lesson' (default) or 'nonteaching' (assembly,
--      recess duty, free period). Non-teaching cells are EXEMPT from the
--      teacher-clash highlight and from the per-day teaching cap: a whole-
--      school assembly is not 12 double-bookings.
--   3. teacher_absences — the exception list. Everyone is assumed PRESENT
--      until a row lands here (marked by the principal or a coordinator).
--   4. timetable_substitutions — dated cover assignments computed when an
--      absence is marked (auto-picked, hand-editable). One row per covered
--      cell on one date; substitute NULL = "no cover found", which is a
--      staffing fact to show, not a row to hide.
--
-- Authorization model: reads are member-scoped RLS like the grid itself
-- (timetables aren't sensitive inside the school). WRITES to the two new
-- tables deliberately have NO RLS policies — they go through the app's
-- service-role API route, which verifies the caller is the school admin or a
-- coordinator-scope holder first. That keeps the substitution engine (a
-- multi-row compute-then-write) server-side and atomic-ish, same pattern as
-- the timetable generator.
--
-- Period shape additions (school hours, snack/lunch breaks, max lessons per
-- teacher per day) live in schools.config.timetable jsonb — no DDL needed.
--
-- Depends on 0045. Idempotent: safe to re-run.

alter table timetable_slots add column if not exists locked boolean not null default false;
alter table timetable_slots add column if not exists kind text not null default 'lesson';

-- Two known kinds; anything else is a typo we'd rather reject than render.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'timetable_slots_kind_ck') then
    alter table timetable_slots
      add constraint timetable_slots_kind_ck check (kind in ('lesson', 'nonteaching'));
  end if;
end $$;

-- ── Absences: the present-until-marked exception list ────────────────────────
create table if not exists teacher_absences (
  id         uuid primary key default gen_random_uuid(),
  school_id  uuid not null references schools(id) on delete cascade,
  teacher_id uuid not null references profiles(id) on delete cascade,
  on_date    date not null,
  reason     text,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
-- One absence row per teacher per day (re-marking upserts, never duplicates).
create unique index if not exists teacher_absences_uq on teacher_absences (teacher_id, on_date);
create index if not exists teacher_absences_school_date_idx on teacher_absences (school_id, on_date);

-- ── Substitutions: dated cover, one row per covered cell ─────────────────────
create table if not exists timetable_substitutions (
  id                    uuid primary key default gen_random_uuid(),
  school_id             uuid not null references schools(id) on delete cascade,
  absence_id            uuid not null references teacher_absences(id) on delete cascade,
  class_id              uuid not null references classes(id) on delete cascade,
  on_date               date not null,
  day                   smallint not null check (day between 1 and 7),
  period                smallint not null check (period between 1 and 12),
  subject               text not null,
  original_teacher_id   uuid references profiles(id) on delete set null,
  substitute_teacher_id uuid references profiles(id) on delete set null, -- NULL = no cover found
  created_at            timestamptz not null default now()
);
-- A class period on a given date has at most one substitution.
create unique index if not exists timetable_substitutions_cell_uq
  on timetable_substitutions (class_id, on_date, period);
create index if not exists timetable_substitutions_school_date_idx
  on timetable_substitutions (school_id, on_date);
create index if not exists timetable_substitutions_absence_idx
  on timetable_substitutions (absence_id);

alter table teacher_absences enable row level security;
alter table timetable_substitutions enable row level security;

-- Read: every member of the school (a teacher needs to see they're covering
-- 5 Amanah P3 today). Writes: none here on purpose — service-role API only.
drop policy if exists ta_member_read on teacher_absences;
create policy ta_member_read on teacher_absences for select
  using (member_of_school(school_id));

drop policy if exists ts_member_read on timetable_substitutions;
create policy ts_member_read on timetable_substitutions for select
  using (member_of_school(school_id));
