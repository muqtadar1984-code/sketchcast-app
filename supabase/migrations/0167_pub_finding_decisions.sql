-- 0167: findings triage and in-app approvals (R1, slice S4; founder 2026-10-28).
-- A member rules on a finding from books.sketchcast.app — accept, reject (with a
-- reason) or defer. The finding's status changes; every ruling is also kept,
-- append-only, so the corrections log can say who decided what, when and why.
--
-- Gate D approvals made in the app go into pub_approvals (0161), which is
-- already insert-only by trigger; nothing new is needed for them here.
--
-- Additive and idempotent. Same protection as 0161: RLS on, no policies,
-- nothing granted to anon or authenticated — only server routes (service role).

create table if not exists public.pub_finding_decisions (
  id           bigserial primary key,
  finding_id   bigint not null references public.pub_findings(id) on delete cascade,
  work_uid     text not null references public.pub_works(uid) on delete cascade,
  status_from  text not null,
  status_to    text not null,                 -- accepted|rejected|deferred|open
  reason       text,                          -- required for rejected (enforced below)
  decided_by   text not null,                 -- the member's email
  decided_at   timestamptz not null default now(),
  constraint pub_finding_decisions_reason check (status_to <> 'rejected' or length(trim(coalesce(reason, ''))) > 0)
);
create index if not exists pub_finding_decisions_finding_idx on public.pub_finding_decisions (finding_id, id);
create index if not exists pub_finding_decisions_work_idx on public.pub_finding_decisions (work_uid, decided_at desc);

-- a ruling is a record: never edited or removed (same rule as approvals)
drop trigger if exists pub_finding_decisions_immutable on public.pub_finding_decisions;
create trigger pub_finding_decisions_immutable before update or delete on public.pub_finding_decisions
  for each row execute function public.pub_refuse_change();

alter table public.pub_finding_decisions enable row level security;
revoke all on public.pub_finding_decisions from anon, authenticated;
revoke all on sequence public.pub_finding_decisions_id_seq from anon, authenticated;
