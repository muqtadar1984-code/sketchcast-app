-- 0119 — the life-to-date figure for the Traffic page.
--
-- WHY. "How many visitors did we have so far?" (founder, 2026-09-21). The
-- console tiles in 0118 stop at 30 days, and prune_site_visits DELETES old
-- rows, so nothing could ever answer that question once the firehose was
-- trimmed. An advertiser hears one number first — the total — so it has to
-- survive retention.
--
-- HOW.
--   * site_visits_archive — one row per (day, host) with that day's visit
--     and visitor counts, written ONLY by prune_site_visits as it deletes
--     the raw rows. Whole UTC days at a time, so a day's unique visitors
--     are counted once (the visitor hash rotates daily, so uniqueness never
--     spans a day boundary anyway).
--   * site_visits_lifetime(p_hosts) — raw rows + archive, in one call:
--     the first day we counted, visits, and visitors. "Visitors" is the sum
--     of DAILY uniques, the same unit as every other figure on the page —
--     a person who comes back tomorrow counts again, by design (no
--     cross-day identity exists to dedupe on).
--   * prune_site_visits(p_days) is REPLACED: same signature, same result,
--     but it folds each pruned day into the archive before deleting, and
--     cuts at a UTC day boundary rather than "now minus N days" so a day is
--     never archived in two halves.
--
-- Idempotent; safe to re-run. Nothing here is readable by a signed-in user:
-- RLS on with no policies, client grants revoked, service role only.

create table if not exists public.site_visits_archive (
  day       date   not null,
  host      text   not null,
  visits    bigint not null,
  visitors  bigint not null,
  primary key (day, host)
);
alter table public.site_visits_archive enable row level security;
revoke all on public.site_visits_archive from public, anon, authenticated;
comment on table public.site_visits_archive is
  'Daily visit/visitor counts per host for days pruned out of site_visits (0119). Written by prune_site_visits; read by site_visits_lifetime.';

create or replace function public.site_visits_lifetime(p_hosts text[] default null)
returns table (first_day date, visits bigint, visitors bigint)
language sql stable security definer set search_path = public as $$
  with live as (
    select min((at at time zone 'UTC')::date) as first_day,
           count(*)::bigint as visits, count(distinct visitor)::bigint as visitors
      from public.site_visits
     where p_hosts is null or host = any(p_hosts)
  ), archived as (
    select min(day) as first_day,
           coalesce(sum(visits), 0)::bigint as visits, coalesce(sum(visitors), 0)::bigint as visitors
      from public.site_visits_archive
     where p_hosts is null or host = any(p_hosts)
  )
  -- least() skips nulls, so an empty side does not hide the other's date.
  select least(live.first_day, archived.first_day),
         live.visits + archived.visits,
         live.visitors + archived.visitors
    from live, archived
$$;

create or replace function public.prune_site_visits(p_days int default 400)
returns bigint
language plpgsql security definer set search_path = public as $$
declare
  n      bigint;
  cutoff timestamptz := ((now() at time zone 'UTC')::date - greatest(30, p_days))::timestamp at time zone 'UTC';
begin
  -- Fold the days about to go into the archive first — whole UTC days only.
  insert into public.site_visits_archive (day, host, visits, visitors)
  select (at at time zone 'UTC')::date, host, count(*), count(distinct visitor)
    from public.site_visits
   where at < cutoff
   group by 1, 2
  on conflict (day, host) do update
    set visits   = site_visits_archive.visits   + excluded.visits,
        visitors = site_visits_archive.visitors + excluded.visitors;

  delete from public.site_visits where at < cutoff;
  get diagnostics n = row_count;
  return n;
end $$;

revoke execute on function public.site_visits_lifetime(text[]) from public, anon, authenticated;
grant  execute on function public.site_visits_lifetime(text[]) to service_role;
revoke execute on function public.prune_site_visits(int)       from public, anon, authenticated;
grant  execute on function public.prune_site_visits(int)       to service_role;
