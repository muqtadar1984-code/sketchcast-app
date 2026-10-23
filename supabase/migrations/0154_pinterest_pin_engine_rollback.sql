-- 0154 rollback: drop the Pinterest Pin Engine's tables, job indexes, bucket
-- and settings row. The worker's agent logs once that its tables are gone and
-- does nothing. Pins already posted stay on Pinterest; delete them there if
-- wanted. The bucket is dropped only when empty (storage keeps objects).
begin;
drop index if exists public.jobs_one_live_pin_post;
drop index if exists public.jobs_one_live_pin_draft;
drop table if exists public.pinterest_pin_stats;
drop table if exists public.pinterest_pins;
drop table if exists public.pinterest_publish_rounds;
drop table if exists public.pinterest_boards;
drop table if exists public.pinterest_oauth;
delete from storage.buckets
  where id = 'pinterest-pins'
    and not exists (select 1 from storage.objects where bucket_id = 'pinterest-pins');
delete from public.platform_settings where key = 'pinterest_agent';
commit;
