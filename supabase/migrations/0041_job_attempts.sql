-- 0041 — Attempt counter for the worker's stale-job reaper.
--
-- The worker requeues jobs left stranded in 'processing' by a restart (deploy /
-- crash / OOM). Without a bound, a "poison pill" job that reliably hard-crashes
-- the worker would loop forever: crash → restart → reap → reclaim → crash …,
-- blocking every other queued job. `attempts` lets the reaper give up: past a
-- threshold it marks the job 'error' (and index_book books 'error') instead of
-- requeuing. Additive + idempotent; the worker's read/write is best-effort.

alter table public.jobs add column if not exists attempts int not null default 0;
