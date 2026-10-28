-- 0161 rollback: remove the book app's store.
--
-- ⚠️ This DELETES every imported book record (revisions, approvals, runs,
-- findings, the file index). The files themselves stay in S3, and the engine's
-- book folders stay on disk, so a re-import restores the records.
begin;
drop table if exists public.pub_members;
drop table if exists public.pub_open_items;
drop table if exists public.pub_cost_lines;
drop table if exists public.pub_annotations;
drop table if exists public.pub_artifacts;
drop table if exists public.pub_findings;
drop table if exists public.pub_runs;
drop table if exists public.pub_approvals;
drop table if exists public.pub_stages;
drop table if exists public.pub_chapter_revisions;
drop table if exists public.pub_book_revisions;
drop table if exists public.pub_works;
drop function if exists public.pub_refuse_change();
commit;
