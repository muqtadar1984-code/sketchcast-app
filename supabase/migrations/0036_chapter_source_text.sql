-- 0036 — Cache scanned-book chapter OCR text so it is transcribed ONCE, not per generation.
--
-- A scanned book's chapter (no text layer) is transcribed by Claude vision at
-- generation time (worker process_generation). That result was in-memory only, so
-- EVERY generation of that chapter — lesson, worksheet, plan, exam, … and for
-- EVERY owner — re-ran the full multi-call vision OCR (~10 min + repeated API
-- cost each time). Cache it on chapter_grounding, which is already keyed
-- (book_id, chapter_num), service-role only, and shared across generations.
--
-- The worker's cache read/write is best-effort, so this column can be added at
-- any time (before OR after the worker deploy) without breaking generation.
-- Idempotent.

alter table public.chapter_grounding add column if not exists source_text text;
