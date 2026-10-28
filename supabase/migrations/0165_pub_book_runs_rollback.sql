-- Rollback for 0165_pub_book_runs.sql. Drops the run log and steps, and the
-- columns 0165 added. Imported runs (trigger = 'import') keep their rows.
drop table if exists public.pub_run_events;
drop table if exists public.pub_run_steps;
drop index if exists public.pub_artifacts_run_idx;
drop index if exists public.pub_cost_lines_run_idx;
alter table public.pub_artifacts  drop column if exists run_id;
alter table public.pub_cost_lines drop column if exists run_id;
drop index if exists public.pub_runs_queue_idx;
drop index if exists public.pub_runs_work_created_idx;
alter table public.pub_runs
  drop column if exists trigger,
  drop column if exists params,
  drop column if exists requested_by,
  drop column if exists estimate_usd,
  drop column if exists progress,
  drop column if exists claimed_at,
  drop column if exists heartbeat_at,
  drop column if exists task_ref,
  drop column if exists cancel_requested_at,
  drop column if exists error;
