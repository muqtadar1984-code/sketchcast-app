-- 0162 rollback: drop the screen-copy columns (the screen objects stay in S3).
alter table public.pub_artifacts drop column if exists screen_bytes;
alter table public.pub_artifacts drop column if exists screen_key;
