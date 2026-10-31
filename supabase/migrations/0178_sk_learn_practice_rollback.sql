-- 0178 rollback: remove worksheet practice on the student Board. Drops the
-- practice attempts (educational records — export them first if any exist),
-- the sessions they belong to, and the model-written help cache. Nothing else
-- references these tables.
begin;
drop table if exists public.sk_practice_attempts;
drop table if exists public.sk_practice_sessions;
drop table if exists public.sk_practice_help;
commit;
