-- 0039 — Autofix: the automated bug-fix pipeline's run ledger.
--
-- One row per "attempt auto-fix" a staff member fires on a reported issue. Tracks
-- the GitHub branch/PR, whether CI passed, and the founder's email decision. The
-- row is the single source of truth the Approve/Reject signed links act on (its
-- decided_at column enforces single-use). Service-role only — like platform_issues,
-- all writes go through the app's admin client; reporters never see these.

create table if not exists public.autofix_runs (
  id            uuid primary key default gen_random_uuid(),
  issue_id      uuid not null references public.platform_issues(id) on delete cascade,
  repo          text not null default 'sketchcast-app',
  run_key       text not null unique,            -- correlation id passed to the GitHub Action
  branch        text,
  pr_number     int,
  pr_url        text,
  status        text not null default 'dispatched'
                  check (status in ('dispatched','pr_open','ci_failed','approved','merged','rejected','error')),
  ci_passed     boolean,
  sensitive     boolean not null default false,  -- diff touches auth/billing/migrations/etc.
  summary       text,
  files_changed jsonb,
  error         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  decided_at    timestamptz,                     -- set once → the link is single-use
  decided_via   text
);

create index if not exists autofix_runs_issue_idx on public.autofix_runs (issue_id);
create index if not exists autofix_runs_status_idx on public.autofix_runs (status);

alter table public.autofix_runs enable row level security; -- no policies → service-role only
revoke all on public.autofix_runs from anon, authenticated;

-- keep updated_at fresh (same trigger fn the console tables use, defined in 0014)
drop trigger if exists autofix_runs_touch on public.autofix_runs;
create trigger autofix_runs_touch before update on public.autofix_runs
  for each row execute function public.touch_updated_at();
