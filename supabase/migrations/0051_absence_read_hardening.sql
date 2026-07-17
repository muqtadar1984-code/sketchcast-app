-- 0051 — Absence privacy: staff absences (and their free-text reasons) are
-- adult business.
--
-- 0050 gave teacher_absences the same member-wide read as the timetable grid,
-- but member_of_school includes STUDENTS — and the reason column is exactly
-- where "surgery recovery" gets typed. Review finding (2026-07-17): any
-- student session could read every absence row via PostgREST. Students never
-- need absence rows: what they experience is the COVER, and
-- timetable_substitutions (which stays member-readable) carries no reason.
--
-- adult_of_school comes from 0043. Idempotent: safe to re-run.

drop policy if exists ta_member_read on teacher_absences;
create policy ta_member_read on teacher_absences for select
  using (adult_of_school(school_id));
