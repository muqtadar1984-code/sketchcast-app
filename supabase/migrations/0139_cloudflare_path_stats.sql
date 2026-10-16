-- 0139: Cloudflare page views PER PATH — the catalogue funnel's first step.
-- Catalogue plan §5.5 (2026-10-16). Founder decision: extend our own
-- collector rather than add a browser beacon.
--
-- 0120's cloudflare_daily_stats holds the zone's totals and cannot say how
-- many people read ONE lesson page. The worker's hourly poll
-- (catalogue/cloudflare_stats.py) now also asks Cloudflare's adaptive HTTP
-- dataset for HTML requests by path and writes one row per (zone, day, path):
--   requests — HTML requests for the path that day (sampled on busy days);
--   visits   — Cloudflare's own count of requests whose referrer is not this
--              zone, i.e. page views that began elsewhere (search, YouTube,
--              a forward) — the closest thing to "people who came to read
--              this lesson".
-- Paths are normalised by the worker (lower-case, no .html, no trailing
-- slash) so a page is one row however it was requested. No query strings,
-- nothing personal.
--
-- Service role only, like 0120: RLS on with no policies, client grants
-- revoked. Read by Console → Traffic ("Lesson pages") and Console → Catalogue.

create table if not exists public.cloudflare_path_stats (
  zone         text        not null,
  day          date        not null,
  path         text        not null,
  requests     bigint      not null default 0,
  visits       bigint      not null default 0,
  captured_at  timestamptz not null default now(),
  primary key (zone, day, path)
);
create index if not exists cloudflare_path_stats_path_day on public.cloudflare_path_stats (zone, path, day desc);
alter table public.cloudflare_path_stats enable row level security;
revoke all on public.cloudflare_path_stats from public, anon, authenticated;
comment on table public.cloudflare_path_stats is
  'Cloudflare''s HTML requests and visits per (zone, day, path) (0139): upserted hourly by the worker from httpRequestsAdaptiveGroups; paths normalised; read by the console. The catalogue funnel''s first step.';
