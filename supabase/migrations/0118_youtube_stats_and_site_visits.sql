-- 0118 — two trackers for the staff console: YouTube statistics and site visits.
--
-- WHY. The catalogue now publishes kit videos to the channel (0116) and the
-- founder is posting them; the first question after "is it live?" is "is
-- anyone watching?", and the second is "is anyone visiting the site?". Both
-- answers lived in other people's dashboards (YouTube Studio, Vercel
-- Analytics, Cloudflare) — one tab and one login each, and none of them
-- beside the kit's own row or the signup funnel the console already shows.
--
-- HOW.
--   * youtube_video_stats / youtube_channel_stats — SNAPSHOTS, one row per
--     video (and one per channel) per poll, written by the WORKER
--     (sketchcast-ai catalogue/youtube_stats.py, hourly by default) with the
--     channel credentials that live only in its environment. Nothing here
--     computes a daily figure: a day's views is the difference between two
--     snapshots, and the console does that arithmetic (utils/youtube-stats.ts)
--     so the stored numbers are always exactly what YouTube said.
--   * site_visits — one row per page view, written by the app's own beacon
--     endpoint (/api/public/visit) from both sites: the marketing site posts
--     cross-origin, the app posts same-origin. COOKIELESS BY CONSTRUCTION:
--     no cookie is set and no IP address is stored. `visitor` is a hash of
--     the address, the user agent and a salt that rotates DAILY, so the
--     console can count unique visitors within a day and nobody can follow
--     one visitor across days, from this table or any other. The path is
--     stored without its query string; the referrer as its HOST only —
--     the same rule the marketing site's hand-off already follows.
--   * three read functions the console calls (service role only): a daily
--     series per host, a breakdown by path / referrer / country since a
--     moment, and a per-minute series for the live ticker — SQL, so a
--     month of visits is one round trip rather than a table pulled into
--     JavaScript.
--
-- Every table: RLS on with no policies, client grants revoked. Nothing here
-- is ever read by a signed-in teacher; the console reads with the service
-- role and the beacon writes with it.
--
-- RETENTION. site_visits is a firehose; the console reads at most 90 days.
-- prune_site_visits(p_days) deletes older rows and is meant for a scheduled
-- call (not scheduled by this migration — pg_cron is not enabled on this
-- project; a Vercel cron or a manual call from the SQL editor does it).

-- ── YouTube ──────────────────────────────────────────────────────────────────

create table if not exists public.youtube_video_stats (
  id                bigserial primary key,
  video_id          text not null,
  channel_language  text not null default 'en',
  captured_at       timestamptz not null default now(),
  title             text,
  privacy           text,
  published_at      timestamptz,
  views             bigint,
  likes             bigint,
  comments          bigint
);
create index if not exists youtube_video_stats_video_idx
  on public.youtube_video_stats (video_id, captured_at desc);
create index if not exists youtube_video_stats_captured_idx
  on public.youtube_video_stats (captured_at desc);
alter table public.youtube_video_stats enable row level security;
revoke all on public.youtube_video_stats from public, anon, authenticated;

create table if not exists public.youtube_channel_stats (
  id                bigserial primary key,
  channel_id        text not null,
  channel_language  text not null default 'en',
  captured_at       timestamptz not null default now(),
  title             text,
  subscribers       bigint,
  views             bigint,
  videos            bigint
);
create index if not exists youtube_channel_stats_captured_idx
  on public.youtube_channel_stats (channel_id, captured_at desc);
alter table public.youtube_channel_stats enable row level security;
revoke all on public.youtube_channel_stats from public, anon, authenticated;

comment on table public.youtube_video_stats is
  'Snapshots of YouTube Data API statistics per published video (0118). Written by the worker poll; read by the console.';
comment on table public.youtube_channel_stats is
  'Snapshots of the channel''s own statistics (0118). Written by the worker poll; read by the console.';

-- ── Site visits ──────────────────────────────────────────────────────────────

create table if not exists public.site_visits (
  id        bigserial primary key,
  at        timestamptz not null default now(),
  host      text not null,
  path      text not null,
  ref_host  text,
  country   text,
  -- sha256(daily salt | address | user agent), 32 hex chars. Rotates daily.
  visitor   text not null,
  device    text not null default 'desktop' check (device in ('desktop', 'mobile'))
);
create index if not exists site_visits_at_idx on public.site_visits (at desc);
create index if not exists site_visits_host_at_idx on public.site_visits (host, at desc);
alter table public.site_visits enable row level security;
revoke all on public.site_visits from public, anon, authenticated;

comment on table public.site_visits is
  'One row per page view from the marketing site and the app (0118). Cookieless; no IP stored; visitor hash rotates daily.';

-- ── Console reads ────────────────────────────────────────────────────────────

create or replace function public.site_visits_daily(p_days int default 30)
returns table (day date, host text, visits bigint, visitors bigint)
language sql stable security definer set search_path = public as $$
  select (at at time zone 'UTC')::date as day, host,
         count(*) as visits, count(distinct visitor) as visitors
    from public.site_visits
   where at >= (now() at time zone 'UTC')::date - make_interval(days => greatest(1, least(p_days, 366)) - 1)
   group by 1, 2
   order by 1, 2
$$;

-- `p_hosts` narrows a breakdown or the live strip to some hosts (the console
-- passes the website's); null means every host.
create or replace function public.site_visits_breakdown(p_since timestamptz, p_dimension text, p_limit int default 12,
                                                        p_hosts text[] default null)
returns table (key text, visits bigint, visitors bigint)
language plpgsql stable security definer set search_path = public as $$
begin
  if p_dimension not in ('path', 'ref_host', 'country', 'host') then
    raise exception 'unknown dimension %', p_dimension using errcode = 'check_violation';
  end if;
  return query execute format(
    'select coalesce(%I, ''(none)'')::text as key, count(*) as visits, count(distinct visitor) as visitors
       from public.site_visits
      where at >= $1 and ($3::text[] is null or host = any($3))
      group by 1
      order by 2 desc, 1
      limit $2', p_dimension)
    using p_since, greatest(1, least(p_limit, 100)), p_hosts;
end $$;

create or replace function public.site_visits_live(p_minutes int default 60, p_hosts text[] default null)
returns table (minute timestamptz, visits bigint, visitors bigint)
language sql stable security definer set search_path = public as $$
  select date_trunc('minute', at) as minute, count(*) as visits, count(distinct visitor) as visitors
    from public.site_visits
   where at >= now() - make_interval(mins => greatest(1, least(p_minutes, 1440)))
     and (p_hosts is null or host = any(p_hosts))
   group by 1
   order by 1
$$;

create or replace function public.prune_site_visits(p_days int default 400)
returns bigint
language plpgsql security definer set search_path = public as $$
declare n bigint;
begin
  delete from public.site_visits where at < now() - make_interval(days => greatest(30, p_days));
  get diagnostics n = row_count;
  return n;
end $$;

revoke execute on function public.site_visits_daily(int)                          from public, anon, authenticated;
revoke execute on function public.site_visits_breakdown(timestamptz, text, int, text[])  from public, anon, authenticated;
revoke execute on function public.site_visits_live(int, text[])                   from public, anon, authenticated;
revoke execute on function public.prune_site_visits(int)                          from public, anon, authenticated;
grant  execute on function public.site_visits_daily(int)                          to service_role;
grant  execute on function public.site_visits_breakdown(timestamptz, text, int, text[])  to service_role;
grant  execute on function public.site_visits_live(int, text[])                   to service_role;
grant  execute on function public.prune_site_visits(int)                          to service_role;
