-- 0114_article_jobs
--
-- Phase 2b of the topic-catalogue plan (founder, 2026-09-06): the knowledge
-- article. Two new observer jobs carry their input in jobs.params (0113):
--   topic_article  {topic_id, language, hints?}  — writes a topic_articles
--                  draft (next version) and its article_figures specs
--   figure_render  {article_id}                  — renders that article's
--                  figures through the visual library (SVG first, then the
--                  raster path) and links visual_asset_id
-- One live job of each kind per target, enforced like topic_derive (0113) and
-- topic_harvest (0112): check-then-insert in the portal is racy on its own.
--
-- article_figures gains a render_error so a failed figure explains itself on
-- the editor instead of sitting at 'draft' forever.
--
-- No other change: the article and figure tables, the one-approved-per-
-- (topic, language) index and approve_topic_article() all shipped in 0112.
--
-- Applied to prod by the agent on the founder's explicit 2026-09-06 instruction.

begin;

create unique index if not exists jobs_one_live_article
  on public.jobs ((params->>'topic_id'), (coalesce(params->>'language', 'en')))
  where type = 'topic_article' and status in ('queued', 'processing');

create unique index if not exists jobs_one_live_figure_render
  on public.jobs ((params->>'article_id'))
  where type = 'figure_render' and status in ('queued', 'processing');

alter table public.article_figures add column if not exists render_error text;

commit;
