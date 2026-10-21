-- 0150 rollback: drop the publish agent's queue and rounds. The worker's
-- agent logs once that its tables are gone and does nothing; jobs it already
-- queued finish as ordinary topic_publish jobs.
begin;
drop table if exists public.youtube_publish_queue;
drop table if exists public.youtube_publish_rounds;
commit;
