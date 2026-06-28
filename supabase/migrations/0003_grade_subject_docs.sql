-- SketchCast AI — grade/subject grouping + multi-format generators
-- ----------------------------------------------------------------------------
-- * books.grade / books.subject: auto-detected by the worker's index step
--   (NOT a teacher input) — used to group the library Grade → Subject.
-- * generations.params: per-generation options (e.g. exam paper question mix).
-- Document generators (lesson_plan / activity / exam_paper) and student
-- assignment reuse existing enums + tables (generation_kind, artifact_kind=docx,
-- generation_shares, classes). Safe to run on the existing database.
-- ----------------------------------------------------------------------------

alter table books add column if not exists grade text;
alter table books add column if not exists subject text;

alter table generations add column if not exists params jsonb;
