-- 0149 rollback: drop the quota ledger, its function and the two upload-safety
-- columns. The worker notices at its next write: it writes publication rows
-- without the columns (the adopt check then never fires, as before 0149) and
-- logs once that the ledger cannot be written.
begin;
drop function if exists public.youtube_quota_add(date, text, text, integer, integer);
drop table if exists public.youtube_quota_ledger;
alter table public.topic_publications
  drop column if exists upload_token,
  drop column if exists upload_started_at;
commit;
