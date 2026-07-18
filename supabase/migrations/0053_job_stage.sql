-- 0053 — jobs.stage: the human-facing phase of a multi-part generation.
--
-- Multi-part lessons now generate PART-MAJOR (script → render → upload per
-- part), and the dashboard shows "Part 2/4 · 35%" instead of one opaque
-- percentage. The worker writes {"phase": "analysis"|"video", "part": k,
-- "total": n, "part_pct": p} at each checkpoint and clears it when all parts
-- are done. Presentation only — jobs.progress remains the source of truth,
-- and the worker's writer is best-effort (a missing column never fails a job).
--
-- Idempotent: safe to re-run.

alter table jobs add column if not exists stage jsonb;
