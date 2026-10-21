-- 0151 rollback: drop the Fix Agent's cases, its enqueue function and its
-- setting. The worker's agent logs once that its table is gone and does
-- nothing; a retry job it already queued finishes as an ordinary
-- kit_translate (its fix_note/waivers params are read by the job itself).
begin;
drop function if exists public.fix_case_enqueue(uuid);
drop table if exists public.fix_cases;
delete from public.platform_settings where key = 'fix_agent';
commit;
