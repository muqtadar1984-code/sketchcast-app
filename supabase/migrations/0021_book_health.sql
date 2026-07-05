-- 0021 — Book Health Score. The worker computes a predictive quality read at
-- index time (from text-layer coverage, scanned-ness, chapter-detection
-- plausibility, page count) and stores it here so teachers see it the moment a
-- book finishes indexing — catching bad scans before they generate failed
-- lessons. Additive + inert until the worker release ships. One execution.

alter table public.books add column if not exists health jsonb;

comment on column public.books.health is
  'Book Health Score: {score, band, dimensions{text_layer,structure}, facts, problems[], recommendation, note}';
