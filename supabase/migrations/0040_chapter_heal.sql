-- 0040 — Per-chapter self-heal override for mislabeled scanned books.
--
-- A scanned book can be indexed with the WRONG pages for a chapter (the vision
-- detector misread the printed contents-page numbers as physical pages, landing
-- e.g. "Unit 3: Computer storage" on the networking pages — a real, user-reported
-- failure). Index-time healing now fixes book.chapters for new/re-indexed books,
-- but books already stored wrong won't be re-indexed until a teacher re-uploads.
--
-- So the worker also self-heals at GENERATION time: when a chapter's pages don't
-- match its title, it finds the pages that DO, transcribes + strict-confirms them,
-- and records the correction here — a per-chapter override read BEFORE book.chapters
-- so the fix is paid once. heal_status:
--   'ok'        -> use heal_start_page..heal_end_page (+ the cached source_text)
--   'not_found' -> the topic isn't in this book; fail fast instead of re-searching
--
-- All columns live on chapter_grounding, already keyed (book_id, chapter_num),
-- service-role only, shared across generations. The worker's read/write is
-- best-effort, so this can be applied before OR after the worker deploy without
-- breaking generation. Idempotent.

alter table public.chapter_grounding add column if not exists heal_status     text;
alter table public.chapter_grounding add column if not exists heal_start_page  integer;
alter table public.chapter_grounding add column if not exists heal_end_page    integer;
