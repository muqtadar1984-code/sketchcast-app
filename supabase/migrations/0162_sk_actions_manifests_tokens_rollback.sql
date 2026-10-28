-- 0162 rollback: remove SK's audit, token and manifest tables.
--
-- ⚠️ This DELETES the SK action audit trail, every outstanding action token
-- and every cached Kit Manifest. Manifests are re-derivable from the kit
-- artifacts; the audit rows are not recoverable.
begin;
drop trigger if exists sk_manifest_invalidate_on_artifacts on public.artifacts;
drop function if exists public.sk_manifest_invalidate();
drop function if exists public.sk_consume_action_token(uuid, text);
alter table if exists public.sk_actions drop constraint if exists sk_actions_token_fk;
drop table if exists public.sk_manifests;
drop table if exists public.sk_action_tokens;
drop table if exists public.sk_actions;
commit;
