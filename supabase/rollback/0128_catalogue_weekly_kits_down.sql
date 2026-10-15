-- Rollback for 0128_catalogue_weekly_kits.sql.
--
-- Drops exactly what 0128 created and nothing else. Every pre-existing table,
-- column, row, function and trigger is untouched.
--
-- DATA LOSS: this removes catalogue_unlocks (users lose their unlocked
-- topics), catalogue_events, topic_slug_redirects and topics.slug. Before Phase C
-- goes live these hold nothing user-facing. AFTER launch, export
-- catalogue_unlocks first. Run inside a transaction:
--   begin; \i 0128_catalogue_weekly_kits_down.sql; commit;
-- Re-applying 0128 afterwards is safe: it is idempotent and re-backfills slugs.

drop function if exists public.my_catalogue_allowance();
drop function if exists public.unlock_catalogue_kit(uuid);
drop function if exists public.catalogue_has_access(uuid);
drop function if exists public.catalogue_ineligible_reason(uuid);
drop function if exists public.catalogue_week_start(timestamptz);
drop function if exists public.catalogue_weekly_cap(text);
drop function if exists public.public_catalogue_redirects();
drop function if exists public.public_catalogue();
drop function if exists public.catalogue_current_kits();

drop table if exists public.catalogue_events;
drop table if exists public.catalogue_unlocks;

drop trigger if exists topics_slug_maintain on public.topics;
drop function if exists public.topics_slug_maintain();
drop table if exists public.topic_slug_redirects;
alter table public.topics drop constraint if exists topics_slug_format;
drop index if exists public.topics_slug_key;
alter table public.topics drop column if exists slug;
drop function if exists public.catalogue_slugify(text);
