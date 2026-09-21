-- 0120 — website traffic from Cloudflare, replacing the beacon of 0118/0119.
--
-- WHY. sketchcast.app is served by Cloudflare, which already counts every
-- request at the edge: page views, an estimate of unique visitors, bytes,
-- threats and countries, per day, with history as far back as the plan
-- keeps. The founder chose that over our own beacon (2026-09-21: "Let's
-- just read Cloudflare's analytics instead") — nothing in the page, nothing
-- for a script blocker to miss, and a past instead of a start date.
--
-- HOW. The WORKER (sketchcast-ai catalogue/cloudflare_stats.py) asks
-- Cloudflare's GraphQL Analytics API hourly with a token that lives only in
-- its environment, and UPSERTS one row per (zone, day) here. Today's row is
-- refreshed every poll until the day ends. The console reads the table and
-- does the arithmetic (utils/cloudflare-stats.ts); nothing in the app calls
-- Cloudflare.
--
-- THE NUMBERS ARE CLOUDFLARE'S: requests include assets and crawlers,
-- page_views are HTML responses (null for a day loaded from a dashboard
-- export, which carries none — the poll fills it in), uniques is a per-day estimate by address,
-- countries is [{country, requests}] for the day's top entries. Bots are not
-- separated (no bot score on the free plan).
--
-- The beacon's tables and functions (site_visits, site_visits_archive and
-- their read/prune functions) are dropped — both were empty, the endpoint
-- and the marketing site's script are removed in the same change, and two
-- sources for one number is one too many.
--
-- Service role only: RLS on with no policies, client grants revoked.

create table if not exists public.cloudflare_daily_stats (
  zone         text        not null,
  day          date        not null,
  requests     bigint      not null default 0,
  page_views   bigint,               -- null when unknown (a dashboard export has none)
  uniques      bigint      not null default 0,
  bytes        bigint,
  threats      bigint,
  countries    jsonb       not null default '[]'::jsonb,
  captured_at  timestamptz not null default now(),
  primary key (zone, day)
);
alter table public.cloudflare_daily_stats enable row level security;
revoke all on public.cloudflare_daily_stats from public, anon, authenticated;
comment on table public.cloudflare_daily_stats is
  'Cloudflare''s daily zone analytics for the website (0120): one row per zone and day, upserted hourly by the worker. Read by the console.';

drop function if exists public.site_visits_daily(int);
drop function if exists public.site_visits_breakdown(timestamptz, text, int, text[]);
drop function if exists public.site_visits_live(int, text[]);
drop function if exists public.site_visits_lifetime(text[]);
drop function if exists public.prune_site_visits(int);
drop table if exists public.site_visits_archive;
drop table if exists public.site_visits;
