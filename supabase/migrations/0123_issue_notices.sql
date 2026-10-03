-- 0123_issue_notices
--
-- One email per owner, at the end. Until now every issue resolution mailed
-- the owner on the spot, from three places (the console's PATCH, the support
-- agent's self-heals, the worker's issue_resolve job). A teacher whose slide
-- deck failed three times, and who reported it once by hand, got four emails
-- about one fault inside three minutes (book 3318e1d1, 2026-10-02). The
-- founder's direction (2026-10-03): one email per user, a combined status
-- update once everything of theirs is resolved.
--
-- A resolution now queues a row here instead of sending; the worker's
-- housekeeping tick (sketchcast-ai support_agent/notices.py) sends each
-- owner one digest once none of their issues is still open and the queue
-- has gone quiet, or after a day at most. One notice per issue; sent_at
-- marks it delivered. Service role only: no policies, the console route and
-- the worker write it with their admin clients.

create table if not exists public.issue_notices (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  issue_id uuid not null references public.platform_issues(id) on delete cascade,
  what text not null default '',
  note text not null default '',
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create unique index if not exists issue_notices_issue_id_key on public.issue_notices (issue_id);
create index if not exists issue_notices_unsent_idx on public.issue_notices (owner_id) where sent_at is null;

alter table public.issue_notices enable row level security;
