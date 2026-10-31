-- 0177 rollback: remove the SK gap tracker. The rows are SK's own observations
-- of its turns; nothing else references them (platform_issues tickets that a
-- theme became are kept).
begin;
drop table if exists public.sk_gaps;
drop table if exists public.sk_gap_themes;
commit;
