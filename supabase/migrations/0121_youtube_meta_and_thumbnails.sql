-- 0121_youtube_meta_and_thumbnails
--
-- The library reviews EVERYTHING that goes to YouTube before Post (founder,
-- 2026-09-21): the video, the title, the description, the thumbnail. Two
-- additions make that possible; nothing else changes.
--
--   1. topic_kits.youtube_meta (jsonb, nullable) — the WORDS of the YouTube
--      listing: {title, intro, key_terms[], hashtags[], source
--      'generated'|'edited', generated_at?, edited_at?, edited_by?}. Written
--      by the worker when the video finishes (sketchcast-ai
--      catalogue/youtube_meta.py, one model call over the narration), shown
--      and EDITED in the library's publish block (the kit route's
--      save_youtube action), read by the publish job. Every field optional:
--      the title, description and tags are COMPOSED from a fixed structure
--      (mirrored in src/utils/catalogue/publish.ts and the worker), and a
--      missing field takes its deterministic default — a video is never
--      held up by a paragraph. A regenerated kit is a new row, so its words
--      are written afresh.
--   2. artifact_kind 'thumbnail_png' — the 1280x720 card the worker draws
--      when each video part finishes, stored beside the mp4
--      (thumb.png / thumb_part2.png …) so the library shows the card that
--      will go up and the publish uploads that same file. Enum values cannot
--      be added inside the transaction that uses them; this migration only
--      adds the value.
--
-- No RLS change: topic_kits already carries the catalogue's policies and the
-- column is written by the service role (the worker and the routes).

alter table public.topic_kits add column if not exists youtube_meta jsonb;
comment on column public.topic_kits.youtube_meta is
  'YouTube listing words (0121): {title, intro, key_terms[], hashtags[], source, generated_at?, edited_at?, edited_by?}. Composed into the title/description by the worker and previewed identically in the library; every field optional.';

alter type public.artifact_kind add value if not exists 'thumbnail_png';
