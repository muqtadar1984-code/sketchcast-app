-- 0173 rollback: remove SK S6 slice A's sweep, consent RPC, audit trigger and
-- the two fact stores. Consent rows the RPC wrote stay in `consents` (0158
-- owns that table); the facts themselves are dropped with their tables.
begin;
drop function if exists public.sk_memory_sweep();
drop trigger if exists sk_actions_clear_params_on_profile_delete on public.profiles;
drop function if exists public.sk_actions_clear_params_on_profile_delete();
drop function if exists public.sk_set_consent(uuid, text, boolean);
drop table if exists public.sk_learning_facts;
drop table if exists public.sk_workflow_facts;
commit;
