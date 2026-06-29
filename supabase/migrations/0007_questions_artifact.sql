-- SketchCast AI — questions_json artifact kind (Phase C, interactive quizzes)
-- ----------------------------------------------------------------------------
-- The worker emits a structured questions.json alongside the worksheet/exam
-- .docx; it's stored as an artifact of this kind and powers the in-app quiz
-- player. Safe to run on the existing database.
-- ----------------------------------------------------------------------------

alter type artifact_kind add value if not exists 'questions_json';
