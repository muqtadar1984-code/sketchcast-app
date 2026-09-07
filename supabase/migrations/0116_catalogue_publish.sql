-- 0116_catalogue_publish
--
-- Phase 4 of the topic-catalogue plan (founder, 2026-09-06): publishing an
-- APPROVED kit to YouTube. Publishing is a JOB, not a write: the portal route
-- enqueues one `topic_publish` observer job (generation_id and book_id NULL,
-- its input in jobs.params — 0113) and the worker uploads every video part in
-- order, writing one topic_publications row per (kit, part, language).
--
-- The whole phase ships DARK behind FEATURE_CATALOGUE_PUBLISH: the founder has
-- not created the channel, the API project has not passed the YouTube
-- compliance audit, and the OAuth consent has not been run. Every credential
-- is read from the worker's environment and NEVER stored here — that is why
-- this migration adds no table for tokens and no column for one.
--
-- WHAT IT DOES, AND WHY
--   1. jobs_one_live_publish — one live `topic_publish` job per KIT. Shaped
--      exactly like 0112's harvest, 0113's derive, 0114's article /
--      figure_render and 0115's questions indexes, and for the same reason:
--      the route's check-then-insert is racy on its own, and here the race is
--      expensive in a way the others are not — two concurrent publish jobs for
--      one kit would upload the SAME part twice to a channel with a ~100
--      uploads/day quota, and a duplicate video on a public channel cannot be
--      taken back quietly. The route pre-checks with the same key
--      (params->>'kit_id') and maps the 23505 to a 409 that names the live job.
--      Keyed on the kit alone, not (kit, language): a kit IS one language
--      (topic_kits.language), and each language has its own channel and its own
--      kit, so the kit id already separates them.
--
-- WHAT IT DOES NOT DO, AND WHY
--   • topic_publications gains NOTHING. 0112's shape already records
--     everything the worker's summary needs per part — youtube_video_id,
--     privacy, playlist_ids, captions_uploaded, thumbnail_set, published_at,
--     error — with unique (topic_kit_id, part, channel_language) as the
--     idempotency key: a part that already holds a youtube_video_id is skipped
--     on a re-run, so a publish interrupted by the per-run cap
--     (YOUTUBE_MAX_PARTS_PER_RUN) or a network failure is FINISHED by the next
--     run instead of double-uploading. Nothing about the per-run cap belongs in
--     a column: what was left over is a fact about one run, and it travels in
--     the job's summary.
--   • No publish_topic_kit() RPC. Gate 2 is topic_kits.status = 'approved',
--     which 0115's approve_topic_kit() already owns and is the ONLY writer of;
--     publishing adds no new status to write, so there is nothing for a
--     SECURITY DEFINER function to make atomic. The rule is enforced TWICE
--     instead (plan §1.3): the route re-checks the kit's status, the topic's
--     status, the kit's article and the topic's bank_maturity before it
--     enqueues, and the WORKER re-checks the same before any network call.
--   • No credential storage, no policy, no table, no enum change, no change to
--     existing rows.
--
-- ROLLBACK: drop index jobs_one_live_publish;

begin;

-- ── 1. One live publish job per kit ──────────────────────────────────────────
create unique index if not exists jobs_one_live_publish
  on public.jobs ((params->>'kit_id'))
  where type = 'topic_publish' and status in ('queued', 'processing');

commit;
