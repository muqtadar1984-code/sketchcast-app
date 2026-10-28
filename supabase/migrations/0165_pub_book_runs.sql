-- 0165: run books from the app (R1, slice S1; founder 2026-10-28).
-- A run is queued in pub_runs by books.sketchcast.app and executed by the
-- books runner (one AWS Fargate task per run). Book runs deliberately do NOT
-- use public.jobs: every production lane, the capacity checks and the console
-- count rows there, and a book run must never look like client work.
--
-- Additive and idempotent: new nullable columns on pub_runs / pub_artifacts /
-- pub_cost_lines, two new tables. Same protection as 0161: RLS on, no policies,
-- nothing granted to anon or authenticated — only server routes (service role)
-- and the runner read or write these tables.

-- ── pub_runs: what the app asks for, and what the runner reports ──────────────
alter table public.pub_runs add column if not exists trigger       text not null default 'import';  -- import|app|cli
alter table public.pub_runs add column if not exists params        jsonb not null default '{}';     -- the stage's own arguments
alter table public.pub_runs add column if not exists requested_by  text;          -- staff email (app) or host (cli)
alter table public.pub_runs add column if not exists estimate_usd  numeric(10,4); -- shown before Run; never a cap (D5)
alter table public.pub_runs add column if not exists progress      jsonb not null default '{}';     -- {step, chapter, note, pct}
alter table public.pub_runs add column if not exists claimed_at    timestamptz;
alter table public.pub_runs add column if not exists heartbeat_at  timestamptz;   -- the runner bumps this while alive
alter table public.pub_runs add column if not exists task_ref      text;          -- the Fargate task ARN (cancel / logs)
alter table public.pub_runs add column if not exists cancel_requested_at timestamptz;
alter table public.pub_runs add column if not exists error         text;

-- the runner claims a run by moving it out of 'queued'; the app lists a book's runs newest first
create index if not exists pub_runs_queue_idx on public.pub_runs (status, created_at) where status in ('queued', 'running');
create index if not exists pub_runs_work_created_idx on public.pub_runs (work_uid, created_at desc);

-- ── pub_run_steps: run × chapter × step, the checkpoint a resume starts from ──
create table if not exists public.pub_run_steps (
  id              bigserial primary key,
  run_id          bigint not null references public.pub_runs(id) on delete cascade,
  chapter         int,                         -- null for a whole-book step
  step            text not null,               -- e.g. draft|hero|render|packet|coverage
  status          text not null default 'pending',  -- pending|running|done|failed|skipped
  checkpoint_key  text,                        -- S3 key of the files this step left behind
  usd             numeric(10,4),
  started_at      timestamptz,
  finished_at     timestamptz,
  error           text,
  unique (run_id, chapter, step)
);

-- ── pub_run_events: append-only log the Runs page polls ───────────────────────
create table if not exists public.pub_run_events (
  id       bigserial primary key,
  run_id   bigint not null references public.pub_runs(id) on delete cascade,
  at       timestamptz not null default now(),
  level    text not null default 'info',       -- debug|info|warning|error
  kind     text not null default 'log',        -- log|progress|cost|guard|error
  message  text not null,
  data     jsonb
);
create index if not exists pub_run_events_run_idx on public.pub_run_events (run_id, id);

-- ── what a run produced and spent ─────────────────────────────────────────────
alter table public.pub_artifacts  add column if not exists run_id bigint references public.pub_runs(id) on delete set null;
alter table public.pub_cost_lines add column if not exists run_id bigint references public.pub_runs(id) on delete set null;
create index if not exists pub_artifacts_run_idx  on public.pub_artifacts  (run_id) where run_id is not null;
create index if not exists pub_cost_lines_run_idx on public.pub_cost_lines (run_id) where run_id is not null;

-- ── protection (as 0161) ──────────────────────────────────────────────────────
alter table public.pub_run_steps  enable row level security;
alter table public.pub_run_events enable row level security;
revoke all on public.pub_run_steps  from anon, authenticated;
revoke all on public.pub_run_events from anon, authenticated;
revoke all on sequence public.pub_run_steps_id_seq  from anon, authenticated;
revoke all on sequence public.pub_run_events_id_seq from anon, authenticated;
