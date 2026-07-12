-- 0037 — Onboarding product tour: per-user versioned seen-state + analytics.
--
-- user_tour_progress: one row per (user, tour) recording the version they last
-- completed/skipped. The client auto-starts only when there is no row or the
-- stored version is OLDER than the definition's — so bumping a tour's `version`
-- re-shows it to everyone. RLS-scoped: a user sees/writes only their own rows.
--
-- tour_events: the analytics sink (the app logs product events to Postgres; there
-- is no analytics SDK). Users insert their own events; reads are staff-only
-- (console analytics), never exposed to other users.
--
-- Additive + idempotent.

create table if not exists public.user_tour_progress (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  tour_key   text not null,
  version    int  not null,
  status     text not null check (status in ('completed', 'skipped')),
  updated_at timestamptz not null default now(),
  primary key (user_id, tour_key)
);
alter table public.user_tour_progress enable row level security;
drop policy if exists utp_self_read on public.user_tour_progress;
create policy utp_self_read on public.user_tour_progress
  for select using (user_id = auth.uid());
drop policy if exists utp_self_insert on public.user_tour_progress;
create policy utp_self_insert on public.user_tour_progress
  for insert with check (user_id = auth.uid());
drop policy if exists utp_self_update on public.user_tour_progress;
create policy utp_self_update on public.user_tour_progress
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

create table if not exists public.tour_events (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  role       text,
  tour_key   text not null,
  version    int  not null,
  event      text not null,
  meta       jsonb,
  created_at timestamptz not null default now()
);
create index if not exists tour_events_lookup on public.tour_events (tour_key, version, event);
alter table public.tour_events enable row level security;
drop policy if exists tour_events_self_insert on public.tour_events;
create policy tour_events_self_insert on public.tour_events
  for insert with check (user_id = auth.uid());
-- No SELECT policy for authenticated: drop-off analytics are read with the
-- service role (console), never cross-user.
revoke select on public.tour_events from anon, authenticated;
