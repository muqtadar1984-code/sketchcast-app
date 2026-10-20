-- SketchCast AI — 0148: the YouTube states privacy cannot say
-- ============================================================================
-- Translated Videos YouTube Tab plan, phase Y2 (2026-10-20). The worker's
-- hourly stats poll (sketchcast-ai catalogue/youtube_stats.py) already copies
-- YouTube's privacyStatus onto topic_publications.privacy. Three things it
-- could not record:
--   • a video SCHEDULED to go public reads 'private' until its time;
--   • a video YouTube REJECTED or failed to process reads as uploaded;
--   • a video DELETED on YouTube is simply missing from the reply, and its
--     row kept saying public.
-- Three nullable columns, written by the worker ONLY when they change (a
-- quiet hour writes nothing); read by the Library's YouTube view
-- (/library/translations/youtube). No backfill: the next poll fills them.
-- The worker detects a database without them and keeps the privacy sync
-- alone, so this may be applied before or after the worker deploy.
-- topic_publications keeps RLS on with no policies (service role only).
-- ============================================================================

alter table public.topic_publications
  add column if not exists youtube_publish_at    timestamptz,
  add column if not exists youtube_upload_status text,
  add column if not exists youtube_missing_since timestamptz;

comment on column public.topic_publications.youtube_publish_at is
  'YouTube status.publishAt — the time a private (scheduled) video goes public; null when none (0148, written by the stats poll).';
comment on column public.topic_publications.youtube_upload_status is
  'YouTube status.uploadStatus (uploaded, processed, failed, rejected, deleted), with the reason after a colon for rejected/failed (e.g. rejected:duplicate) (0148).';
comment on column public.topic_publications.youtube_missing_since is
  'First poll at which a successful videos.list did not list this video (deleted or removed on YouTube); cleared when it is listed again (0148).';
