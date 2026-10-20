-- 0148 rollback: drop the three YouTube status columns. The worker notices
-- they are gone at its next start and keeps the privacy sync alone; the
-- Library's YouTube view falls back to inferring removal from the poll.
alter table public.topic_publications
  drop column if exists youtube_publish_at,
  drop column if exists youtube_upload_status,
  drop column if exists youtube_missing_since;
