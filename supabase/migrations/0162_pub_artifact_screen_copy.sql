-- 0162: a screen copy for a large book file (founder 2026-10-28: "very slow" —
-- a full manuscript PDF is ~100 MB). The full file stays the download; the
-- screen copy (images at 150 dpi, ~15 MB) is what opens in the browser.
-- Additive and idempotent: two nullable columns, no data change.
alter table public.pub_artifacts add column if not exists screen_key text;
alter table public.pub_artifacts add column if not exists screen_bytes bigint;
