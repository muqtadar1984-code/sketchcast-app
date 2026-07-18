-- 0056 — books.language: the book's detected language (six-language launch).
--
-- Set by the worker at indexing ($0 stopword/script heuristic; en/ms/ar/fr/
-- es/pt) and shown as a chip on the Library book row. It is the DEFAULT for
-- every generation: params.language (the teacher's explicit pick in the
-- generate dialogs) overrides it, else the worker narrates, authors and
-- voices the lesson in the book's own language — Arabic lessons additionally
-- render fully right-to-left. Existing books get their language on the next
-- re-index; unset means English (today's behaviour, unchanged).
--
-- Idempotent: safe to re-run.

alter table books add column if not exists language text;
