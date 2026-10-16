-- 0136: the catalogue's standard ONLINE QUIZ blueprint (catalogue Phase D part 2,
-- plan §5.4 "Online assessment"). Numbered 0136: 0135 is the question_bank kind.
--
-- One question_set_blueprints row, "Online quiz": ten OBJECTIVE items
-- (objective_ratio 1) with a difficulty PREFERENCE of 30/40/30 over 1/2/3 —
-- "fill": "nearest" tells the worker's composer (catalogue/composer.py
-- fill_mode) to top a short difficulty bucket up from the bank's nearest
-- difficulty instead of refusing, because this blueprint is composed
-- UNATTENDED when a kit is approved and the banks are small and skewed to
-- difficulty 1–3 (on 2026-10-16 the 51 current kits held 8–123 approved
-- objective items, median 15; an exact mix would have refused most of them).
-- Only a short MODE total (fewer than ten objective items) still refuses.
--
-- Per kit, the app's kit route composes ONE question_sets row from this
-- blueprint and ONE `worksheet` generation (params.question_set_id — the
-- composer's kind; no kit_id, by the worker's prepare() rule), listed in
-- topic_kits.doc_generation_ids under the key 'quiz'. The worker renders the
-- student DOCX, the answer key and questions_json (the quiz engine's marking
-- scheme, objective items only); a teacher adopts the piece
-- (adopt_catalogue_piece copies the artifacts rows, questions_json included)
-- and assigns it, and the student's attempt is graded server-side
-- (/api/quiz: key never leaves the server, three attempts).
--
-- Idempotent on the unique name; the spec is the app's QUIZ_BLUEPRINT_SPEC
-- (src/utils/catalogue/questions.ts) — change both together. Data only: no
-- schema change, nothing to roll back beyond deleting the row (no set has
-- referenced it until the backfill runs).
insert into public.question_set_blueprints (name, scope, spec, min_maturity)
values (
  'Online quiz',
  'worksheet',
  '{"preset":"quiz","objective_ratio":1,"difficulty_mix":{"1":0.3,"2":0.4,"3":0.3},"count":10,"total_marks":10,"fill":"nearest"}'::jsonb,
  'basic'
)
on conflict (name) do nothing;
